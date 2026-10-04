import { Injectable } from "@nestjs/common";
import type { StockMovementType } from "@omniseller/shared";
import { newId } from "@omniseller/shared";
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, lt, or, type SQL, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import {
  catalogVariantV,
  inventory,
  listingStockState,
  type StockReferenceType,
  stockAllocationRule,
  stockMovement,
} from "../../db/schema";

export type InventoryRow = typeof inventory.$inferSelect;
export type MovementRow = typeof stockMovement.$inferSelect;
export type RuleRow = typeof stockAllocationRule.$inferSelect;
export type StateRow = typeof listingStockState.$inferSelect;
export type VariantInfo = typeof catalogVariantV.$inferSelect;

export type StockFilter = "low" | "out" | "negative" | "unset";

export interface MovementInput {
  tenantId: string;
  variantId: string;
  warehouseId: string;
  type: StockMovementType;
  onHand?: number;
  reserved?: number;
  damaged?: number;
  buffer?: number;
  referenceType?: StockReferenceType | null;
  referenceId?: string | null;
  reason?: string | null;
  note?: string | null;
  actorUserId?: string | null;
}

export type AppliedMovement = {
  id: string;
  on_hand_after: number;
  reserved_after: number;
  damaged_after: number;
  buffer_after: number;
};

export type StockSummary = {
  skus: number;
  low: number;
  out: number;
  negative: number;
  unset: number;
  value: number;
};

export interface PushResultRow {
  listingId: string;
  channelWarehouseId: string;
  ok: boolean;
  /** A temporary failure (busy, rate limit, network); BullMQ sends it again. */
  retryable: boolean;
  quantity: number;
  error: string | null;
}

const list = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
/** The view's variant id, fully qualified for correlated subqueries (see AGENTS.md traps). */
const VID = sql.raw('"catalog_variant_v"."variant_id"');

/**
 * Inventory tables (backend doc 7.8.4): quantities only through apply_stock_movement / confirm_stock,
 * allocation rules, and the stock pusher's state. Variant data comes from the catalog's exported view.
 */
@Injectable()
export class InventoryRepository {
  // ---- quantities ----

  async rows(tx: Tx, variantIds: string[], warehouseIds: string[] | null): Promise<InventoryRow[]> {
    if (variantIds.length === 0 || warehouseIds?.length === 0) return [];
    return tx
      .select()
      .from(inventory)
      .where(
        and(
          inArray(inventory.variantId, variantIds),
          warehouseIds ? inArray(inventory.warehouseId, warehouseIds) : undefined,
        ),
      );
  }

  /** Creates the zero row if missing (ensure_inventory) and locks it for this transaction. */
  async lockRow(tx: Tx, tenantId: string, variantId: string, warehouseId: string): Promise<InventoryRow> {
    await tx.execute(sql`SELECT ensure_inventory(${newId()}, ${tenantId}, ${variantId}, ${warehouseId})`);
    const [row] = await tx
      .select()
      .from(inventory)
      .where(and(eq(inventory.variantId, variantId), eq(inventory.warehouseId, warehouseId)))
      .for("update");
    return row!;
  }

  async applyMovement(tx: Tx, m: MovementInput): Promise<AppliedMovement> {
    await tx.execute(sql`SELECT ensure_inventory(${newId()}, ${m.tenantId}, ${m.variantId}, ${m.warehouseId})`);
    const r = await tx.execute<AppliedMovement>(sql`
      SELECT id, on_hand_after, reserved_after, damaged_after, buffer_after FROM apply_stock_movement(
        ${newId()}, ${m.tenantId}, ${m.variantId}, ${m.warehouseId}, ${m.type},
        ${m.onHand ?? 0}, ${m.reserved ?? 0}, ${m.damaged ?? 0}, ${m.buffer ?? 0},
        ${m.referenceType ?? null}, ${m.referenceId ?? null}, ${m.reason ?? null}, ${m.note ?? null},
        ${m.actorUserId ?? null})`);
    return r.rows[0]!;
  }

  /** The quantity was confirmed without a change; it counts as established from now on. */
  async confirmStock(tx: Tx, tenantId: string, variantId: string, warehouseId: string): Promise<void> {
    await tx.execute(sql`SELECT confirm_stock(${tenantId}, ${variantId}, ${warehouseId})`);
  }

  async setLocation(
    tx: Tx,
    tenantId: string,
    variantId: string,
    warehouseId: string,
    patch: { minStock?: number | null; binLocation?: string | null },
  ): Promise<InventoryRow> {
    await tx.execute(sql`SELECT ensure_inventory(${newId()}, ${tenantId}, ${variantId}, ${warehouseId})`);
    const [row] = await tx
      .update(inventory)
      .set({
        ...(patch.minStock !== undefined ? { minStock: patch.minStock } : {}),
        ...(patch.binLocation !== undefined ? { binLocation: patch.binLocation } : {}),
      })
      .where(and(eq(inventory.variantId, variantId), eq(inventory.warehouseId, warehouseId)))
      .returning();
    return row!;
  }

  /**
   * Critical stock in these warehouses (dashboard, FR-RPT-01): established stock of live variants that
   * ran out or is at or under its minimum; the most urgent first, with the total count.
   */
  async critical(
    tx: Tx,
    warehouseIds: string[],
    limit: number,
  ): Promise<{
    count: number;
    items: {
      variantId: string;
      warehouseId: string;
      sku: string;
      productName: string;
      variantName: string;
      available: number;
      minStock: number | null;
    }[];
  }> {
    if (warehouseIds.length === 0) return { count: 0, items: [] };
    const r = await tx.execute<{
      variant_id: string;
      warehouse_id: string;
      sku: string;
      product_name: string;
      variant_name: string;
      available: string;
      min_stock: string | null;
      total: string;
    }>(sql`
      SELECT i.variant_id, i.warehouse_id, v.sku, v.product_name, v.variant_name, i.available, i.min_stock,
             count(*) OVER () AS total
        FROM inventory i
        JOIN catalog_variant_v v ON v.variant_id = i.variant_id
       WHERE i.warehouse_id IN (${list(warehouseIds)})
         AND i.stock_set_at IS NOT NULL
         AND v.variant_status = 'active' AND v.product_status = 'active'
         AND (i.available <= 0 OR (i.min_stock IS NOT NULL AND i.available <= i.min_stock))
       ORDER BY i.available, v.sku
       LIMIT ${limit}`);
    return {
      count: Number(r.rows[0]?.total ?? 0),
      items: r.rows.map((x) => ({
        variantId: x.variant_id,
        warehouseId: x.warehouse_id,
        sku: x.sku,
        productName: x.product_name,
        variantName: x.variant_name,
        available: Number(x.available),
        minStock: x.min_stock === null ? null : Number(x.min_stock),
      })),
    };
  }

  async setStockAlert(tx: Tx, id: string, level: "low" | "out" | null): Promise<void> {
    await tx.update(inventory).set({ stockAlert: level }).where(eq(inventory.id, id));
  }

  // ---- variants (catalog view) ----

  async variants(tx: Tx, ids: string[]): Promise<Map<string, VariantInfo>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.select().from(catalogVariantV).where(inArray(catalogVariantV.variantId, ids));
    return new Map(rows.map((r) => [r.variantId, r]));
  }

  /**
   * One page of variants for the stock list, newest first. Stock filters look at the given warehouses
   * only: `out` is nothing sellable (including never stocked), `low` is at or under the minimum but
   * not out, `negative` is oversold, `unset` is never established in any of them.
   */
  async variantPage(
    tx: Tx,
    f: { q?: string | undefined; stock?: StockFilter | undefined; includeArchived?: boolean; warehouseIds: string[] },
    before: string | undefined,
    limit: number,
  ): Promise<VariantInfo[]> {
    const v = catalogVariantV;
    const ws = f.warehouseIds;
    if (ws.length === 0) return [];
    const inWs = sql`i.warehouse_id IN (${list(ws)})`;
    const available = sql`coalesce((SELECT sum(i.available) FROM inventory i WHERE i.variant_id = ${VID} AND ${inWs}), 0)`;
    const stockCond: Record<StockFilter, SQL> = {
      out: sql`${available} <= 0`,
      low: sql`${available} > 0 AND EXISTS (SELECT 1 FROM inventory i WHERE i.variant_id = ${VID} AND ${inWs}
                 AND i.min_stock IS NOT NULL AND i.available <= i.min_stock)`,
      negative: sql`EXISTS (SELECT 1 FROM inventory i WHERE i.variant_id = ${VID} AND ${inWs} AND i.available < 0)`,
      unset: sql`NOT EXISTS (SELECT 1 FROM inventory i WHERE i.variant_id = ${VID} AND ${inWs} AND i.stock_set_at IS NOT NULL)`,
    };
    const q = f.q?.trim();
    return tx
      .select()
      .from(v)
      .where(
        and(
          f.includeArchived ? undefined : and(eq(v.variantStatus, "active"), eq(v.productStatus, "active")),
          q
            ? or(
                ilike(v.sku, `%${q}%`),
                ilike(v.productName, `%${q}%`),
                ilike(v.variantName, `%${q}%`),
                eq(v.barcode, q),
              )
            : undefined,
          f.stock ? stockCond[f.stock] : undefined,
          before ? lt(v.variantId, before) : undefined,
        ),
      )
      .orderBy(desc(v.variantId))
      .limit(limit + 1);
  }

  async summary(tx: Tx, warehouseIds: string[]): Promise<StockSummary> {
    if (warehouseIds.length === 0) return { skus: 0, low: 0, out: 0, negative: 0, unset: 0, value: 0 };
    const r = await tx.execute<StockSummary>(sql`
      SELECT count(*)::bigint AS skus,
             count(*) FILTER (WHERE s.available > 0 AND s.low)::bigint AS low,
             count(*) FILTER (WHERE s.available <= 0)::bigint AS out,
             count(*) FILTER (WHERE s.negative)::bigint AS negative,
             count(*) FILTER (WHERE NOT s.established)::bigint AS unset,
             coalesce(sum(s.on_hand * s.cost_price), 0)::bigint AS value
        FROM (SELECT v.variant_id, v.cost_price,
                     coalesce(sum(i.available), 0) AS available,
                     coalesce(sum(i.on_hand), 0) AS on_hand,
                     coalesce(bool_or(i.min_stock IS NOT NULL AND i.available <= i.min_stock), false) AS low,
                     coalesce(bool_or(i.available < 0), false) AS negative,
                     coalesce(bool_or(i.stock_set_at IS NOT NULL), false) AS established
                FROM catalog_variant_v v
                LEFT JOIN inventory i ON i.variant_id = v.variant_id AND i.warehouse_id IN (${list(warehouseIds)})
               WHERE v.variant_status = 'active' AND v.product_status = 'active'
               GROUP BY v.variant_id, v.cost_price) s`);
    return r.rows[0]!;
  }

  // ---- movements (stock card) ----

  async movements(
    tx: Tx,
    f: { variantId?: string | undefined; warehouseIds: string[]; type?: StockMovementType | undefined },
    before: string | undefined,
    limit: number,
  ): Promise<MovementRow[]> {
    if (f.warehouseIds.length === 0) return [];
    return tx
      .select()
      .from(stockMovement)
      .where(
        and(
          f.variantId ? eq(stockMovement.variantId, f.variantId) : undefined,
          inArray(stockMovement.warehouseId, f.warehouseIds),
          f.type ? eq(stockMovement.type, f.type) : undefined,
          before ? lt(stockMovement.id, before) : undefined,
        ),
      )
      .orderBy(desc(stockMovement.id))
      .limit(limit + 1);
  }

  // ---- allocation rules ----

  async rules(tx: Tx, storeIds: string[]): Promise<RuleRow[]> {
    if (storeIds.length === 0) return [];
    return tx
      .select()
      .from(stockAllocationRule)
      .where(inArray(stockAllocationRule.storeId, storeIds))
      .orderBy(asc(stockAllocationRule.storeId), asc(stockAllocationRule.priority), asc(stockAllocationRule.id));
  }

  async getRule(tx: Tx, id: string, forUpdate = false): Promise<RuleRow | undefined> {
    const q = tx.select().from(stockAllocationRule).where(eq(stockAllocationRule.id, id));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  async insertRule(tx: Tx, row: typeof stockAllocationRule.$inferInsert): Promise<void> {
    await tx.insert(stockAllocationRule).values(row);
  }

  async updateRule(tx: Tx, id: string, patch: Partial<typeof stockAllocationRule.$inferInsert>): Promise<void> {
    await tx.update(stockAllocationRule).set(patch).where(eq(stockAllocationRule.id, id));
  }

  async deleteRule(tx: Tx, id: string): Promise<void> {
    await tx.delete(stockAllocationRule).where(eq(stockAllocationRule.id, id));
  }

  // ---- push state ----

  async states(tx: Tx, listingIds: string[]): Promise<StateRow[]> {
    if (listingIds.length === 0) return [];
    return tx.select().from(listingStockState).where(inArray(listingStockState.listingId, listingIds));
  }

  async failingListings(tx: Tx, listingIds: string[]): Promise<Set<string>> {
    if (listingIds.length === 0) return new Set();
    const rows = await tx
      .selectDistinct({ listingId: listingStockState.listingId })
      .from(listingStockState)
      .where(and(inArray(listingStockState.listingId, listingIds), isNotNull(listingStockState.lastError)));
    return new Set(rows.map((r) => r.listingId));
  }

  /**
   * Records what the marketplace answered. Success stores the pushed quantity and clears the error;
   * failure keeps the last good quantity and counts the failure.
   */
  /** Records push results; returns the listings the marketplace refused for the first time in a row. */
  async recordPush(tx: Tx, tenantId: string, results: PushResultRow[], at: Date): Promise<PushResultRow[]> {
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    if (ok.length > 0) {
      await tx
        .insert(listingStockState)
        .values(
          ok.map((r) => ({
            id: newId(),
            tenantId,
            listingId: r.listingId,
            channelWarehouseId: r.channelWarehouseId,
            lastPushedQty: r.quantity,
            lastPushedAt: at,
            lastAttemptAt: at,
            lastError: null,
            pushFailCount: 0,
          })),
        )
        .onConflictDoUpdate({
          target: [listingStockState.listingId, listingStockState.channelWarehouseId],
          set: {
            lastPushedQty: sql`excluded.last_pushed_qty`,
            lastPushedAt: sql`excluded.last_pushed_at`,
            lastAttemptAt: sql`excluded.last_attempt_at`,
            lastError: null,
            pushFailCount: 0,
          },
        });
    }
    if (failed.length > 0) {
      const counted = await tx
        .insert(listingStockState)
        .values(
          failed.map((r) => ({
            id: newId(),
            tenantId,
            listingId: r.listingId,
            channelWarehouseId: r.channelWarehouseId,
            lastAttemptAt: at,
            lastError: (r.error ?? "Gagal").slice(0, 1000),
            pushFailCount: 1,
          })),
        )
        .onConflictDoUpdate({
          target: [listingStockState.listingId, listingStockState.channelWarehouseId],
          set: {
            lastAttemptAt: sql`excluded.last_attempt_at`,
            lastError: sql`excluded.last_error`,
            pushFailCount: sql`${listingStockState.pushFailCount} + 1`,
          },
        })
        .returning({
          listingId: listingStockState.listingId,
          channelWarehouseId: listingStockState.channelWarehouseId,
          pushFailCount: listingStockState.pushFailCount,
        });
      return failed.filter(
        (r) =>
          !r.retryable &&
          counted.some(
            (c) =>
              c.listingId === r.listingId && c.channelWarehouseId === r.channelWarehouseId && c.pushFailCount === 1,
          ),
      );
    }
    return [];
  }

  /** Forgets what was pushed, so the next push sends every value again (store goes live, remap). */
  async invalidateStates(tx: Tx, listingIds: string[]): Promise<void> {
    if (listingIds.length === 0) return;
    await tx
      .update(listingStockState)
      .set({ lastPushedQty: null })
      .where(inArray(listingStockState.listingId, listingIds));
  }

  async deleteStates(tx: Tx, listingIds: string[]): Promise<void> {
    if (listingIds.length === 0) return;
    await tx.delete(listingStockState).where(inArray(listingStockState.listingId, listingIds));
  }

  // ---- full data export (FR-MIG-09): keyset pages in id order ----

  async stockPage(tx: Tx, after: string | undefined, limit: number) {
    return tx
      .select({
        id: inventory.id,
        variantId: inventory.variantId,
        warehouseId: inventory.warehouseId,
        onHand: inventory.onHand,
        reserved: inventory.reserved,
        buffer: inventory.buffer,
        damaged: inventory.damaged,
        available: inventory.available,
        minStock: inventory.minStock,
        binLocation: inventory.binLocation,
        stockSetAt: inventory.stockSetAt,
        updatedAt: inventory.updatedAt,
        sku: catalogVariantV.sku,
        productName: catalogVariantV.productName,
        variantName: catalogVariantV.variantName,
      })
      .from(inventory)
      .leftJoin(catalogVariantV, eq(catalogVariantV.variantId, inventory.variantId))
      .where(after ? gt(inventory.id, after) : undefined)
      .orderBy(asc(inventory.id))
      .limit(limit);
  }

  async movementsPage(tx: Tx, after: string | undefined, limit: number) {
    return tx
      .select({
        id: stockMovement.id,
        createdAt: stockMovement.createdAt,
        variantId: stockMovement.variantId,
        warehouseId: stockMovement.warehouseId,
        type: stockMovement.type,
        onHandDelta: stockMovement.onHandDelta,
        reservedDelta: stockMovement.reservedDelta,
        damagedDelta: stockMovement.damagedDelta,
        bufferDelta: stockMovement.bufferDelta,
        onHandAfter: stockMovement.onHandAfter,
        reservedAfter: stockMovement.reservedAfter,
        damagedAfter: stockMovement.damagedAfter,
        bufferAfter: stockMovement.bufferAfter,
        referenceType: stockMovement.referenceType,
        referenceId: stockMovement.referenceId,
        reason: stockMovement.reason,
        note: stockMovement.note,
        actorUserId: stockMovement.actorUserId,
        sku: catalogVariantV.sku,
        productName: catalogVariantV.productName,
        variantName: catalogVariantV.variantName,
      })
      .from(stockMovement)
      .leftJoin(catalogVariantV, eq(catalogVariantV.variantId, stockMovement.variantId))
      .where(after ? gt(stockMovement.id, after) : undefined)
      .orderBy(asc(stockMovement.id))
      .limit(limit);
  }

  /** Established stock of active variants in these warehouses, with names (restock list, FR-STK-07). */
  async restockCandidates(tx: Tx, warehouseIds: string[], search: string | undefined) {
    if (warehouseIds.length === 0) return [];
    const like = search ? `%${search.replace(/[%_\\]/g, "\\$&")}%` : null;
    return tx
      .select({
        variantId: inventory.variantId,
        warehouseId: inventory.warehouseId,
        available: inventory.available,
        minStock: inventory.minStock,
        sku: catalogVariantV.sku,
        productName: catalogVariantV.productName,
        variantName: catalogVariantV.variantName,
      })
      .from(inventory)
      .innerJoin(catalogVariantV, eq(catalogVariantV.variantId, inventory.variantId))
      .where(
        and(
          inArray(inventory.warehouseId, warehouseIds),
          isNotNull(inventory.stockSetAt),
          eq(catalogVariantV.variantStatus, "active"),
          eq(catalogVariantV.productStatus, "active"),
          like ? or(ilike(catalogVariantV.sku, like), ilike(catalogVariantV.productName, like)) : undefined,
        ),
      );
  }
}
