import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import type { ColumnMapping, MigrationStats } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { normSku } from "../catalog/catalog.repository";
import { type ProductCells, ProductTransferService } from "../catalog/product-transfer.service";
import { FilesService } from "../files/files.service";
import { InventoryService } from "../inventory/inventory.service";
import { WarehousesService } from "../inventory/warehouses.service";
import { NotificationInboxService } from "../notification/inbox.service";
import { cellOf, convertRow, dataRows, FIELD_OF_COLUMN } from "./import-plan";
import { MAX_SHEET_ROWS } from "./imports.service";
import { type MigrationJobRow, MigrationRepository, type NewRowError } from "./migration.repository";
import { readSheet } from "./sheet";

const log = logger.forModule("migration.import");

/** Problems kept per validation; the count in the stats is complete. */
const MAX_STORED_ERRORS = 5_000;

interface Outcome {
  stats: MigrationStats;
  errors: NewRowError[];
}

/** Ends a transaction without committing, carrying what it found. */
class Rollback extends Error {
  constructor(readonly outcome: Outcome) {
    super("rollback");
  }
}

const n = (x: number) => x.toLocaleString("id-ID");

/**
 * Validates and imports migration files in the worker (queue `import`, backend doc 8.19). Both run
 * the same code: every row converted with the job's mapping, then the product import's own
 * validation and writes (`ProductTransferService.importRecordsIn`), then initial stock for stock that
 * was never established (`InventoryService.importInitialIn`). Validation rolls the transaction back;
 * the import commits only when no row has a problem, together with the job's status.
 */
@Injectable()
export class ImportRunnerService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(MigrationRepository) private readonly repo: MigrationRepository,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(ProductTransferService) private readonly products: ProductTransferService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
  ) {}

  validate(ctx: RequestContext, jobId: string): Promise<void> {
    return this.run(ctx, jobId, "validating");
  }

  import(ctx: RequestContext, jobId: string): Promise<void> {
    return this.run(ctx, jobId, "importing");
  }

  private async run(ctx: RequestContext, jobId: string, phase: "validating" | "importing"): Promise<void> {
    const job = await withTenantTx(this.db, ctx, (tx) => this.repo.getJob(tx, jobId));
    // done already, or the seller changed the mapping in between
    if (job?.status !== phase) return;
    // changes are attributed to the person who asked (audit log, stock card)
    const actor: RequestContext = job.createdBy ? { ...ctx, actor: { type: "user", id: job.createdBy } } : ctx;
    const commit = phase === "importing";

    let outcome: Outcome;
    try {
      const bytes = job.fileObjectId ? await this.files.read(ctx, job.fileObjectId) : null;
      if (!bytes) {
        await this.finish(
          ctx,
          job,
          "failed",
          { stats: job.stats, errors: [] },
          "Berkas impor sudah dihapus. Unggah ulang.",
        );
        return;
      }
      const { rows } = readSheet(bytes, MAX_SHEET_ROWS);
      outcome = await withTenantTx(this.db, actor, async (tx) => {
        const found = await this.applyIn(tx, actor, job, rows);
        if (!commit || found.errors.length > 0) throw new Rollback(found);
        await this.repo.replaceErrors(tx, ctx.tenantId, job.id, []);
        await this.repo.updateJob(tx, job.id, {
          status: "imported",
          stats: found.stats,
          error: null,
          finishedAt: new Date(),
        });
        await this.notify(tx, ctx, job, "imported", found.stats);
        return found;
      }).catch((err: unknown) => {
        if (err instanceof Rollback) return err.outcome;
        throw err;
      });
    } catch (err) {
      log.error({ err, migration_job_id: job.id }, "migration job failed");
      await this.finish(
        ctx,
        job,
        "failed",
        { stats: job.stats, errors: [] },
        "Impor gagal karena gangguan sistem. Coba lagi.",
      );
      return;
    }
    if (commit && outcome.errors.length === 0) return; // committed above
    if (commit) {
      // the catalog changed since the validation
      await this.finish(ctx, job, "failed", outcome, "Ada baris yang tidak lagi valid. Validasi ulang dan perbaiki.");
      return;
    }
    await this.finish(ctx, job, outcome.errors.length > 0 ? "invalid" : "validated", outcome, null);
  }

  private async finish(
    ctx: RequestContext,
    job: MigrationJobRow,
    status: "validated" | "invalid" | "failed",
    outcome: Outcome,
    error: string | null,
  ): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      await this.repo.replaceErrors(tx, ctx.tenantId, job.id, outcome.errors.slice(0, MAX_STORED_ERRORS));
      await this.repo.updateJob(tx, job.id, { status, stats: outcome.stats, error, finishedAt: new Date() });
      await this.notify(tx, ctx, job, status, outcome.stats);
    });
  }

  /** Converts, validates, and writes every row in the caller's transaction; problems come back per row. */
  private async applyIn(tx: Tx, ctx: RequestContext, job: MigrationJobRow, rows: string[][]): Promise<Outcome> {
    const mapping = job.columnMapping as ColumnMapping;
    const data = dataRows(rows, mapping.headerRow);
    const raw = new Map(data.map((r) => [r.line, r.cells]));
    const productOf = (cells: string[]) =>
      normSku(cellOf(cells, mapping, "sku_induk") || cellOf(cells, mapping, "sku_varian")) ?? "";
    const sizes = new Map<string, number>();
    for (const r of data) sizes.set(productOf(r.cells), (sizes.get(productOf(r.cells)) ?? 0) + 1);

    const errors: NewRowError[] = [];
    const problem = (line: number, field: string | null, message: string) =>
      errors.push({ rowNumber: line, field, message, raw: raw.get(line) ?? [] });

    const converted = data.map((r) => ({
      line: r.line,
      ...convertRow(r.cells, mapping, sizes.get(productOf(r.cells)) ?? 1),
    }));
    for (const c of converted) for (const i of c.issues) problem(c.line, i.field, i.message);

    const warehouses = await this.warehouses.activeIn(tx);
    const key = (s: string) => s.trim().toLowerCase();
    const stockLines: { line: number; sku: string; warehouseId: string; quantity: number }[] = [];
    for (const c of converted) {
      if (!c.stock) continue;
      const name = c.stock.warehouse;
      const wh = name
        ? warehouses.find((w) => key(w.code) === key(name) || key(w.name) === key(name))
        : warehouses.find((w) => w.isDefault);
      if (!wh) {
        problem(c.line, "gudang", name ? `Gudang "${name}" tidak ditemukan.` : "Belum ada gudang utama.");
        continue;
      }
      stockLines.push({ line: c.line, sku: c.cells.sku_varian, warehouseId: wh.id, quantity: c.stock.quantity });
    }

    const result = await this.products.importRecordsIn(
      tx,
      ctx,
      converted.map((c) => ({ line: c.line, cells: c.cells })),
    );
    const known = new Set(errors.map((e) => `${e.rowNumber}|${e.field}`));
    for (const e of result.errors) {
      const m = /^rows\.(\d+)(?:\.(\w+))?$/.exec(e.path);
      const line = m ? Number(m[1]) : (data[0]?.line ?? 1);
      const field = m?.[2] ? (FIELD_OF_COLUMN[m[2] as keyof ProductCells] ?? null) : null;
      if (field && known.has(`${line}|${field}`)) continue; // already explained by the conversion
      problem(line, field, e.message);
    }
    errors.sort((a, b) => a.rowNumber - b.rowNumber);

    let stock = { set: 0, confirmed: 0, skipped: 0 };
    if (errors.length === 0 && stockLines.length > 0) {
      stock = await this.inventory.importInitialIn(
        tx,
        ctx,
        stockLines.map((s) => ({
          variantId: result.variantIds.get(normSku(s.sku)!)!,
          warehouseId: s.warehouseId,
          onHand: s.quantity,
          path: `rows.${s.line}.stok_awal`,
        })),
        { note: `Impor ${job.fileName}`, reference: { type: "migration_job", id: job.id } },
      );
    }
    return {
      stats: {
        rows: data.length,
        errors: errors.length,
        errorRows: new Set(errors.map((e) => e.rowNumber)).size,
        products: result.summary.products,
        variants: result.summary.variants,
        stock,
      },
      errors,
    };
  }

  private async notify(
    tx: Tx,
    ctx: RequestContext,
    job: MigrationJobRow,
    status: "validated" | "invalid" | "imported" | "failed",
    s: MigrationStats,
  ): Promise<void> {
    if (!job.createdBy) return;
    const products = s.products ?? { created: 0, updated: 0 };
    const text = {
      validated: {
        severity: "info" as const,
        title: "Berkas siap diimpor",
        body: `${job.fileName}: ${n(s.rows ?? 0)} baris benar, ${n(products.created)} produk baru dan ${n(products.updated)} diperbarui saat diimpor.`,
      },
      invalid: {
        severity: "warning" as const,
        title: "Berkas perlu diperbaiki",
        body: `${job.fileName}: ${n(s.errorRows ?? 0)} dari ${n(s.rows ?? 0)} baris bermasalah. Lihat daftarnya atau unduh baris yang gagal.`,
      },
      imported: {
        severity: "info" as const,
        title: "Impor selesai",
        body: `${job.fileName}: ${n(products.created)} produk baru, ${n(products.updated)} diperbarui, stok awal ${n(s.stock?.set ?? 0)} varian.`,
      },
      failed: {
        severity: "warning" as const,
        title: "Impor gagal",
        body: `${job.fileName} gagal diproses. Buka halaman Migrasi Data untuk alasannya.`,
      },
    }[status];
    await this.inbox.notifyIn(tx, ctx, [
      { userId: job.createdBy, kind: `migration.${status}`, ...text, data: { migrationJobId: job.id } },
    ]);
  }
}
