import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { InternalError, NotFoundError } from "../../common/errors/domain-errors";
import { localDate } from "../../common/time-zone";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { type DownloadTarget, FilesService } from "../files/files.service";
import { TenantsService } from "../identity/tenants.service";
import { exportExpired, exportNotFound, exportNotReady, exportScopeLimited } from "./exports.errors";
import { exportRequested } from "./exports.events";
import { type DataExportRow, ExportsRepository } from "./exports.repository";

/** An export queued or running this long is taken as lost (its worker stopped) and replaced by a new one. */
export const STUCK_EXPORT_MS = 60 * 60_000;

/**
 * Full data export (PRD FR-MIG-09, backend doc 8.18): every CSV of the business in one ZIP, at any
 * time and free. One export at a time per business; the worker renders it (ExportRenderService).
 * The ZIP holds every store's and warehouse's data, so only users without a store or warehouse
 * scope may request or download it; the permission is `data:export` (Owner). Requests and downloads
 * are in the audit log.
 */
@Injectable()
export class ExportsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ExportsRepository) private readonly repo: ExportsRepository,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  /** Queues a new export, or returns the one still being made. */
  async request(ctx: RequestContext): Promise<DataExportRow> {
    this.requireUnscoped(ctx);
    return withTenantTx(this.db, ctx, async (tx) => {
      const open = await this.repo.open(tx, true);
      if (open && Date.now() - open.statusChangedAt.getTime() < STUCK_EXPORT_MS) return open;
      if (open) {
        await this.repo.update(tx, open.id, {
          status: "failed",
          error: "Ekspor terhenti sebelum selesai; ekspor baru dibuat menggantikannya.",
          finishedAt: new Date(),
        });
      }
      const row = await this.repo.insertIfNoneOpen(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        requestedBy: ctx.actor.type === "user" ? ctx.actor.id : null,
      });
      if (!row) {
        // another request inserted one after our read; that one is the answer
        const other = await this.repo.open(tx);
        if (!other) throw new InternalError("internal.export_conflict", "open export not found after a conflict");
        return other;
      }
      await this.outbox.enqueue(tx, ctx, exportRequested, { exportId: row.id }, row.id);
      return row;
    });
  }

  /** The latest exports, newest first. */
  async list(ctx: RequestContext, limit = 20): Promise<DataExportRow[]> {
    this.requireUnscoped(ctx);
    return withTenantTx(this.db, ctx, (tx) => this.repo.list(tx, limit));
  }

  async get(ctx: RequestContext, id: string): Promise<DataExportRow> {
    this.requireUnscoped(ctx);
    const row = await withTenantTx(this.db, ctx, (tx) => this.repo.get(tx, id));
    if (!row) throw exportNotFound();
    return row;
  }

  /** The ZIP (a signed R2 link, or the bytes with local storage); every download is audited. */
  async download(ctx: RequestContext, id: string): Promise<DownloadTarget> {
    const row = await this.get(ctx, id);
    if (row.status !== "ready") throw exportNotReady();
    if (!row.fileObjectId || (row.expiresAt && row.expiresAt <= new Date())) throw exportExpired();
    const timezone = await this.tenants.timezone(ctx);
    let target: DownloadTarget;
    try {
      target = await this.files.download(ctx, row.fileObjectId, ["export"], {
        filename: `omniseller-ekspor-${localDate(timezone, row.finishedAt ?? row.createdAt)}.zip`,
        disposition: "attachment",
      });
    } catch (err) {
      if (err instanceof NotFoundError) throw exportExpired();
      throw err;
    }
    await withTenantTx(this.db, ctx, (tx) => this.repo.countDownload(tx, row.id));
    return target;
  }

  private requireUnscoped(ctx: RequestContext): void {
    if (ctx.storeScope !== null || ctx.warehouseScope !== null) throw exportScopeLimited();
  }
}
