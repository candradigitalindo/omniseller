import { Inject, Injectable } from "@nestjs/common";
import type { StockAdjustmentReason, StockMovementType } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { duplicateLine, stockInsufficient, variantNotFound, warehouseNotFound } from "./inventory.errors";
import { inventoryChanged } from "./inventory.events";
import { InventoryRepository, type MovementRow, type StockSummary, type VariantInfo } from "./inventory.repository";
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
    meta: { type: "migration_initial" | "count_apply"; note: string | null },
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
        }),
      );
    }
    await this.changedIn(tx, ctx, results);
    return results;
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
      referenceType: "manual",
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
}
