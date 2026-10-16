import { Inject, Injectable } from "@nestjs/common";
import type { PrintJobStatus } from "@omniseller/shared";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { DomainError } from "../../common/errors/domain-errors";
import type { DbHandle, Tx } from "../../db/client";
import type { ReportedPrinter } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { type AgentPrintJob, REALTIME, type Realtime } from "../../realtime/realtime";
import { type DownloadTarget, FilesService } from "../files/files.service";
import type { DeviceRow } from "../identity/devices.repository";
import { DevicesService } from "../identity/devices.service";
import {
  documentNotFound,
  documentNotPrintable,
  printAgentInvalid,
  printAttemptStale,
  printFileExpired,
  printJobNotFound,
  printJobNotPending,
  printJobNotReady,
  printJobNotRetryable,
  printPrinterInvalid,
} from "./fulfillment.errors";
import { type DocumentRow, FulfillmentRepository } from "./fulfillment.repository";
import { type PrintJobRow, PrintRepository } from "./print.repository";
import { PRINT_KIND, paperOf, printerFor, printTitle } from "./scan-plan";

/** Jobs an agent gets per listing; it asks again after printing them. */
export const AGENT_PENDING_LIMIT = 50;

/** Where a print request sends the document: an agent, optionally a printer, and copies. */
export interface PrintTarget {
  deviceId: string;
  printer?: string | null | undefined;
  copies?: number | undefined;
}

export const agentJobView = (j: PrintJobRow): AgentPrintJob => ({
  id: j.id,
  attempt: j.status === "queued" ? j.attempts + 1 : j.attempts,
  kind: j.kind,
  title: j.title,
  printer: j.printerName,
  copies: j.copies,
  createdAt: j.createdAt.toISOString(),
});

/** Users limited to some stores or warehouses see their own print requests only (as documents). */
const scoped = (ctx: RequestContext) => ctx.storeScope !== null || ctx.warehouseScope !== null;

const inWarehouses = (ctx: RequestContext, warehouseId: string | null) =>
  ctx.warehouseScope === null || warehouseId === null || ctx.warehouseScope.has(warehouseId);

/**
 * Print jobs for the local print agent (PRD FR-SHP-17, backend doc 8.24, technology doc 12). A job prints
 * one document: it waits for the worker to render it, then the agent hears `print.job` over Socket.IO
 * (or finds it in its pending list), downloads the file (`sent`), prints, and reports `printed` or
 * `failed`. Pushes happen after the transaction that made the job ready commits.
 */
@Injectable()
export class PrintService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(PrintRepository) private readonly repo: PrintRepository,
    @Inject(FulfillmentRepository) private readonly fulfillment: FulfillmentRepository,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(REALTIME) private readonly realtime: Realtime,
  ) {}

  // ---- the business's side (api) ----

  /** A print agent the caller may print on: not revoked, and serving the caller's warehouses. */
  async agentIn(tx: Tx, ctx: RequestContext, deviceId: string, path = "print.deviceId"): Promise<DeviceRow> {
    const d = await this.devices.getIn(tx, deviceId);
    if (d?.kind !== "print_agent" || d.revokedAt || !inWarehouses(ctx, d.warehouseId)) {
      throw printAgentInvalid(path);
    }
    return d;
  }

  /**
   * A job printing this document on the agent, in the caller's transaction. A document still being
   * rendered gets its file from the worker; a failed one, or one whose file expired, is refused.
   */
  async queueIn(
    tx: Tx,
    ctx: RequestContext,
    doc: DocumentRow,
    target: PrintTarget,
    title: string,
    path = "print.deviceId",
  ): Promise<PrintJobRow> {
    if (doc.status === "failed" || (doc.status === "ready" && !doc.fileObjectId)) throw documentNotPrintable();
    const device = await this.agentIn(tx, ctx, target.deviceId, path);
    return this.repo.insert(tx, {
      id: newId(),
      tenantId: ctx.tenantId,
      deviceId: device.id,
      kind: PRINT_KIND[doc.kind],
      documentId: doc.id,
      fileObjectId: doc.status === "ready" ? doc.fileObjectId : null,
      printerName: printerFor(target.printer, paperOf(doc.kind, doc.params), device),
      copies: target.copies ?? 1,
      title,
      requestedBy: ctx.actor.type === "user" ? ctx.actor.id : null,
    });
  }

  /** Tells the agents about jobs that have their file and wait (call after the commit). */
  push(jobs: (PrintJobRow | null | undefined)[]): void {
    for (const j of jobs) {
      if (j?.status === "queued" && j.fileObjectId) this.realtime.toDevice(j.deviceId, "print.job", agentJobView(j));
    }
  }

  /** `POST /v1/print-jobs`: prints a document (again) on an agent. */
  async printDocument(ctx: RequestContext, documentId: string, target: PrintTarget) {
    const job = await withTenantTx(this.db, ctx, async (tx) => {
      const doc = await this.fulfillment.getDocument(tx, documentId);
      if (!doc || (scoped(ctx) && doc.requestedBy !== ctx.actor.id)) throw documentNotFound();
      return this.queueIn(tx, ctx, doc, target, printTitle(doc.kind, doc.params), "deviceId");
    });
    this.push([job]);
    return job;
  }

  /**
   * The print queue (UI L07), newest first. Users limited to some stores or warehouses see their own
   * requests and the system's jobs (automatic rules) on agents serving a warehouse in their scope.
   */
  async list(
    ctx: RequestContext,
    f: { deviceId?: string | undefined; status?: PrintJobStatus | undefined },
    before: string | undefined,
    limit: number,
  ): Promise<{ items: PrintJobRow[]; more: boolean }> {
    const rows = await withTenantTx(this.db, ctx, (tx) =>
      this.repo.page(
        tx,
        {
          ...f,
          ...(scoped(ctx)
            ? { visibleTo: { userId: ctx.actor.id, warehouseIds: ctx.warehouseScope ? [...ctx.warehouseScope] : null } }
            : {}),
        },
        before,
        limit,
      ),
    );
    return { items: rows.slice(0, limit), more: rows.length > limit };
  }

  async get(ctx: RequestContext, id: string): Promise<PrintJobRow> {
    return withTenantTx(this.db, ctx, (tx) => this.visibleIn(tx, ctx, id));
  }

  /** The newest print job of each document (shown with the document). */
  latestOfDocumentsIn(tx: Tx, documentIds: string[]): Promise<Map<string, PrintJobRow>> {
    return this.repo.latestOfDocuments(tx, documentIds);
  }

  private async visibleIn(tx: Tx, ctx: RequestContext, id: string, lock = false): Promise<PrintJobRow> {
    const j = await this.repo.get(tx, id, lock);
    if (!j) throw printJobNotFound();
    if (ctx.actor.type === "device" && j.deviceId !== ctx.actor.id) throw printJobNotFound();
    if (scoped(ctx) && j.requestedBy !== ctx.actor.id) {
      // the system's job: visible when its agent serves a warehouse the caller may see
      const d = j.requestedBy === null ? await this.devices.getIn(tx, j.deviceId) : undefined;
      if (!d || !inWarehouses(ctx, d.warehouseId)) throw printJobNotFound();
    }
    return j;
  }

  /**
   * "Cetak ulang" of a failed job, or of one the agent took and never reported: queued again, and the
   * agent hears about it. A job whose file expired cannot be repeated (its document can be made again).
   */
  async retry(ctx: RequestContext, id: string): Promise<PrintJobRow> {
    const job = await withTenantTx(this.db, ctx, async (tx) => {
      const j = await this.visibleIn(tx, ctx, id, true);
      if (j.status !== "failed" && j.status !== "sent") throw printJobNotRetryable();
      if (!j.fileObjectId) throw printFileExpired();
      await this.agentIn(tx, ctx, j.deviceId, "deviceId");
      return this.repo.update(tx, j.id, { status: "queued", error: null });
    });
    this.push([job]);
    return job;
  }

  /** Cancels a job that has not printed; the agent drops it if it still holds it. */
  async cancel(ctx: RequestContext, id: string): Promise<PrintJobRow> {
    const job = await withTenantTx(this.db, ctx, async (tx) => {
      const j = await this.visibleIn(tx, ctx, id, true);
      if (j.status === "printed" || j.status === "cancelled") throw printJobNotPending();
      return this.repo.update(tx, j.id, { status: "cancelled" });
    });
    this.realtime.toDevice(job.deviceId, "print.cancelled", { id: job.id });
    return job;
  }

  /** A revoked agent's open jobs are cancelled in the caller's transaction (the agent cannot sign in). */
  async cancelForDeviceIn(tx: Tx, deviceId: string): Promise<number> {
    const open = await this.repo.openFor(tx, deviceId);
    for (const j of open) {
      await this.repo.update(tx, j.id, { status: "cancelled", error: "Agen cetak dicabut." });
    }
    return open.length;
  }

  // ---- the worker ----

  /**
   * The document is done (worker, in its transaction): jobs waiting for it get the file, or fail with the
   * document's reason. Returns the jobs to push once the transaction commits.
   */
  async documentFinishedIn(
    tx: Tx,
    doc: { id: string; status: DocumentRow["status"]; fileObjectId: string | null; error: string | null },
  ): Promise<PrintJobRow[]> {
    const out: PrintJobRow[] = [];
    for (const j of await this.repo.waitingFor(tx, doc.id)) {
      out.push(
        doc.status === "ready" && doc.fileObjectId
          ? await this.repo.update(tx, j.id, { fileObjectId: doc.fileObjectId })
          : await this.repo.update(tx, j.id, { status: "failed", error: doc.error ?? "Dokumen gagal dibuat." }),
      );
    }
    return out;
  }

  // ---- the agent (device context) ----

  /** What the agent still has to print: queued with a file, or taken and not reported; oldest first. */
  async pending(ctx: RequestContext): Promise<PrintJobRow[]> {
    return withTenantTx(this.db, ctx, (tx) => this.repo.pendingFor(tx, ctx.actor.id, AGENT_PENDING_LIMIT));
  }

  /**
   * The agent takes the file: the job is `sent` (taken again after a restart, it stays so). A file
   * that expired fails the job.
   */
  async take(ctx: RequestContext, id: string, attempt?: number): Promise<DownloadTarget> {
    const job = await withTenantTx(this.db, ctx, async (tx) => {
      const j = await this.repo.get(tx, id, true);
      if (j?.deviceId !== ctx.actor.id) throw printJobNotFound();
      if (j.status !== "queued" && j.status !== "sent") throw printJobNotPending();
      if (attempt !== undefined && attempt !== agentJobView(j).attempt) throw printAttemptStale();
      if (!j.fileObjectId) {
        if (j.documentId) throw printJobNotReady();
        throw printFileExpired();
      }
      if (j.status === "sent") return j;
      return this.repo.update(tx, j.id, { status: "sent", sentAt: new Date(), attempts: j.attempts + 1 });
    });
    try {
      return await this.files.download(ctx, job.fileObjectId!, ["label", "pick_list"], {
        filename: `cetak-${job.id.toLowerCase()}.pdf`,
      });
    } catch (err) {
      // the file expired under the job; a storage outage leaves it for the agent to try again
      if (err instanceof DomainError && err.code === "file.not_found") {
        await withTenantTx(this.db, ctx, (tx) =>
          this.repo.update(tx, job.id, { status: "failed", error: "Berkas cetak sudah tidak tersimpan." }),
        );
      }
      throw err;
    }
  }

  /** The agent's report. Reporting the same result again changes nothing. */
  async report(
    ctx: RequestContext,
    id: string,
    result: { status: "printed" | "failed"; error?: string | undefined; attempt?: number },
  ): Promise<PrintJobRow> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const j = await this.repo.get(tx, id, true);
      if (j?.deviceId !== ctx.actor.id) throw printJobNotFound();
      if (result.attempt !== undefined && (result.attempt !== j.attempts || j.status === "queued"))
        throw printAttemptStale();
      if (j.status === result.status) return j;
      if (j.status !== "sent") throw printJobNotPending();
      return this.repo.update(
        tx,
        j.id,
        result.status === "printed"
          ? { status: "printed", printedAt: new Date(), error: null }
          : { status: "failed", error: result.error?.trim() || "Printer gagal mencetak." },
      );
    });
  }

  /** The agent's status report (`PUT /v1/agent/status`): its version and printers. */
  async agentStatus(
    ctx: RequestContext,
    report: {
      appVersion: string;
      name?: string;
      printers: ReportedPrinter[];
      labelPrinter?: string | null;
      documentPrinter?: string | null;
    },
  ) {
    for (const key of ["labelPrinter", "documentPrinter"] as const) {
      if (report[key] && !report.printers.some((p) => p.name === report[key])) throw printPrinterInvalid(key);
    }
    return withTenantTx(this.db, ctx, async (tx) => {
      if (report.name !== undefined || report.labelPrinter !== undefined || report.documentPrinter !== undefined) {
        await this.devices.updateIn(tx, ctx.actor.id, {
          ...(report.name !== undefined ? { name: report.name } : {}),
          ...(report.labelPrinter !== undefined ? { labelPrinter: report.labelPrinter } : {}),
          ...(report.documentPrinter !== undefined ? { documentPrinter: report.documentPrinter } : {}),
        });
      }
      return this.devices.reportIn(tx, ctx.actor.id, report);
    });
  }
}
