import { Inject, Injectable } from "@nestjs/common";
import type { StockAdjustmentReason, StockMovementType } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import type { DbHandle, Tx } from "../../db/client";
import type { StockReferenceType } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { type Allocation, type AllocationLine, chooseWarehouse } from "./allocation-plan";
import { duplicateLine, stockInsufficient, variantNotFound, warehouseNotFound } from "./inventory.errors";
import { inventoryChanged } from "./inventory.events";
import { InventoryRepository, type MovementRow, type StockSummary, type VariantInfo } from "./inventory.repository";
import { alertWorsened, type StockAlert, stockAlertOf } from "./stock-plan";
import { WarehousesService, type WarehouseView } from "./warehouses.service";

export interface AdjustmentLine {
  variantId: string;
  warehouseId: string;
  /** `set`: the counted quantity; `delta`: add (positive) or remove (negative) */
  mode: "set" | "delta";
  quantity: number;
}

export interface AdjustmentResult {
  variantId: string;
  warehouseId: string;
  onHandBefore: number;
  onHandAfter: number;
  available: number;
  /** false when `set` matched the recorded quantity: nothing moved, the quantity was confirmed */
  changed: boolean;
  movementId: string | null;
}

/** A reservation, release, or shipment of an order item (backend doc 7.9). */
export interface OrderStockMove {
  orderItemId: string;
  variantId: string;
  warehouseId: string;
  type: "order_reserve" | "order_release" | "order_ship";
  qty: number;
}

/** Returned units of one request item received into a warehouse (FR-RET-03, 06). */
export interface ReturnStockMove {
  returnItemId: string;
  variantId: string;
  warehouseId: string;
  /** Back in sellable stock. */
  sellable: number;
  /** Into quarantine: in the warehouse, never sold or pushed. */
  damaged: number;
}

/** Establishes a quantity: lock, compute the difference, move or confirm. */
export interface EstablishLine {
  variantId: string;
  warehouseId: string;
  onHand: number;
  /** where errors point, e.g. `lines.3.quantity` */
  path: string;
}

/**
 * Stock quantities (PRD 6.3, backend doc 7.8.4): manual adjustments with a reason (FR-STK-05), the
 * stock card (FR-STK-06), and the summary of the stock page. Every change goes through
 * apply_stock_movement or confirm_stock and writes inventory.changed in the same transaction, which
 * the stock pusher turns into marketplace updates (FR-STK-03).
 */
@Injectable()
export class InventoryService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(InventoryRepository) private readonly repo: InventoryRepository,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  /** FR-INT-07, in the caller's transaction: the stock allocation rules of a store whose data is deleted. */
  async deleteStoreRulesIn(tx: Tx, storeId: string): Promise<void> {
    await this.repo.deleteStoreRules(tx, storeId);
  }

  /** Warehouses of the caller's scope, narrowed to `warehouseId` when given (empty when outside). */
  async warehousesIn(tx: Tx, ctx: RequestContext, warehouseId?: string): Promise<WarehouseView[]> {
    const visible = await this.warehouses.visibleIn(tx, ctx);
    return warehouseId ? visible.filter((w) => w.id === warehouseId) : visible;
  }

  /** FR-STK-05: all lines or none. A `set` line equal to the record only confirms the quantity. */
  async adjust(
    ctx: RequestContext,
    input: { lines: AdjustmentLine[]; reason: StockAdjustmentReason; note?: string | null | undefined },
  ): Promise<AdjustmentResult[]> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const visible = new Set((await this.warehouses.visibleIn(tx, ctx)).map((w) => w.id));
      const variants = await this.repo.variants(tx, [...new Set(input.lines.map((l) => l.variantId))]);
      const seen = new Set<string>();
      input.lines.forEach((l, i) => {
        if (!variants.has(l.variantId)) throw variantNotFound(`lines.${i}.variantId`);
        if (!visible.has(l.warehouseId)) throw warehouseNotFound(`lines.${i}.warehouseId`);
        const key = `${l.variantId}|${l.warehouseId}`;
        if (seen.has(key)) throw duplicateLine(`lines.${i}`);
        seen.add(key);
      });
      const results: AdjustmentResult[] = [];
      for (const [i, l] of input.lines.entries()) {
        results.push(
          await this.moveIn(tx, ctx, {
            variantId: l.variantId,
            warehouseId: l.warehouseId,
            ...(l.mode === "set" ? { target: l.quantity } : { delta: l.quantity }),
            type: "adjustment",
            reason: input.reason,
            note: input.note ?? null,
            path: `lines.${i}.quantity`,
          }),
        );
      }
      await this.changedIn(tx, ctx, results);
      return results;
    });
  }

  /**
   * Sets on-hand quantities inside the caller's transaction (initial stock, later stock counts) and
   * writes inventory.changed for them. The caller has validated variants and warehouses.
   */
  async establishIn(
    tx: Tx,
    ctx: RequestContext,
    lines: EstablishLine[],
    meta: {
      type: "migration_initial" | "count_apply";
      note: string | null;
      reference?: { type: StockReferenceType; id: string };
    },
  ): Promise<AdjustmentResult[]> {
    const results: AdjustmentResult[] = [];
    for (const l of lines) {
      results.push(
        await this.moveIn(tx, ctx, {
          variantId: l.variantId,
          warehouseId: l.warehouseId,
          target: l.onHand,
          type: meta.type,
          reason: null,
          note: meta.note,
          path: l.path,
          ...(meta.reference ? { reference: meta.reference } : {}),
        }),
      );
    }
    await this.changedIn(tx, ctx, results);
    return results;
  }

  /**
   * Initial stock from a migration file (backend doc 8.19): sets on-hand only where nobody established
   * stock yet, the same rule as initial stock from a store, so an import never overwrites a count.
   * Rows are locked in (variant, warehouse) order before they are read.
   */
  async importInitialIn(
    tx: Tx,
    ctx: RequestContext,
    lines: EstablishLine[],
    meta: { note: string; reference: { type: StockReferenceType; id: string } },
  ): Promise<{ set: number; confirmed: number; skipped: number }> {
    const sorted = [...lines].sort(
      (a, b) => a.variantId.localeCompare(b.variantId) || a.warehouseId.localeCompare(b.warehouseId),
    );
    const apply: EstablishLine[] = [];
    for (const l of sorted) {
      const row = await this.repo.lockRow(tx, ctx.tenantId, l.variantId, l.warehouseId);
      if (!row.stockSetAt) apply.push(l);
    }
    const results = await this.establishIn(tx, ctx, apply, { type: "migration_initial", ...meta });
    const set = results.filter((r) => r.changed).length;
    return { set, confirmed: results.length - set, skipped: lines.length - apply.length };
  }

  private async moveIn(
    tx: Tx,
    ctx: RequestContext,
    m: {
      variantId: string;
      warehouseId: string;
      target?: number;
      delta?: number;
      type: StockMovementType;
      reason: string | null;
      note: string | null;
      path: string;
      reference?: { type: StockReferenceType; id: string };
    },
  ): Promise<AdjustmentResult> {
    const row = await this.repo.lockRow(tx, ctx.tenantId, m.variantId, m.warehouseId);
    const delta = m.target !== undefined ? m.target - row.onHand : (m.delta ?? 0);
    if (row.onHand + delta < 0) throw stockInsufficient(m.path, row.onHand);
    const base = { variantId: m.variantId, warehouseId: m.warehouseId, onHandBefore: row.onHand };
    if (delta === 0) {
      await this.repo.confirmStock(tx, ctx.tenantId, m.variantId, m.warehouseId);
      return { ...base, onHandAfter: row.onHand, available: row.available ?? 0, changed: false, movementId: null };
    }
    const applied = await this.repo.applyMovement(tx, {
      tenantId: ctx.tenantId,
      variantId: m.variantId,
      warehouseId: m.warehouseId,
      type: m.type,
      onHand: delta,
      referenceType: m.reference?.type ?? "manual",
      referenceId: m.reference?.id ?? null,
      reason: m.reason,
      note: m.note,
      actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    });
    return {
      ...base,
      onHandAfter: applied.on_hand_after,
      available: applied.on_hand_after - applied.reserved_after - applied.buffer_after,
      changed: true,
      movementId: applied.id,
    };
  }

  /** Confirmations count too: they make stock eligible for push. */
  private async changedIn(
    tx: Tx,
    ctx: RequestContext,
    changed: readonly { variantId: string; warehouseId: string }[],
  ): Promise<void> {
    for (let i = 0; i < changed.length; i += 500) {
      const pairs = changed.slice(i, i + 500).map((r) => ({ variantId: r.variantId, warehouseId: r.warehouseId }));
      if (pairs.length > 0) await this.outbox.enqueue(tx, ctx, inventoryChanged, { pairs }, pairs[0]!.variantId);
    }
  }

  /**
   * Order reservations, releases, and shipments inside the order's transaction. Rows are locked in a
   * fixed order (variant, warehouse) so two orders never wait on each other. A release or shipment never
   * takes more than the row holds; a shipment larger than the recorded stock means the recorded stock
   * was too low, so it ships what is recorded and reports the missing units.
   */
  async orderMovementsIn(
    tx: Tx,
    ctx: RequestContext,
    moves: OrderStockMove[],
  ): Promise<{ shortfalls: { orderItemId: string; missing: number }[] }> {
    const shortfalls: { orderItemId: string; missing: number }[] = [];
    const changed = new Map<string, { variantId: string; warehouseId: string }>();
    const ordered = [...moves]
      .filter((m) => m.qty > 0)
      .sort((a, b) => (a.variantId + a.warehouseId < b.variantId + b.warehouseId ? -1 : 1));
    for (const m of ordered) {
      let onHand = 0;
      let reserved = m.qty;
      let note: string | null = null;
      if (m.type !== "order_reserve") {
        const row = await this.repo.lockRow(tx, ctx.tenantId, m.variantId, m.warehouseId);
        reserved = -Math.min(row.reserved, m.qty);
        if (m.type === "order_ship") {
          onHand = -Math.min(row.onHand, m.qty);
          if (row.onHand < m.qty) {
            shortfalls.push({ orderItemId: m.orderItemId, missing: m.qty - row.onHand });
            note = `Stok fisik tercatat kurang ${m.qty - row.onHand} saat dikirim`;
          }
        }
      }
      if (onHand === 0 && reserved === 0) continue;
      await this.repo.applyMovement(tx, {
        tenantId: ctx.tenantId,
        variantId: m.variantId,
        warehouseId: m.warehouseId,
        type: m.type,
        onHand,
        reserved,
        referenceType: "order_item",
        referenceId: m.orderItemId,
        note,
        actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
      });
      changed.set(`${m.variantId}|${m.warehouseId}`, { variantId: m.variantId, warehouseId: m.warehouseId });
    }
    await this.changedIn(tx, ctx, [...changed.values()]);
    return { shortfalls };
  }

  /**
   * Returned goods received (FR-RET-03, 06), inside the receipt's transaction: sellable units go back on
   * hand (`return_restock`) and reach the marketplaces through inventory.changed; damaged units go to
   * quarantine (`return_quarantine`, the damaged count), which nothing sells. Rows are locked in a fixed
   * order (variant, warehouse), as for orders.
   */
  async returnMovementsIn(tx: Tx, ctx: RequestContext, moves: ReturnStockMove[], note: string | null): Promise<void> {
    const changed = new Map<string, { variantId: string; warehouseId: string }>();
    const ordered = [...moves].sort((a, b) => (a.variantId + a.warehouseId < b.variantId + b.warehouseId ? -1 : 1));
    const actorUserId = ctx.actor.type === "user" ? ctx.actor.id : null;
    for (const m of ordered) {
      const base = {
        tenantId: ctx.tenantId,
        variantId: m.variantId,
        warehouseId: m.warehouseId,
        referenceType: "return_item" as const,
        referenceId: m.returnItemId,
        note,
        actorUserId,
      };
      if (m.sellable > 0) {
        await this.repo.applyMovement(tx, { ...base, type: "return_restock", onHand: m.sellable });
        changed.set(`${m.variantId}|${m.warehouseId}`, { variantId: m.variantId, warehouseId: m.warehouseId });
      }
      if (m.damaged > 0) await this.repo.applyMovement(tx, { ...base, type: "return_quarantine", damaged: m.damaged });
    }
    await this.changedIn(tx, ctx, [...changed.values()]);
  }

  /** Available and established per (variant, warehouse), keyed `${variantId}|${warehouseId}`. */
  async stockIn(
    tx: Tx,
    variantIds: string[],
    warehouseIds: string[],
  ): Promise<Map<string, { available: number; established: boolean }>> {
    const rows = await this.repo.rows(tx, [...new Set(variantIds)], [...new Set(warehouseIds)]);
    return new Map(
      rows.map((r) => [
        `${r.variantId}|${r.warehouseId}`,
        { available: r.available ?? r.onHand - r.reserved - r.buffer, established: r.stockSetAt !== null },
      ]),
    );
  }

  /**
   * The warehouse for an order no marketplace placed (PRD FR-ORD-12, backend doc 8.21): among the active
   * warehouses (only those in `within` when given, the caller's warehouse scope), the nearest to the
   * buyer that has every item in stock; else `home` or the default (allocation-plan.ts).
   */
  async allocateIn(
    tx: Tx,
    input: {
      lines: readonly AllocationLine[];
      buyerProvince: string | null;
      home: string | null;
      within?: ReadonlySet<string> | null;
    },
  ): Promise<Allocation> {
    const warehouses = (await this.warehouses.activeIn(tx)).filter((w) => !input.within || input.within.has(w.id));
    const stock = await this.stockIn(
      tx,
      input.lines.map((l) => l.variantId),
      warehouses.map((w) => w.id),
    );
    return chooseWarehouse({
      warehouses: warehouses.map((w) => ({
        id: w.id,
        name: w.name,
        province: w.address.province ?? null,
        isDefault: w.isDefault,
      })),
      lines: input.lines,
      stock,
      buyerProvince: input.buyerProvince,
      home: input.home,
    });
  }

  /** Critical stock in the caller's warehouses (dashboard, FR-RPT-01), with warehouse names. */
  async criticalIn(tx: Tx, ctx: RequestContext, limit: number) {
    const warehouses = await this.warehousesIn(tx, ctx);
    const found = await this.repo.critical(
      tx,
      warehouses.map((w) => w.id),
      limit,
    );
    const names = new Map(warehouses.map((w) => [w.id, w.name]));
    return { count: found.count, items: found.items.map((i) => ({ ...i, warehouse: names.get(i.warehouseId) ?? "" })) };
  }

  /** Variant names and SKUs from the catalog view, for other modules' lists. */
  variantsIn(tx: Tx, variantIds: string[]): Promise<Map<string, VariantInfo>> {
    return this.repo.variants(tx, [...new Set(variantIds)]);
  }

  /**
   * Stock alert levels of these pairs after a change (FR-NTF-01): the stored level follows the stock, and
   * the pairs whose level got worse than the one already sent are returned for a notification. Archived
   * variants are not alerted.
   */
  async stockAlertsIn(
    tx: Tx,
    pairs: { variantId: string; warehouseId: string }[],
  ): Promise<
    { variant: VariantInfo; warehouseId: string; level: StockAlert; available: number; minStock: number | null }[]
  > {
    const variantIds = [...new Set(pairs.map((p) => p.variantId))];
    const wanted = new Set(pairs.map((p) => `${p.variantId}|${p.warehouseId}`));
    const rows = (await this.repo.rows(tx, variantIds, [...new Set(pairs.map((p) => p.warehouseId))])).filter((r) =>
      wanted.has(`${r.variantId}|${r.warehouseId}`),
    );
    const variants = await this.repo.variants(tx, variantIds);
    const out: {
      variant: VariantInfo;
      warehouseId: string;
      level: StockAlert;
      available: number;
      minStock: number | null;
    }[] = [];
    for (const r of rows) {
      const variant = variants.get(r.variantId);
      const available = r.available ?? r.onHand - r.reserved - r.buffer;
      const level =
        variant && variant.variantStatus === "active" && variant.productStatus === "active"
          ? stockAlertOf({ available, minStock: r.minStock, established: r.stockSetAt !== null })
          : null;
      if (level === r.stockAlert) continue;
      await this.repo.setStockAlert(tx, r.id, level);
      if (variant && level && alertWorsened(r.stockAlert, level)) {
        out.push({ variant, warehouseId: r.warehouseId, level, available, minStock: r.minStock });
      }
    }
    return out;
  }

  /**
   * What a picker needs per (variant, warehouse) (FR-SHP-02): the bin location, keyed
   * `${variantId}|${warehouseId}`, and the variant's SKU and names.
   */
  async pickInfoIn(
    tx: Tx,
    pairs: { variantId: string; warehouseId: string }[],
  ): Promise<{ bins: Map<string, string | null>; variants: Map<string, VariantInfo> }> {
    const variantIds = [...new Set(pairs.map((p) => p.variantId))];
    const rows = await this.repo.rows(tx, variantIds, [...new Set(pairs.map((p) => p.warehouseId))]);
    return {
      bins: new Map(rows.map((r) => [`${r.variantId}|${r.warehouseId}`, r.binLocation])),
      variants: await this.repo.variants(tx, variantIds),
    };
  }

  /** Bin location and minimum stock of one variant in one warehouse (FR-STK-07, 12). */
  async setLocation(
    ctx: RequestContext,
    variantId: string,
    warehouseId: string,
    patch: { minStock?: number | null | undefined; binLocation?: string | null | undefined },
  ) {
    return withTenantTx(this.db, ctx, async (tx) => {
      if ((await this.warehousesIn(tx, ctx, warehouseId)).length === 0) throw warehouseNotFound("warehouseId");
      if (!(await this.repo.variants(tx, [variantId])).has(variantId)) throw variantNotFound("variantId");
      return this.repo.setLocation(tx, ctx.tenantId, variantId, warehouseId, {
        ...(patch.minStock !== undefined ? { minStock: patch.minStock } : {}),
        ...(patch.binLocation !== undefined ? { binLocation: patch.binLocation?.trim() || null } : {}),
      });
    });
  }

  /** FR-STK-06: movements, newest first, limited to the caller's warehouses. */
  async movements(
    ctx: RequestContext,
    filter: { variantId?: string | undefined; warehouseId?: string | undefined; type?: StockMovementType | undefined },
    before: string | undefined,
    limit: number,
  ): Promise<{ items: MovementRow[]; more: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const ws = (await this.warehousesIn(tx, ctx, filter.warehouseId)).map((w) => w.id);
      const rows = await this.repo.movements(tx, { ...filter, warehouseIds: ws }, before, limit);
      return { items: rows.slice(0, limit), more: rows.length > limit };
    });
  }

  /** Numbers for the stock page header: SKUs, low, out, oversold, never set, value at cost. */
  async summary(ctx: RequestContext, warehouseId?: string): Promise<StockSummary> {
    return withTenantTx(this.db, ctx, async (tx) =>
      this.repo.summary(
        tx,
        (await this.warehousesIn(tx, ctx, warehouseId)).map((w) => w.id),
      ),
    );
  }

  // ---- full data export (FR-MIG-09) ----

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "stok.csv",
        description: "Stok per varian dan gudang pada saat ekspor dibuat.",
        columns: [
          "gudang",
          "sku_varian",
          "nama_produk",
          "nama_varian",
          "stok_fisik",
          "dipesan",
          "penyangga",
          "rusak",
          "tersedia",
          "stok_minimum",
          "lokasi_rak",
          "stok_ditetapkan_pada",
          "diperbarui_pada",
          "id_varian",
          "id_gudang",
        ],
        pages: (tx, l) =>
          keysetPages(
            (after) => this.repo.stockPage(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((r) => [
                l.warehouseCode(r.warehouseId),
                r.sku,
                r.productName,
                r.variantName,
                r.onHand,
                r.reserved,
                r.buffer,
                r.damaged,
                r.available,
                r.minStock,
                r.binLocation,
                r.stockSetAt,
                r.updatedAt,
                r.variantId,
                r.warehouseId,
              ]),
          ),
      },
      {
        file: "mutasi_stok.csv",
        description: "Setiap perubahan stok (kartu stok), urut waktu.",
        columns: [
          "waktu",
          "gudang",
          "sku_varian",
          "nama_produk",
          "nama_varian",
          "jenis",
          "perubahan_fisik",
          "perubahan_dipesan",
          "perubahan_rusak",
          "perubahan_penyangga",
          "fisik_sesudah",
          "dipesan_sesudah",
          "rusak_sesudah",
          "penyangga_sesudah",
          "alasan",
          "catatan",
          "jenis_referensi",
          "id_referensi",
          "oleh",
          "id",
          "id_varian",
          "id_gudang",
        ],
        pages: (tx, l) =>
          keysetPages(
            (after) => this.repo.movementsPage(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((m) => [
                m.createdAt,
                l.warehouseCode(m.warehouseId),
                m.sku,
                m.productName,
                m.variantName,
                m.type,
                m.onHandDelta,
                m.reservedDelta,
                m.damagedDelta,
                m.bufferDelta,
                m.onHandAfter,
                m.reservedAfter,
                m.damagedAfter,
                m.bufferAfter,
                m.reason,
                m.note,
                m.referenceType,
                m.referenceId,
                l.userName(m.actorUserId),
                m.id,
                m.variantId,
                m.warehouseId,
              ]),
          ),
      },
    ];
  }
}
