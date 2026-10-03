import { Injectable } from "@nestjs/common";
import type { OrderStatus } from "@omniseller/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Tx } from "../../db/client";
import { type OrderProblemCode, order, orderEvent, orderExternalRef, orderItem, orderProblem } from "../../db/schema";
import { HOLD_STATUSES, SLA_WARNING_MS, TO_SHIP_STATUSES } from "./order-plan";

export type OrderRow = typeof order.$inferSelect;
export type OrderItemRow = typeof orderItem.$inferSelect;
export type OrderEventRow = typeof orderEvent.$inferSelect;
export type OrderProblemRow = typeof orderProblem.$inferSelect;

export interface OrderListFilter {
  /** Caller's store scope; null means every store. */
  storeScope: string[] | null;
  /** Caller's warehouse scope (FR-WHS-09); null means every warehouse. */
  warehouseScope: string[] | null;
  storeId?: string | undefined;
  channel?: string | undefined;
  statuses?: OrderStatus[] | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  q?: string | undefined;
  warehouseId?: string | undefined;
  problem?: OrderProblemCode | undefined;
  cod?: boolean | undefined;
  /** Still to ship with a ship-by deadline before this moment ("Hampir terlambat"). */
  dueBefore?: Date | undefined;
}

export type OrderSort = "newest" | "ship_by";

/** Keyset position for the ship-by sort. */
export interface ShipByCursor {
  t: number | null;
  id: string;
}

const o = order;

@Injectable()
export class OrdersRepository {
  // ---- intake ----

  async refOf(tx: Tx, storeId: string, externalOrderId: string): Promise<string | undefined> {
    const [row] = await tx
      .select({ orderId: orderExternalRef.orderId })
      .from(orderExternalRef)
      .where(and(eq(orderExternalRef.storeId, storeId), eq(orderExternalRef.externalOrderId, externalOrderId)));
    return row?.orderId;
  }

  async insertOrder(tx: Tx, row: typeof order.$inferInsert): Promise<void> {
    await tx.insert(order).values(row);
  }

  async insertRef(tx: Tx, row: typeof orderExternalRef.$inferInsert): Promise<void> {
    await tx.insert(orderExternalRef).values(row);
  }

  async get(tx: Tx, id: string, forUpdate = false): Promise<OrderRow | undefined> {
    const q = tx.select().from(order).where(eq(order.id, id));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  async getMany(tx: Tx, ids: string[]): Promise<OrderRow[]> {
    if (ids.length === 0) return [];
    return tx.select().from(order).where(inArray(order.id, ids));
  }

  async update(tx: Tx, id: string, patch: Partial<typeof order.$inferInsert>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await tx.update(order).set(patch).where(eq(order.id, id));
  }

  async items(tx: Tx, orderIds: string[]): Promise<OrderItemRow[]> {
    if (orderIds.length === 0) return [];
    return tx.select().from(orderItem).where(inArray(orderItem.orderId, orderIds)).orderBy(asc(orderItem.id));
  }

  async insertItems(tx: Tx, rows: (typeof orderItem.$inferInsert)[]): Promise<void> {
    if (rows.length > 0) await tx.insert(orderItem).values(rows);
  }

  async updateItem(tx: Tx, id: string, patch: Partial<typeof orderItem.$inferInsert>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await tx.update(orderItem).set(patch).where(eq(orderItem.id, id));
  }

  async insertEvents(tx: Tx, rows: (typeof orderEvent.$inferInsert)[]): Promise<void> {
    if (rows.length > 0) await tx.insert(orderEvent).values(rows);
  }

  async events(tx: Tx, orderId: string): Promise<OrderEventRow[]> {
    return tx.select().from(orderEvent).where(eq(orderEvent.orderId, orderId)).orderBy(asc(orderEvent.id));
  }

  /**
   * Seller orders still to ship whose ship-by alert is due (FR-SHP-10): 6 hours or less left without an
   * alert, or past the deadline without the overdue one. Locked, skipping rows another scan holds.
   */
  async dueForAlert(tx: Tx, now: Date, limit: number): Promise<OrderRow[]> {
    const soon = new Date(now.getTime() + SLA_WARNING_MS);
    return tx
      .select()
      .from(order)
      .where(
        and(
          inArray(order.status, [...TO_SHIP_STATUSES]),
          eq(order.fulfillmentMode, "seller"),
          isNotNull(order.shipByAt),
          lte(order.shipByAt, soon),
          or(isNull(order.slaAlertLevel), and(eq(order.slaAlertLevel, "warning"), lte(order.shipByAt, now))),
        ),
      )
      .orderBy(asc(order.shipByAt))
      .limit(limit)
      .for("update", { skipLocked: true });
  }

  // ---- problems ----

  async problems(tx: Tx, orderIds: string[], openOnly = false): Promise<OrderProblemRow[]> {
    if (orderIds.length === 0) return [];
    return tx
      .select()
      .from(orderProblem)
      .where(and(inArray(orderProblem.orderId, orderIds), openOnly ? isNull(orderProblem.resolvedAt) : undefined))
      .orderBy(asc(orderProblem.id));
  }

  /** Opens a problem unless the same one is already open (partial unique index). */
  async openProblem(tx: Tx, row: typeof orderProblem.$inferInsert): Promise<boolean> {
    const r = await tx
      .insert(orderProblem)
      .values(row)
      .onConflictDoNothing({ target: [orderProblem.orderId, orderProblem.code], where: sql`resolved_at IS NULL` })
      .returning({ id: orderProblem.id });
    return r.length > 0;
  }

  async resolveProblems(tx: Tx, ids: string[], by: string | null, resolution: string): Promise<void> {
    if (ids.length === 0) return;
    await tx
      .update(orderProblem)
      .set({ resolvedAt: new Date(), resolvedBy: by, resolution })
      .where(and(inArray(orderProblem.id, ids), isNull(orderProblem.resolvedAt)));
  }

  /** Orders with an open problem of `code` on items of these (variant, warehouse) pairs. */
  async ordersWithOpenProblemOn(
    tx: Tx,
    code: OrderProblemCode,
    pairs: { variantId: string; warehouseId: string }[],
  ): Promise<string[]> {
    if (pairs.length === 0) return [];
    const r = await tx
      .selectDistinct({ orderId: orderProblem.orderId })
      .from(orderProblem)
      .innerJoin(orderItem, eq(orderItem.orderId, orderProblem.orderId))
      .where(
        and(
          eq(orderProblem.code, code),
          isNull(orderProblem.resolvedAt),
          or(...pairs.map((p) => and(eq(orderItem.variantId, p.variantId), eq(orderItem.warehouseId, p.warehouseId)))),
        ),
      );
    return r.map((x) => x.orderId);
  }

  // ---- listing attach ----

  /** Lines of a store's orders that sold this listing and have no variant yet. */
  async unmappedItemsFor(
    tx: Tx,
    l: { id: string; storeId: string; externalItemId: string; externalVariantId: string },
  ): Promise<OrderItemRow[]> {
    const rows = await tx
      .select({ item: orderItem })
      .from(orderItem)
      .innerJoin(order, eq(order.id, orderItem.orderId))
      .where(
        and(
          isNull(orderItem.variantId),
          eq(order.storeId, l.storeId),
          ne(order.status, "cancelled"),
          or(
            eq(orderItem.listingId, l.id),
            and(eq(orderItem.externalProductId, l.externalItemId), eq(orderItem.externalSkuId, l.externalVariantId)),
          ),
        ),
      );
    return rows.map((r) => r.item);
  }

  // ---- duplicates (FR-ORD-06) ----

  async sameBuyerOrders(
    tx: Tx,
    storeId: string,
    externalBuyerId: string,
    around: Date,
    excludeId: string,
  ): Promise<OrderRow[]> {
    const day = 86_400_000;
    return tx
      .select()
      .from(order)
      .where(
        and(
          eq(order.storeId, storeId),
          eq(order.externalBuyerId, externalBuyerId),
          ne(order.id, excludeId),
          ne(order.status, "cancelled"),
          gte(order.orderedAt, new Date(around.getTime() - day)),
          lte(order.orderedAt, new Date(around.getTime() + day)),
        ),
      )
      .limit(20);
  }

  // ---- lists ----

  private where(f: OrderListFilter): SQL | undefined {
    const q = f.q?.trim();
    return and(
      f.storeScope ? inArray(o.storeId, f.storeScope.length ? f.storeScope : [""]) : undefined,
      f.warehouseScope ? inArray(o.warehouseId, f.warehouseScope.length ? f.warehouseScope : [""]) : undefined,
      f.storeId ? eq(o.storeId, f.storeId) : undefined,
      f.channel ? eq(o.channel, f.channel as OrderRow["channel"]) : undefined,
      f.statuses?.length ? inArray(o.status, f.statuses) : undefined,
      f.from ? gte(o.orderedAt, f.from) : undefined,
      f.to ? lt(o.orderedAt, f.to) : undefined,
      f.warehouseId ? eq(o.warehouseId, f.warehouseId) : undefined,
      f.cod !== undefined ? eq(o.isCod, f.cod) : undefined,
      f.dueBefore
        ? and(inArray(o.status, [...TO_SHIP_STATUSES]), isNotNull(o.shipByAt), lt(o.shipByAt, f.dueBefore))
        : undefined,
      f.problem
        ? sql`EXISTS (SELECT 1 FROM order_problem p WHERE p.order_id = ${sql.raw('"order"."id"')}
                         AND p.code = ${f.problem} AND p.resolved_at IS NULL)`
        : undefined,
      q
        ? or(
            ilike(o.externalOrderId, `%${q}%`),
            eq(o.trackingNumber, q),
            ilike(o.buyerName, `%${q}%`),
            ilike(o.buyerUsername, `%${q}%`),
            sql`EXISTS (SELECT 1 FROM order_item i WHERE i.order_id = ${sql.raw('"order"."id"')}
                          AND (i.sku_snapshot ILIKE ${`%${q}%`} OR i.title_snapshot ILIKE ${`%${q}%`}))`,
          )
        : undefined,
    );
  }

  async list(
    tx: Tx,
    f: OrderListFilter,
    sort: OrderSort,
    after: string | ShipByCursor | undefined,
    limit: number,
  ): Promise<OrderRow[]> {
    if (sort === "ship_by") {
      const c = after as ShipByCursor | undefined;
      const keyset = c
        ? c.t === null
          ? and(isNull(o.shipByAt), gt(o.id, c.id))
          : or(gt(o.shipByAt, new Date(c.t)), isNull(o.shipByAt), and(eq(o.shipByAt, new Date(c.t)), gt(o.id, c.id)))
        : undefined;
      return tx
        .select()
        .from(o)
        .where(and(this.where(f), keyset))
        .orderBy(sql`${o.shipByAt} ASC NULLS LAST`, asc(o.id))
        .limit(limit + 1);
    }
    return tx
      .select()
      .from(o)
      .where(and(this.where(f), after ? lt(o.id, after as string) : undefined))
      .orderBy(desc(o.id))
      .limit(limit + 1);
  }

  async statusCounts(tx: Tx, f: OrderListFilter): Promise<Record<string, number>> {
    const rows = await tx
      .select({ status: o.status, n: sql<number>`count(*)::int` })
      .from(o)
      .where(this.where({ ...f, statuses: undefined }))
      .groupBy(o.status);
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** Still to ship and due before `before`, for the "almost late" counter. */
  async dueCount(tx: Tx, f: OrderListFilter, before: Date): Promise<number> {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(o)
      .where(this.where({ ...f, statuses: undefined, dueBefore: before }));
    return r?.n ?? 0;
  }

  /** COD orders whose money has not come in yet: not cancelled, not completed (FR-ORD-15). */
  async codOutstanding(tx: Tx, f: OrderListFilter): Promise<{ orders: number; total: number }> {
    const open: OrderStatus[] = [...HOLD_STATUSES, "shipped", "delivered"];
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${o.total}), 0)::bigint` })
      .from(o)
      .where(and(this.where({ ...f, statuses: open }), eq(o.isCod, true), ne(o.status, "unpaid")));
    return { orders: r?.n ?? 0, total: Number(r?.total ?? 0) };
  }
}
