import { Inject, Injectable } from "@nestjs/common";
import type { CancelReason } from "@omniseller/connector-core";
import { newId, type OrderStatus } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { ConflictError } from "../../common/errors/domain-errors";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import { localDate, startOfDate } from "../../common/time-zone";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { addDays } from "../campaign/cutoff-plan";
import { storeIsManual, storeNotFound } from "../channel/channel.errors";
import { CONNECTORS, type ConnectorRegistry } from "../channel/connector-registry";
import { channelDisplayName, isManualChannel, StoresService } from "../channel/stores.service";
import { TenantsService } from "../identity/tenants.service";
import { UsersService } from "../identity/users.service";
import { InventoryService } from "../inventory/inventory.service";
import { actorOf, OrderIntakeService } from "./order-intake.service";
import { MANUAL_CANCEL_REASONS, MOVABLE, SLA_WARNING_MS, warehouseFixed } from "./order-plan";
import {
  cancelReasonInvalid,
  orderNotCancellable,
  orderNotFound,
  orderStatusInvalid,
  orderStoreReadOnly,
  orderWarehouseNotFound,
  problemNotFound,
  warehouseFixedByMarketplace,
} from "./orders.errors";
import { orderCancelRequested, orderPullRequested } from "./orders.events";
import {
  type OrderEventRow,
  type OrderItemRow,
  type OrderListFilter,
  type OrderProblemRow,
  type OrderRow,
  type OrderSort,
  OrdersRepository,
  type ShipByCursor,
  type StaffActionRow,
} from "./orders.repository";
import { type OrderTagRef, TagsRepository } from "./tags.repository";

export interface OrderView {
  order: OrderRow;
  store: { id: string; name: string; channel: string } | null;
  items: OrderItemRow[];
  problems: OrderProblemRow[];
  tags: OrderTagRef[];
  /** When the label was last printed (a labels document rendered), by anyone or a rule; null: never. */
  labelPrintedAt: Date | null;
}

/** The history entry of an automatic rule's run (backend doc 8.37); one per order. */
export const AUTO_PROCESSED = "auto_processed";

export interface ActionResult {
  id: string;
  ok: boolean;
  code?: string;
  message?: string;
}

/** Statuses a seller may cancel from (FR-ORD-13); the marketplace has the last word on its reasons. */
const SELLER_CANCELLABLE: ReadonlySet<OrderStatus> = new Set([
  "unpaid",
  "new",
  "problem",
  "ready_to_pack",
  "packed",
  "ready_to_ship",
]);

const STATUS_LABELS: Record<OrderStatus, string> = {
  unpaid: "Belum Dibayar",
  new: "Baru",
  problem: "Bermasalah",
  ready_to_pack: "Siap Dikemas",
  packed: "Dikemas",
  ready_to_ship: "Siap Kirim",
  shipped: "Dikirim",
  delivered: "Terkirim",
  completed: "Selesai",
  return_in_progress: "Retur",
  returned: "Diretur",
  marketplace_fulfilled: "Dikirim marketplace",
  cancelled: "Dibatalkan",
};

export const orderStatusLabel = (s: OrderStatus) => STATUS_LABELS[s];

/** Narrowing of the sales figures: one store, one channel. */
export interface SalesFilter {
  storeId?: string | undefined;
  channel?: string | undefined;
}

/** An order history entry with the name of the user who made it (null for the marketplace and the system). */
export type OrderHistoryEntry = OrderEventRow & { actorName: string | null };

/** Orders per transaction when a disconnected store's orders stop holding stock. */
const RELEASE_BATCH = 200;

/**
 * Orders for sellers (PRD 6.4: FR-ORD-02, 03, 05, 06, 07, 08, 10, 13, 14, 15): the unified queue and
 * its counts, one order in full, and the seller's actions. Reads respect the store scope and, for
 * warehouse staff, the warehouse scope (FR-WHS-09). Actions are refused for stores still in read-only
 * mode, where orders are processed in the old application (FR-MIG-05).
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrdersRepository) private readonly repo: OrdersRepository,
    @Inject(OrderIntakeService) private readonly intake: OrderIntakeService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(CONNECTORS) private readonly connectors: ConnectorRegistry,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(TagsRepository) private readonly tags: TagsRepository,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  private scope(ctx: RequestContext): Pick<OrderListFilter, "storeScope" | "warehouseScope"> {
    return {
      storeScope: ctx.storeScope ? [...ctx.storeScope] : null,
      warehouseScope: ctx.warehouseScope ? [...ctx.warehouseScope] : null,
    };
  }

  /** The scope of work views (queue, tab counters, urgent list): open orders of disconnected stores stay out. */
  private async workScope(
    tx: Tx,
    ctx: RequestContext,
  ): Promise<Pick<OrderListFilter, "storeScope" | "warehouseScope" | "hiddenStoreIds">> {
    return { ...this.scope(ctx), hiddenStoreIds: [...(await this.stores.disconnectedIdsIn(tx))] };
  }

  private visible(ctx: RequestContext, o: Pick<OrderRow, "storeId" | "warehouseId">): boolean {
    return (
      this.stores.inScope(ctx, o.storeId) &&
      (ctx.warehouseScope === null || (o.warehouseId !== null && ctx.warehouseScope.has(o.warehouseId)))
    );
  }

  private async load(tx: Tx, ctx: RequestContext, id: string, forUpdate = false): Promise<OrderRow> {
    const o = await this.repo.get(tx, id, forUpdate);
    if (!o || !this.visible(ctx, o)) throw orderNotFound();
    return o;
  }

  /** One order in the caller's store and warehouse scope, inside the caller's transaction, or 404. */
  visibleIn(tx: Tx, ctx: RequestContext, id: string, forUpdate = false): Promise<OrderRow> {
    return this.load(tx, ctx, id, forUpdate);
  }

  private async views(tx: Tx, ctx: RequestContext, orders: OrderRow[]): Promise<OrderView[]> {
    const ids = orders.map((o) => o.id);
    const items = await this.repo.items(tx, ids);
    const problems = await this.repo.problems(tx, ids, true);
    const stores = await this.stores.listIn(tx, ctx);
    const tags = await this.tags.ofOrders(tx, ids);
    const printed = await this.repo.lastEventAt(tx, ids, "label_printed");
    const storeOf = new Map(stores.map((s) => [s.id, { id: s.id, name: s.name, channel: s.channel }]));
    return orders.map((o) => ({
      order: o,
      store: storeOf.get(o.storeId) ?? null,
      items: items.filter((i) => i.orderId === o.id),
      problems: problems.filter((p) => p.orderId === o.id),
      tags: tags.filter((t) => t.orderId === o.id),
      labelPrintedAt: printed.get(o.id) ?? null,
    }));
  }

  /** How many active seller warehouses the order's store has: more than one fixes the warehouse. */
  private async sellerWarehousesIn(tx: Tx, storeId: string): Promise<number> {
    const target = (await this.stores.stockTargetsIn(tx, [storeId])).get(storeId);
    return target?.warehouses.filter((w) => w.active && w.kind === "seller").length ?? 0;
  }

  /**
   * Orders by id for another module's action (fulfillment): every id must exist in the tenant and be in
   * the caller's store and warehouse scope, or the whole request is not found, like the bulk endpoints.
   */
  async requireVisible(ctx: RequestContext, orderIds: string[]): Promise<OrderRow[]> {
    const ids = [...new Set(orderIds)];
    return withTenantTx(this.db, ctx, async (tx) => {
      const found = await this.repo.getMany(tx, ids);
      if (found.length !== ids.length || found.some((o) => !this.visible(ctx, o))) throw orderNotFound();
      return ids.map((id) => found.find((o) => o.id === id)!);
    });
  }

  /**
   * Orders whose marketplace order number or tracking number is this scanned code (as read, or in
   * capitals), in the caller's scope, newest first (FR-SHP-04, 05, 17). Tracking numbers of packages
   * are searched by fulfillment, which passes the orders it found as `alsoIds`.
   */
  async byCodeIn(tx: Tx, ctx: RequestContext, code: string, alsoIds: string[] = []): Promise<OrderRow[]> {
    const byCode = await this.repo.byCode(tx, [...new Set([code, code.toUpperCase()])]);
    const extra = await this.repo.getMany(
      tx,
      alsoIds.filter((id) => !byCode.some((o) => o.id === id)),
    );
    return [...byCode, ...extra].filter((o) => this.visible(ctx, o)).sort((a, b) => (a.id < b.id ? 1 : -1));
  }

  /**
   * Locks orders another module is about to change (a courier handover hands over every parcel of its
   * manifest), without scope checks: whoever scanned them was allowed to.
   */
  lockIn(tx: Tx, ids: string[]): Promise<OrderRow[]> {
    return this.repo.lockMany(tx, [...new Set(ids)]);
  }

  /** Orders by id inside the caller's transaction, only those in the caller's scope. */
  async visibleManyIn(tx: Tx, ctx: RequestContext, ids: string[]): Promise<OrderRow[]> {
    return (await this.repo.getMany(tx, [...new Set(ids)])).filter((o) => this.visible(ctx, o));
  }

  /**
   * Order numbers by id in the caller's transaction, for the audit log (backend doc 8.28): its readers
   * (audit:read) see every entry, so this is not limited to the caller's stores.
   */
  async numbersIn(tx: Tx, ids: string[]): Promise<Map<string, string>> {
    return new Map((await this.repo.numbers(tx, ids)).map((o) => [o.id, o.number]));
  }

  /** Manual orders of a warehouse waiting for a courier (packed, not shipped), in the caller's scope. */
  async manualAwaitingIn(tx: Tx, ctx: RequestContext, warehouseId: string, limit: number): Promise<OrderRow[]> {
    return (await this.repo.manualAwaiting(tx, warehouseId, limit)).filter((o) => this.visible(ctx, o));
  }

  /** Order ids of marketplace order ids in one store (webhooks); unknown ones are left out. */
  async idsByExternalIn(tx: Tx, storeId: string, externalOrderIds: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const ext of new Set(externalOrderIds)) {
      const id = await this.repo.refOf(tx, storeId, ext);
      if (id) out.push(id);
    }
    return out;
  }

  /** Order ids by marketplace order id in one store (returns); unknown ones are left out. */
  async idMapByExternalIn(tx: Tx, storeId: string, externalOrderIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const ext of new Set(externalOrderIds)) {
      const id = await this.repo.refOf(tx, storeId, ext);
      if (id) out.set(ext, id);
    }
    return out;
  }

  /** Tag names of these orders, for printed documents (packing lists, custom labels). */
  async tagsIn(tx: Tx, orderIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const t of await this.tags.ofOrders(tx, [...new Set(orderIds)])) {
      out.set(t.orderId, [...(out.get(t.orderId) ?? []), t.name]);
    }
    return out;
  }

  /** Orders and their lines inside the caller's transaction, without scope checks (worker side). */
  async readIn(tx: Tx, orderIds: string[]): Promise<{ orders: OrderRow[]; items: OrderItemRow[] }> {
    const ids = [...new Set(orderIds)];
    const orders = await this.repo.getMany(tx, ids);
    const items = await this.repo.items(tx, ids);
    return { orders, items };
  }

  async list(
    ctx: RequestContext,
    filter: Omit<OrderListFilter, "storeScope" | "warehouseScope"> & { cutoffToday?: boolean },
    sort: OrderSort,
    after: string | ShipByCursor | undefined,
    limit: number,
  ): Promise<{ items: OrderView[]; more: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const { cutoffToday, ...rest } = filter;
      const f: OrderListFilter = {
        ...rest,
        ...(cutoffToday ? { internalBefore: await this.endOfTodayIn(tx, ctx) } : {}),
        ...(await this.workScope(tx, ctx)),
      };
      const rows = await this.repo.list(tx, f, sort, after, limit);
      return { items: await this.views(tx, ctx, rows.slice(0, limit)), more: rows.length > limit };
    });
  }

  /**
   * Orders to ship whose courier cut-off is today or earlier (backend doc 8.31), for the dashboard: how
   * many, how many missed it, and the next cut-off still ahead today.
   */
  async cutoffTodayIn(tx: Tx, ctx: RequestContext, filter: Pick<OrderListFilter, "storeId" | "warehouseId"> = {}) {
    const f = { ...filter, ...(await this.workScope(tx, ctx)) };
    return this.repo.cutoffSummary(tx, f, await this.endOfTodayIn(tx, ctx), new Date());
  }

  /** Couriers of the last 90 days' orders, at one warehouse or all the caller may see (UI L43). */
  async recentCouriers(ctx: RequestContext, warehouseId?: string) {
    return withTenantTx(this.db, ctx, async (tx) =>
      this.repo.recentCouriers(
        tx,
        { warehouseId, ...(await this.workScope(tx, ctx)) },
        new Date(Date.now() - 90 * 86_400_000),
      ),
    );
  }

  /** The start of tomorrow in the business's time zone. */
  private async endOfTodayIn(tx: Tx, ctx: RequestContext): Promise<Date> {
    const { timezone } = await this.tenants.profileIn(tx, ctx);
    return startOfDate(timezone, addDays(localDate(timezone, new Date()), 1));
  }

  /** Tab counters and the numbers of the order dashboard (FR-ORD-07, 15). */
  async summary(ctx: RequestContext, filter: Pick<OrderListFilter, "storeId" | "warehouseId">) {
    return withTenantTx(this.db, ctx, (tx) => this.summaryIn(tx, ctx, filter));
  }

  async summaryIn(tx: Tx, ctx: RequestContext, filter: Pick<OrderListFilter, "storeId" | "warehouseId">) {
    const f = { ...filter, ...(await this.workScope(tx, ctx)) };
    const now = Date.now();
    const statuses = await this.repo.statusCounts(tx, f);
    const overdue = await this.repo.dueCount(tx, f, new Date(now));
    const dueSoon = await this.repo.dueCount(tx, f, new Date(now + SLA_WARNING_MS));
    const cod = await this.repo.codOutstanding(tx, f);
    return { statuses, overdue, dueSoon, codOutstanding: cod };
  }

  // ---- disconnected stores (FR-INT-07, backend doc 8.23) ----

  /**
   * The store was disconnected: its orders stop holding stock, in batches of 200 orders per transaction.
   * Returns the order lines released.
   */
  async releaseDisconnectedStore(ctx: RequestContext, storeId: string): Promise<number> {
    let released = 0;
    for (;;) {
      const batch = await withTenantTx(this.db, ctx, async (tx) => {
        const ids = await this.repo.holdingOrderIdsOfStore(tx, storeId, RELEASE_BATCH);
        return { ids: ids.length, lines: await this.intake.releaseForDisconnectIn(tx, ctx, ids) };
      });
      released += batch.lines;
      if (batch.ids < RELEASE_BATCH) return released;
    }
  }

  /** The next orders of a store whose data is being deleted, locked (module retention). */
  storeOrderIdsIn(tx: Tx, storeId: string, limit: number): Promise<string[]> {
    return this.repo.orderIdsOfStore(tx, storeId, limit);
  }

  /**
   * Deletes these orders for good, with their lines, history, problems, references, and tags; stock they
   * still hold is released first. Shipments must be gone already (module fulfillment). Movements already
   * in the stock card stay: they record what happened to the stock.
   */
  async deleteOrdersIn(tx: Tx, ctx: RequestContext, ids: string[]): Promise<number> {
    await this.intake.releaseForDisconnectIn(tx, ctx, ids);
    return this.repo.deleteOrders(tx, ids);
  }

  /** Orders whose buyer data is due to go (backend doc 8.34), oldest first, in the caller's transaction. */
  buyerDataDueIn(tx: Tx, before: Date, limit: number): Promise<string[]> {
    return this.repo.buyerDataDue(tx, before, limit);
  }

  /**
   * Anonymizes these orders' buyer data (backend doc 8.34) in the caller's transaction, after the shipments
   * and returns of the same orders (modules fulfillment and returns). Returns how many changed.
   */
  anonymizeBuyersIn(tx: Tx, ids: string[], at: Date): Promise<number> {
    return this.repo.anonymizeBuyers(tx, ids, at);
  }

  /** Orders still to ship from a warehouse, whatever the caller's scope: it cannot be deleted (8.21). */
  openInWarehouseIn(tx: Tx, warehouseId: string): Promise<number> {
    return this.repo.openInWarehouse(tx, warehouseId);
  }

  /** Orders of one store per status since a moment (parallel mode, FR-MIG-05), in the caller's scope. */
  statusCountsIn(tx: Tx, ctx: RequestContext, storeId: string, from: Date | null): Promise<Record<string, number>> {
    return this.repo.statusCounts(tx, { ...this.scope(ctx), storeId, ...(from ? { from } : {}) });
  }

  // ---- figures for the dashboard (reporting, FR-RPT-01): the caller's transaction and scope ----

  /**
   * What users did to orders between `from` and `to` (team performance, FR-RPT-10, backend doc 8.35): per
   * user and day of `timezone`, per user, per day, and in all, for orders in the caller's scope.
   */
  staffActionsIn(tx: Tx, ctx: RequestContext, from: Date, to: Date, timezone: string): Promise<StaffActionRow[]> {
    return this.repo.staffActions(tx, this.scope(ctx), from, to, timezone);
  }

  salesIn(tx: Tx, ctx: RequestContext, filter: { storeId?: string | undefined }, from: Date, to: Date) {
    return this.repo.sales(tx, { ...filter, ...this.scope(ctx) }, from, to);
  }

  salesByDayIn(
    tx: Tx,
    ctx: RequestContext,
    filter: { storeId?: string | undefined },
    from: Date,
    to: Date,
    timezone: string,
  ) {
    return this.repo.salesByDay(tx, { ...filter, ...this.scope(ctx) }, from, to, timezone);
  }

  topProductsIn(
    tx: Tx,
    ctx: RequestContext,
    filter: { storeId?: string | undefined },
    from: Date,
    to: Date,
    limit: number,
  ) {
    return this.repo.topProducts(tx, { ...filter, ...this.scope(ctx) }, from, to, limit);
  }

  grossProfitIn(tx: Tx, ctx: RequestContext, filter: { storeId?: string | undefined }, from: Date, to: Date) {
    return this.repo.grossProfit(tx, { ...filter, ...this.scope(ctx) }, from, to);
  }

  // ---- sales report (reporting, FR-RPT-02) and restock velocity (FR-STK-07) ----

  salesBucketsIn(
    tx: Tx,
    ctx: RequestContext,
    filter: SalesFilter,
    from: Date,
    to: Date,
    unit: "day" | "week" | "month",
    timezone: string,
  ) {
    return this.repo.salesBuckets(tx, { ...filter, ...this.scope(ctx) }, from, to, unit, timezone);
  }

  salesByIn(
    tx: Tx,
    ctx: RequestContext,
    filter: SalesFilter,
    from: Date,
    to: Date,
    by: "channel" | "store" | "province",
  ) {
    return this.repo.salesBy(tx, { ...filter, ...this.scope(ctx) }, from, to, by);
  }

  salesByHourIn(tx: Tx, ctx: RequestContext, filter: SalesFilter, from: Date, to: Date, timezone: string) {
    return this.repo.salesByHour(tx, { ...filter, ...this.scope(ctx) }, from, to, timezone);
  }

  itemSalesIn(
    tx: Tx,
    ctx: RequestContext,
    filter: SalesFilter,
    from: Date,
    to: Date,
    by: "variant" | "category",
    limit: number | null,
  ) {
    return this.repo.itemSales(tx, { ...filter, ...this.scope(ctx) }, from, to, by, limit);
  }

  unitsSoldIn(tx: Tx, ctx: RequestContext, filter: SalesFilter, from: Date, to: Date) {
    return this.repo.unitsSold(tx, { ...filter, ...this.scope(ctx) }, from, to);
  }

  cancellationsIn(tx: Tx, ctx: RequestContext, filter: SalesFilter, from: Date, to: Date) {
    return this.repo.cancellations(tx, { ...filter, ...this.scope(ctx) }, from, to);
  }

  shippedIn(tx: Tx, ctx: RequestContext, filter: SalesFilter, from: Date, to: Date) {
    return this.repo.shipped(tx, { ...filter, ...this.scope(ctx) }, from, to);
  }

  /** Units sold per variant and warehouse, seller-fulfilled, in the caller's scope (FR-STK-07). */
  unitsByStockIn(tx: Tx, ctx: RequestContext, from: Date, to: Date) {
    return this.repo.unitsByStock(tx, this.scope(ctx), from, to);
  }

  /** The most urgent orders still to ship: past or within 6 hours of the ship-by deadline. */
  async urgentIn(tx: Tx, ctx: RequestContext, filter: { storeId?: string | undefined }, limit: number) {
    const rows = await this.repo.list(
      tx,
      { ...filter, ...(await this.workScope(tx, ctx)), dueBefore: new Date(Date.now() + SLA_WARNING_MS) },
      "ship_by",
      undefined,
      limit,
    );
    return rows.slice(0, limit);
  }

  async get(
    ctx: RequestContext,
    id: string,
  ): Promise<OrderView & { events: OrderHistoryEntry[]; warehouseFixed: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const o = await this.load(tx, ctx, id);
      const [view] = await this.views(tx, ctx, [o]);
      const events = await this.repo.events(tx, id);
      // who did it (UI L04 "siapa"): users by name; the marketplace and the system have none
      const names = events.some((e) => e.actorType === "user") ? await this.users.namesIn(tx) : new Map();
      return {
        ...view!,
        problems: await this.repo.problems(tx, [id]),
        events: events.map((e) => ({
          ...e,
          actorName: e.actorType === "user" && e.actorId ? (names.get(e.actorId) ?? null) : null,
        })),
        warehouseFixed:
          o.fulfillmentMode === "marketplace" ||
          warehouseFixed(o.channel, await this.sellerWarehousesIn(tx, o.storeId)),
      };
    });
  }

  /**
   * FR-ORD-12: moves an order nobody packed yet to another warehouse; its reservations follow. Orders a
   * marketplace placed in its warehouse (stores with more than one seller warehouse) stay (FR-WHS-07).
   */
  async changeWarehouse(ctx: RequestContext, id: string, warehouseId: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const o = await this.load(tx, ctx, id, true);
      if (o.fulfillmentMode === "marketplace") throw warehouseFixedByMarketplace();
      if (!MOVABLE.has(o.status)) {
        throw orderStatusInvalid(STATUS_LABELS[o.status], "Belum Dibayar, Baru, Bermasalah, atau Siap Dikemas");
      }
      if (warehouseFixed(o.channel, await this.sellerWarehousesIn(tx, o.storeId))) throw warehouseFixedByMarketplace();
      const store = (await this.stores.stockTargetsIn(tx, [o.storeId])).get(o.storeId);
      if (store?.store.syncMode !== "live") throw orderStoreReadOnly();
      if ((await this.inventory.warehousesIn(tx, ctx, warehouseId)).length === 0) {
        throw orderWarehouseNotFound("warehouseId");
      }
      if (warehouseId === o.warehouseId) return;
      await this.intake.moveWarehouseIn(tx, ctx, o, warehouseId, actorOf(ctx));
    });
  }

  /**
   * One seller step for many orders (FR-ORD-08): each order on its own, the result per order. Only the
   * orders in `from` move; read-only stores, marketplace-fulfilled orders, and orders without a
   * warehouse are refused with the reason.
   */
  private async step(
    ctx: RequestContext,
    orderIds: string[],
    from: OrderStatus,
    to: OrderStatus,
  ): Promise<ActionResult[]> {
    const ids = [...new Set(orderIds)];
    // like the other bulk endpoints: an id outside the tenant or scope fails the whole request
    await withTenantTx(this.db, ctx, async (tx) => {
      const found = await this.repo.getMany(tx, ids);
      if (found.length !== ids.length || found.some((o) => !this.visible(ctx, o))) throw orderNotFound();
    });
    const results: ActionResult[] = [];
    for (const id of ids) {
      results.push(
        await withTenantTx(this.db, ctx, async (tx): Promise<ActionResult> => {
          const o = await this.repo.get(tx, id, true);
          if (!o || !this.visible(ctx, o))
            return { id, ok: false, code: "order.not_found", message: "Pesanan tidak ditemukan." };
          const why = await this.stepRefusalIn(tx, o, from);
          if (why) return { id, ok: false, ...why };
          await this.intake.stepIn(tx, ctx, o, [{ to, via: "any" }], actorOf(ctx));
          return { id, ok: true };
        }),
      );
    }
    return results;
  }

  /** Why the order cannot take the seller step out of `from` now; null when it can. */
  private async stepRefusalIn(
    tx: Tx,
    o: OrderRow,
    from: OrderStatus,
  ): Promise<{ code: string; message: string } | null> {
    const store = (await this.stores.stockTargetsIn(tx, [o.storeId])).get(o.storeId);
    if (store?.store.syncMode !== "live") {
      return {
        code: "store.read_only",
        message: "Toko masih mode baca saja. Proses pesanan ini di aplikasi lama sampai sinkron diaktifkan.",
      };
    }
    if (o.fulfillmentMode === "marketplace") {
      return { code: "order.marketplace_fulfilled", message: "Pesanan ini dikirim oleh marketplace." };
    }
    if (o.status === "problem") return { code: "order.has_problems", message: "Selesaikan masalah pesanan ini dulu." };
    if (o.status !== from) {
      return {
        code: "order.status_invalid",
        message: `Pesanan berstatus ${STATUS_LABELS[o.status]}, bukan ${STATUS_LABELS[from]}.`,
      };
    }
    if (!o.warehouseId) return { code: "order.no_warehouse", message: "Gudang pesanan ini belum diketahui." };
    return null;
  }

  /**
   * A new order the automatic rules may act on (backend doc 8.37), with its open lines: a marketplace
   * order the seller ships, still new (an order with an open problem is not), in a live store that works,
   * and not acted on by a rule before. Null otherwise.
   */
  async autoCandidateIn(
    tx: Tx,
    orderId: string,
  ): Promise<{ order: OrderRow; lines: { skuSnapshot: string; sku: string | null; units: number }[] } | null> {
    const o = await this.repo.get(tx, orderId);
    if (o?.status !== "new" || o.fulfillmentMode !== "seller" || isManualChannel(o.channel)) return null;
    const store = (await this.stores.stockTargetsIn(tx, [o.storeId])).get(o.storeId);
    if (!store?.usable || store.store.syncMode !== "live") return null;
    if (await this.repo.hasEvent(tx, orderId, AUTO_PROCESSED)) return null;
    return { order: o, lines: await this.repo.openLines(tx, orderId) };
  }

  /** Whether the order's label was printed (a labels document rendered) at or after `since`. */
  labelPrintedSinceIn(tx: Tx, orderId: string, since: Date): Promise<boolean> {
    return this.repo.hasEventSince(tx, orderId, "label_printed", since);
  }

  /**
   * What a rule did to the order, in its history, by the system (L04 "otomatis"): the run itself, or a
   * later step of it (`auto_arrange` when its time came).
   */
  async recordAutoRunIn(
    tx: Tx,
    ctx: RequestContext,
    orderId: string,
    run: Record<string, unknown>,
    type = AUTO_PROCESSED,
  ): Promise<void> {
    await this.intake.recordIn(tx, ctx, orderId, type, actorOf(ctx), run);
  }

  /** Why "Tandai dikemas" would refuse this order now (packing by scan shows it before scanning items). */
  packRefusalIn(tx: Tx, o: OrderRow): Promise<{ code: string; message: string } | null> {
    return this.stepRefusalIn(tx, o, "ready_to_pack");
  }

  /**
   * "Tandai dikemas" for one order in the caller's transaction (packing by scan, FR-SHP-04), with the
   * checks of `pack`; a refusal is a 409 with the same code. The caller holds the order's row lock.
   */
  async packIn(tx: Tx, ctx: RequestContext, o: OrderRow, payload: Record<string, unknown>): Promise<OrderRow> {
    const why = await this.stepRefusalIn(tx, o, "ready_to_pack");
    if (why) throw new ConflictError(why.code, why.message);
    return this.intake.stepIn(tx, ctx, o, [{ to: "packed", via: "any" }], actorOf(ctx), payload);
  }

  /** "Terima pesanan": new to ready to pack. */
  accept(ctx: RequestContext, orderIds: string[]): Promise<ActionResult[]> {
    return this.step(ctx, orderIds, "new", "ready_to_pack");
  }

  /** "Tandai dikemas": ready to pack to packed. */
  pack(ctx: RequestContext, orderIds: string[]): Promise<ActionResult[]> {
    return this.step(ctx, orderIds, "ready_to_pack", "packed");
  }

  /** Reasons the marketplace accepts for this order in its current status (manual orders: OmniSeller's). */
  async cancelReasons(ctx: RequestContext, id: string): Promise<CancelReason[]> {
    const o = await withTenantTx(this.db, ctx, (tx) => this.load(tx, ctx, id));
    if (!SELLER_CANCELLABLE.has(o.status) || o.fulfillmentMode === "marketplace") return [];
    if (isManualChannel(o.channel)) return MANUAL_CANCEL_REASONS.map((r) => ({ ...r }));
    try {
      return this.connectors.get(o.channel).orders.cancelReasons(o.externalStatus ?? "");
    } catch {
      return [];
    }
  }

  /**
   * FR-ORD-13: the worker cancels at the marketplace; the released stock follows its answer (202). A
   * manual order has no marketplace to ask: it is cancelled here and now, and its stock returns.
   */
  async requestCancel(ctx: RequestContext, id: string, reason: string): Promise<void> {
    const reasons = await this.cancelReasons(ctx, id);
    await withTenantTx(this.db, ctx, async (tx) => {
      const o = await this.load(tx, ctx, id, true);
      if (isManualChannel(o.channel)) {
        if (!SELLER_CANCELLABLE.has(o.status)) throw orderNotCancellable(false);
        const chosen = reasons.find((r) => r.code === reason);
        if (!chosen) throw cancelReasonInvalid(reasons.map((r) => r.code));
        const actor = { type: "user" as const, id: ctx.actor.id };
        // the same history entry as a marketplace cancellation, so it is audited the same way
        await this.intake.recordIn(tx, ctx, id, "cancel_requested", actor, { reason, label: chosen.label });
        await this.repo.update(tx, id, { cancelReason: chosen.label, cancelledBy: "seller" });
        const cancelled = await this.intake.stepIn(tx, ctx, o, [{ to: "cancelled", via: "any" }], actor);
        await this.intake.settleIn(tx, ctx, cancelled, await this.repo.items(tx, [id]));
        return;
      }
      const store = (await this.stores.stockTargetsIn(tx, [o.storeId])).get(o.storeId);
      if (!store) throw storeNotFound();
      if (store.store.syncMode !== "live" || !store.usable || !SELLER_CANCELLABLE.has(o.status)) {
        throw orderNotCancellable(store.store.syncMode !== "live");
      }
      if (!reasons.some((r) => r.code === reason)) throw cancelReasonInvalid(reasons.map((r) => r.code));
      await this.outbox.enqueue(tx, ctx, orderCancelRequested, { orderId: id, reason }, id);
      await this.repo.insertEvents(tx, [
        {
          id: newId(),
          tenantId: ctx.tenantId,
          orderId: id,
          type: "cancel_requested",
          actorType: "user",
          actorId: ctx.actor.id,
          payload: { reason, label: reasons.find((r) => r.code === reason)?.label ?? reason },
        },
      ]);
    });
  }

  /** FR-ORD-10: internal note, never shown to the buyer; every change is kept in the history. */
  async setNote(ctx: RequestContext, id: string, note: string | null): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const o = await this.load(tx, ctx, id, true);
      const text = note?.trim() || null;
      if (text === o.internalNote) return;
      await this.repo.update(tx, id, { internalNote: text });
      await this.repo.insertEvents(tx, [
        {
          id: newId(),
          tenantId: ctx.tenantId,
          orderId: id,
          type: "note_changed",
          actorType: "user",
          actorId: ctx.actor.id,
          payload: { note: text },
        },
      ]);
    });
  }

  /** The seller handled a problem; it is not raised again for this order. */
  async resolveProblem(ctx: RequestContext, id: string, problemId: string, resolution: string | null): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const o = await this.load(tx, ctx, id, true);
      const problem = (await this.repo.problems(tx, [id], true)).find((p) => p.id === problemId);
      if (!problem) throw problemNotFound();
      await this.repo.resolveProblems(tx, [problemId], ctx.actor.id, resolution?.trim() || "manual");
      await this.repo.insertEvents(tx, [
        {
          id: newId(),
          tenantId: ctx.tenantId,
          orderId: id,
          type: "problem_resolved",
          actorType: "user",
          actorId: ctx.actor.id,
          payload: { code: problem.code, resolution: resolution ?? "manual" },
        },
      ]);
      await this.intake.settleIn(tx, ctx, o, await this.repo.items(tx, [id]));
    });
  }

  /** Reads the store's orders again from the marketplace (202). */
  async requestSync(ctx: RequestContext, storeId: string): Promise<void> {
    const view = await this.stores.get(ctx, storeId); // 404 outside the caller's tenant or scope
    if (isManualChannel(view.store.channel)) throw storeIsManual();
    await withTenantTx(this.db, ctx, (tx) =>
      this.outbox.enqueue(tx, ctx, orderPullRequested, { storeId, mode: "incremental" }, storeId),
    );
  }

  // ---- full data export (FR-MIG-09) ----

  /** Marketplace order numbers and stores of these orders, for other modules' export sheets. */
  async refsIn(tx: Tx, ids: string[]): Promise<Map<string, { externalOrderId: string; storeId: string }>> {
    return new Map((await this.repo.refs(tx, [...new Set(ids)])).map((r) => [r.id, r]));
  }

  /** The order of each order line, by line id, for the orders in the caller's scope (stock card, 8.13). */
  async ordersOfItemsIn(
    tx: Tx,
    ctx: RequestContext,
    itemIds: string[],
  ): Promise<Map<string, { id: string; externalOrderId: string }>> {
    const rows = await this.repo.itemOrders(tx, [...new Set(itemIds)]);
    return new Map(
      rows.filter((r) => this.visible(ctx, r)).map((r) => [r.itemId, { id: r.id, externalOrderId: r.externalOrderId }]),
    );
  }

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "pesanan.csv",
        description: "Pesanan dari semua toko dengan nilai, pembeli, alamat kirim, dan waktu tiap tahap.",
        columns: [
          "id",
          "toko",
          "marketplace",
          "platform",
          "no_pesanan",
          "status",
          "status_label",
          "status_marketplace",
          "pemenuhan",
          "gudang",
          "dipesan_pada",
          "dibayar_pada",
          "kirim_paling_lambat",
          "dikirim_pada",
          "diterima_pada",
          "selesai_pada",
          "dibatalkan_pada",
          "dibatalkan_oleh",
          "alasan_batal",
          "cod",
          "dropship",
          "subtotal",
          "diskon",
          "voucher_penjual",
          "ongkir_pembeli",
          "total",
          "mata_uang",
          "nama_pembeli",
          "username_pembeli",
          "telepon_pembeli",
          "nama_penerima",
          "telepon_penerima",
          "alamat",
          "kecamatan",
          "kota",
          "provinsi",
          "kode_pos",
          "kurir",
          "layanan_kurir",
          "no_resi",
          "catatan_pembeli",
          "catatan_internal",
          "sumber",
          "id_toko",
          "metode_bayar",
          "tag",
          "data_pembeli_dianonimkan_pada",
        ],
        pages: (tx, l) =>
          keysetPages(
            (after) => this.repo.ordersPage(tx, after, EXPORT_PAGE_SIZE),
            async (rows) => {
              const tags = await this.tags.ofOrders(
                tx,
                rows.map((o) => o.id),
              );
              return rows.map((o) => {
                const a = o.shippingAddress ?? {};
                return [
                  o.id,
                  l.storeName(o.storeId),
                  channelDisplayName(o.channel),
                  o.platform,
                  o.externalOrderId,
                  o.status,
                  orderStatusLabel(o.status),
                  o.externalStatus,
                  o.fulfillmentMode,
                  l.warehouseCode(o.warehouseId),
                  o.orderedAt,
                  o.paidAt,
                  o.shipByAt,
                  o.shippedAt,
                  o.deliveredAt,
                  o.completedAt,
                  o.cancelledAt,
                  o.cancelledBy,
                  o.cancelReason,
                  o.isCod,
                  o.isDropship,
                  o.subtotal,
                  o.discountTotal,
                  o.voucherSeller,
                  o.shippingFeeBuyer,
                  o.total,
                  o.currency,
                  o.buyerName,
                  o.buyerUsername,
                  o.buyerPhone,
                  a.name,
                  a.phone,
                  a.line1,
                  a.district,
                  a.city,
                  a.province,
                  a.postalCode,
                  o.shippingProvider,
                  o.shippingService,
                  o.trackingNumber,
                  o.buyerNote,
                  o.internalNote,
                  o.source,
                  o.storeId,
                  o.paymentMethod,
                  tags
                    .filter((t) => t.orderId === o.id)
                    .map((t) => t.name)
                    .join(", "),
                  o.buyerAnonymizedAt,
                ];
              });
            },
          ),
      },
      {
        file: "item_pesanan.csv",
        description: "Baris barang tiap pesanan; hubungkan ke pesanan.csv lewat id_pesanan.",
        columns: [
          "no_pesanan",
          "toko",
          "sku_marketplace",
          "judul",
          "sku_varian",
          "jumlah",
          "dibatalkan",
          "dikirim",
          "diretur",
          "harga_satuan",
          "diskon",
          "total_baris",
          "gudang",
          "id_produk_marketplace",
          "id_sku_marketplace",
          "id_item_marketplace",
          "id_pesanan",
          "id_varian",
          "id",
        ],
        pages: (tx, l) =>
          keysetPages(
            (after) => this.repo.itemsPage(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((i) => [
                i.externalOrderId,
                l.storeName(i.storeId),
                i.skuSnapshot,
                i.titleSnapshot,
                i.sku,
                i.qty,
                i.cancelledQty,
                i.shippedQty,
                i.returnedQty,
                i.unitPrice,
                i.discount,
                i.lineTotal,
                l.warehouseCode(i.warehouseId),
                i.externalProductId,
                i.externalSkuId,
                i.externalItemId,
                i.orderId,
                i.variantId,
                i.id,
              ]),
          ),
      },
    ];
  }
}
