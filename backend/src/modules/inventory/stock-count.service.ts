import { Inject, Injectable } from "@nestjs/common";
import { newId, type StockCountStatus } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { seesCost } from "../../common/cost-visibility";
import { nextDocumentNumber } from "../../common/document-number";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import { localDate } from "../../common/time-zone";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { TenantsService } from "../identity/tenants.service";
import { NotificationInboxService } from "../notification/inbox.service";
import {
  scanUnknown,
  stockCountApplying,
  stockCountClosed,
  stockCountEmpty,
  stockCountHidden,
  stockCountNotCounting,
  stockCountNotFound,
  stockCountNotInReview,
  stockCountOpenExists,
  stockCountTooLarge,
  stockOpsProblems,
  warehouseNotFound,
} from "./inventory.errors";
import { stockCountApplyRequested } from "./inventory.events";
import { InventoryService } from "./inventory.service";
import {
  type CountLineDetail,
  type CountLineFilter,
  type CountStats,
  type StockCountRow,
  StockOpsRepository,
  type VariantInfo,
} from "./stock-ops.repository";
import { type CountEntry, countEntryProblems, MAX_COUNT_LINES, stockCountNumber } from "./stock-ops-plan";
import { WarehousesService } from "./warehouses.service";

/** Lines one approval batch moves in one transaction. */
export const APPLY_BATCH = 500;
/** Batches one job applies before the next job continues (20 batches: 10,000 lines). */
const BATCHES_PER_JOB = 20;

export interface StockCountView {
  count: StockCountRow;
  warehouse: { id: string; code: string; name: string } | null;
  stats: CountStats;
  /** A blind count still being counted: the system's quantities and the differences are not shown. */
  hidden: boolean;
  /** Units over and under the system's quantity and their value at cost (null without `finance:read`). */
  difference: { unitsOver: number; unitsUnder: number; value: number | null } | null;
}

export interface CountLinesPage {
  items: CountLineDetail[];
  more: boolean;
  hidden: boolean;
}

const userOf = (ctx: RequestContext) => (ctx.actor.type === "user" ? ctx.actor.id : null);
const isHidden = (c: StockCountRow) => c.blind && c.status === "counting";

/**
 * Stock counts (stock opname, PRD FR-STK-08, backend doc 8.27): a list of a warehouse's variants, all of
 * them or a rack or a choice, counted by hand or by scanning, blind by default (the counting screens do
 * not show the system's quantity), sent for review, and approved by someone holding `inventory:adjust`.
 * The approval is applied by the worker in batches: each counted line moves stock by what the count
 * found against the quantity of the moment it was counted, so what shipped or arrived since is kept.
 * One open count per warehouse.
 */
@Injectable()
export class StockCountService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(StockOpsRepository) private readonly repo: StockOpsRepository,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  private async getIn(tx: Tx, ctx: RequestContext, id: string, lock?: "share" | "update"): Promise<StockCountRow> {
    const c = await this.repo.count(tx, id, lock);
    if (!c || (ctx.warehouseScope !== null && !ctx.warehouseScope.has(c.warehouseId))) throw stockCountNotFound();
    return c;
  }

  private async viewsIn(tx: Tx, ctx: RequestContext, rows: StockCountRow[], detail: boolean) {
    const stats = await this.repo.countStats(
      tx,
      rows.map((r) => r.id),
    );
    const names = new Map<string, { id: string; code: string; name: string }>();
    for (const id of new Set(rows.map((r) => r.warehouseId))) {
      const w = await this.warehouses.anyIn(tx, id);
      if (w) names.set(id, { id: w.id, code: w.code, name: w.name });
    }
    const out: StockCountView[] = [];
    for (const c of rows) {
      const hidden = isHidden(c);
      let difference: StockCountView["difference"] = null;
      if (detail && !hidden) {
        const d = await this.repo.countDifference(tx, c.id);
        difference = { ...d, value: seesCost(ctx) ? d.value : null };
      }
      out.push({
        count: c,
        warehouse: names.get(c.warehouseId) ?? null,
        stats: stats.get(c.id) ?? { lines: 0, counted: 0, differences: 0, added: 0 },
        hidden,
        difference,
      });
    }
    return out;
  }

  private async viewIn(tx: Tx, ctx: RequestContext, c: StockCountRow): Promise<StockCountView> {
    return (await this.viewsIn(tx, ctx, [c], true))[0]!;
  }

  /**
   * Starts a count. Full: every variant the warehouse holds a row for (live, or archived with stock).
   * Partial: the chosen variants and the racks starting with `binPrefix`. Lines are in walking order
   * (rack, then SKU) and remember the system's quantity until they are counted.
   */
  async create(
    ctx: RequestContext,
    input: {
      warehouseId: string;
      mode: "full" | "partial";
      variantIds?: string[] | undefined;
      binPrefix?: string | undefined;
      blind?: boolean | undefined;
      note?: string | null | undefined;
    },
  ): Promise<StockCountView> {
    const timezone = await this.tenants.timezone(ctx);
    return withTenantTx(this.db, ctx, async (tx) => {
      const [w] = await this.inventory.warehousesIn(tx, ctx, input.warehouseId);
      if (!w) throw warehouseNotFound("warehouseId");
      const open = await this.repo.openCountOf(tx, w.id);
      if (open) throw stockCountOpenExists(open.number);
      const chosen = input.variantIds ?? [];
      const candidates = await this.repo.countCandidates(
        tx,
        w.id,
        input.mode === "full"
          ? { full: true }
          : { variantIds: [...new Set(chosen)], binPrefix: input.binPrefix?.trim() || undefined },
        MAX_COUNT_LINES + 1,
      );
      if (candidates.length > MAX_COUNT_LINES) throw stockCountTooLarge(MAX_COUNT_LINES);
      if (input.mode === "partial") {
        const found = new Set(candidates.map((c) => c.variantId));
        const missing = chosen.flatMap((id, i) =>
          found.has(id) ? [] : [{ path: `variantIds.${i}`, message: "Varian produk tidak ditemukan." }],
        );
        if (missing.length > 0) throw stockOpsProblems(missing);
        if (candidates.length === 0) throw stockCountEmpty();
      }
      const period = localDate(timezone, new Date()).slice(2, 7).replace("-", "");
      const count = await this.repo.insertCount(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        number: stockCountNumber(period, await nextDocumentNumber(tx, ctx.tenantId, "stock_count", period)),
        warehouseId: w.id,
        mode: input.mode,
        blind: input.blind ?? true,
        note: input.note?.trim() || null,
        createdBy: userOf(ctx),
      });
      await this.repo.insertCountLines(
        tx,
        candidates.map((c) => ({
          id: newId(),
          tenantId: ctx.tenantId,
          stockCountId: count.id,
          variantId: c.variantId,
          sku: c.sku,
          productName: c.productName,
          variantName: c.variantName,
          barcode: c.barcode,
          binLocation: c.binLocation,
          expectedQty: c.onHand,
        })),
      );
      return this.viewIn(tx, ctx, count);
    });
  }

  /** Newest first, in the caller's warehouses. */
  async list(
    ctx: RequestContext,
    f: { status?: StockCountStatus | undefined; warehouseId?: string | undefined },
    before: string | undefined,
    limit: number,
  ): Promise<{ items: StockCountView[]; more: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const scope = ctx.warehouseScope ? [...ctx.warehouseScope] : null;
      const warehouseIds = f.warehouseId ? (scope && !scope.includes(f.warehouseId) ? [] : [f.warehouseId]) : scope;
      const rows = await this.repo.listCounts(tx, { warehouseIds, status: f.status }, before, limit);
      return { items: await this.viewsIn(tx, ctx, rows.slice(0, limit), false), more: rows.length > limit };
    });
  }

  async get(ctx: RequestContext, id: string): Promise<StockCountView> {
    return withTenantTx(this.db, ctx, async (tx) => this.viewIn(tx, ctx, await this.getIn(tx, ctx, id)));
  }

  /** Lines in walking order; `after` is the last line seen. Differences show once counting is over. */
  async lines(
    ctx: RequestContext,
    id: string,
    f: { filter: CountLineFilter; q?: string | undefined },
    after: string | undefined,
    limit: number,
  ): Promise<CountLinesPage> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const c = await this.getIn(tx, ctx, id);
      const hidden = isHidden(c);
      if (hidden && f.filter === "differences") throw stockCountHidden();
      const rows = await this.repo.countLines(tx, c, f, after, limit);
      return { items: rows.slice(0, limit), more: rows.length > limit, hidden };
    });
  }

  /**
   * Records counted quantities: `set` the number on the shelf, or `add` units as they are scanned. A
   * variant not on the list joins it (found on the shelf). Returns the lines as they are now.
   */
  async record(ctx: RequestContext, id: string, entries: CountEntry[]): Promise<CountLinesPage> {
    const problems = countEntryProblems(entries);
    if (problems.length > 0) throw stockOpsProblems(problems);
    return withTenantTx(this.db, ctx, async (tx) => {
      const c = await this.countingIn(tx, ctx, id);
      const variants = await this.repo.variantInfo(
        tx,
        entries.map((e) => e.variantId),
      );
      const unknown = entries.flatMap((e, i) =>
        variants.has(e.variantId) ? [] : [{ path: `lines.${i}.variantId`, message: "Varian produk tidak ditemukan." }],
      );
      if (unknown.length > 0) throw stockOpsProblems(unknown);
      const lineIds = await this.recordIn(tx, ctx, c, entries, variants);
      const rows = await this.repo.countLines(tx, c, { filter: "all", lineIds }, undefined, lineIds.length);
      return { items: rows, more: false, hidden: isHidden(c) };
    });
  }

  /** One scan: the variant by barcode or SKU, `qty` units added to its line (1 by default). */
  async scan(
    ctx: RequestContext,
    id: string,
    code: string,
    qty: number,
  ): Promise<{ line: CountLineDetail; matchedBy: "barcode" | "sku"; hidden: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const c = await this.countingIn(tx, ctx, id);
      const found = await this.repo.variantByCode(tx, code);
      if (!found) throw scanUnknown();
      const variants = await this.repo.variantInfo(tx, [found.variantId]);
      const lineIds = await this.recordIn(tx, ctx, c, [{ variantId: found.variantId, qty, mode: "add" }], variants);
      const [line] = await this.repo.countLines(tx, c, { filter: "all", lineIds }, undefined, 1);
      return { line: line!, matchedBy: found.matchedBy, hidden: isHidden(c) };
    });
  }

  /** A count being counted, held (FOR SHARE) so it is not sent for review while lines are written. */
  private async countingIn(tx: Tx, ctx: RequestContext, id: string): Promise<StockCountRow> {
    const c = await this.getIn(tx, ctx, id, "share");
    if (c.status !== "counting") throw stockCountNotCounting();
    return c;
  }

  /** Writes the entries in variant order, so two counters never wait on each other's lines. */
  private async recordIn(
    tx: Tx,
    ctx: RequestContext,
    c: StockCountRow,
    entries: CountEntry[],
    variants: Map<string, VariantInfo>,
  ): Promise<string[]> {
    const shelf = await this.repo.shelfOf(
      tx,
      c.warehouseId,
      entries.map((e) => e.variantId),
    );
    const ids: string[] = [];
    for (const e of [...entries].sort((a, b) => (a.variantId < b.variantId ? -1 : 1))) {
      const line = await this.repo.recordCount(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        stockCountId: c.id,
        variant: variants.get(e.variantId)!,
        binLocation: shelf.get(e.variantId)?.binLocation ?? null,
        qty: e.qty,
        mode: e.mode,
        onHand: shelf.get(e.variantId)?.onHand ?? 0,
        userId: userOf(ctx),
      });
      ids.push(line.id);
    }
    return ids;
  }

  /** Counting is over: the count waits for approval, and the approvers of this warehouse hear of it. */
  async submit(ctx: RequestContext, id: string): Promise<StockCountView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const c = await this.getIn(tx, ctx, id, "update");
      if (c.status !== "counting") throw stockCountNotCounting();
      const updated = await this.repo.updateCount(tx, c.id, {
        status: "review",
        submittedAt: new Date(),
        submittedBy: userOf(ctx),
      });
      const view = await this.viewIn(tx, ctx, updated);
      await this.inbox.notifyScopedIn(tx, ctx, "inventory:adjust", [{ warehouseId: c.warehouseId }], () => ({
        kind: "stock_count.review",
        severity: "info",
        title: `Stok opname ${c.number} menunggu persetujuan`,
        body: `${view.warehouse?.name ?? "Gudang"}: ${view.stats.counted} dari ${view.stats.lines} SKU dihitung, ${view.stats.differences} berselisih. Periksa lalu terapkan.`,
        data: { stockCountId: c.id, number: c.number, warehouseId: c.warehouseId },
      }));
      return view;
    });
  }

  /** Back to counting from review, to count some lines again. */
  async reopen(ctx: RequestContext, id: string): Promise<StockCountView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const c = await this.getIn(tx, ctx, id, "update");
      if (c.status !== "review") throw stockCountNotInReview();
      if (c.applyRequestedAt) throw stockCountApplying();
      return this.viewIn(tx, ctx, await this.repo.updateCount(tx, c.id, { status: "counting" }));
    });
  }

  /**
   * The approval: the worker applies the counted lines (and, with `zeroUncounted`, sets the lines nobody
   * counted to none) and marks the count applied. Asking again after a failure continues where it
   * stopped, with the choice made the first time.
   */
  async requestApply(ctx: RequestContext, id: string, input: { zeroUncounted: boolean }): Promise<StockCountView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const c = await this.getIn(tx, ctx, id, "update");
      if (c.status !== "review") throw stockCountNotInReview();
      const updated = c.applyRequestedAt
        ? c
        : await this.repo.updateCount(tx, c.id, {
            applyRequestedAt: new Date(),
            applyRequestedBy: userOf(ctx),
            zeroUncounted: input.zeroUncounted,
          });
      await this.outbox.enqueue(tx, ctx, stockCountApplyRequested, { stockCountId: c.id }, c.id);
      return this.viewIn(tx, ctx, updated);
    });
  }

  /** Stops a count before it is approved; stock does not change. */
  async cancel(ctx: RequestContext, id: string): Promise<StockCountView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const c = await this.getIn(tx, ctx, id, "update");
      if (c.status === "applied" || c.status === "cancelled") throw stockCountClosed();
      if (c.applyRequestedAt) throw stockCountApplying();
      return this.viewIn(tx, ctx, await this.repo.updateCount(tx, c.id, { status: "cancelled" }));
    });
  }

  // ---- worker ----

  /**
   * Applies an approved count, APPLY_BATCH lines per transaction (backend doc 8.27); the stock movements
   * name the approver. After BATCHES_PER_JOB batches the next job continues. Lines already applied are
   * skipped, so a job that stopped halfway is simply run again.
   */
  async apply(ctx: RequestContext, countId: string): Promise<void> {
    for (let batch = 1; ; batch++) {
      const more = await withTenantTx(this.db, ctx, async (tx) => {
        const c = await this.repo.count(tx, countId, "update");
        if (c?.status !== "review" || !c.applyRequestedAt) return false;
        const lines = await this.repo.linesToApply(tx, c.id, c.zeroUncounted, APPLY_BATCH);
        if (lines.length > 0) {
          const applied = await this.inventory.countMovementsIn(
            tx,
            ctx,
            c.warehouseId,
            lines.map((l) => ({
              lineId: l.id,
              variantId: l.variantId,
              counted: l.countedQty ?? 0,
              expected: l.countedQty === null ? null : l.expectedQty,
            })),
            { note: `Stok opname ${c.number}`, actorUserId: c.applyRequestedBy },
          );
          await this.repo.markApplied(
            tx,
            [...applied].map(([lineId, a]) => ({ id: lineId, ...a })),
          );
        }
        if (lines.length < APPLY_BATCH) {
          await this.repo.updateCount(tx, c.id, { status: "applied", appliedAt: new Date() });
          return false;
        }
        if (batch >= BATCHES_PER_JOB) {
          await this.outbox.enqueue(tx, ctx, stockCountApplyRequested, { stockCountId: c.id }, c.id);
          return false;
        }
        return true;
      });
      if (!more) return;
    }
  }

  // ---- full data export (FR-MIG-09) ----

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "stok_opname.csv",
        description:
          "Stok opname: gudang, mode, status, siapa yang menghitung, mengirim untuk ditinjau, dan menyetujui.",
        columns: [
          "nomor",
          "gudang",
          "mode",
          "buta",
          "status",
          "catatan",
          "dibuat_oleh",
          "dibuat_pada",
          "dikirim_tinjau_oleh",
          "dikirim_tinjau_pada",
          "disetujui_oleh",
          "disetujui_pada",
          "nol_untuk_yang_tidak_dihitung",
          "diterapkan_pada",
          "id",
        ],
        pages: (tx, l) =>
          keysetPages(
            (after) => this.repo.countsPage(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((c) => [
                c.number,
                l.warehouseCode(c.warehouseId),
                c.mode,
                c.blind,
                c.status,
                c.note,
                l.userName(c.createdBy),
                c.createdAt,
                l.userName(c.submittedBy),
                c.submittedAt,
                l.userName(c.applyRequestedBy),
                c.applyRequestedAt,
                c.zeroUncounted,
                c.appliedAt,
                c.id,
              ]),
          ),
      },
      {
        file: "stok_opname_baris.csv",
        description:
          "Baris stok opname: jumlah sistem saat dihitung, jumlah dihitung, selisih, dan perubahan stok yang diterapkan.",
        columns: [
          "nomor_opname",
          "sku_varian",
          "nama_produk",
          "nama_varian",
          "jumlah_sistem",
          "jumlah_dihitung",
          "selisih",
          "perubahan_stok",
          "ditemukan_saat_hitung",
          "dihitung_oleh",
          "dihitung_pada",
          "id_opname",
          "id_varian",
          "id",
        ],
        pages: (tx, l) =>
          keysetPages(
            (after) => this.repo.countLinesPage(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((r) => [
                r.number,
                r.sku,
                r.productName,
                r.variantName,
                r.expectedQty,
                r.countedQty,
                r.diff,
                r.appliedDelta,
                r.added,
                l.userName(r.countedBy),
                r.countedAt,
                r.stockCountId,
                r.variantId,
                r.id,
              ]),
          ),
      },
    ];
  }
}
