import { Inject, Injectable } from "@nestjs/common";
import type { CancelReason } from "@omniseller/connector-core";
import { newId, type OrderStatus } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { storeIsManual, storeNotFound } from "../channel/channel.errors";
import { CONNECTORS, type ConnectorRegistry } from "../channel/connector-registry";
import { channelDisplayName, isManualChannel, StoresService } from "../channel/stores.service";
import { InventoryService } from "../inventory/inventory.service";
import { OrderIntakeService } from "./order-intake.service";
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
} from "./orders.repository";
import { type OrderTagRef, TagsRepository } from "./tags.repository";

export interface OrderView {
  order: OrderRow;
  store: { id: string; name: string; channel: string } | null;
  items: OrderItemRow[];
  problems: OrderProblemRow[];
  tags: OrderTagRef[];
}

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
  ) {}

  private scope(ctx: RequestContext): Pick<OrderListFilter, "storeScope" | "warehouseScope"> {
    return {
      storeScope: ctx.storeScope ? [...ctx.storeScope] : null,
      warehouseScope: ctx.warehouseScope ? [...ctx.warehouseScope] : null,
    };
  }

  private visible(ctx: RequestContext, o: OrderRow): boolean {
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
    const [items, problems, stores, tags] = await Promise.all([
      this.repo.items(tx, ids),
      this.repo.problems(tx, ids, true),
      this.stores.listIn(tx, ctx),
      this.tags.ofOrders(tx, ids),
    ]);
    const storeOf = new Map(stores.map((s) => [s.id, { id: s.id, name: s.name, channel: s.channel }]));
    return orders.map((o) => ({
      order: o,
      store: storeOf.get(o.storeId) ?? null,
      items: items.filter((i) => i.orderId === o.id),
      problems: problems.filter((p) => p.orderId === o.id),
      tags: tags.filter((t) => t.orderId === o.id),
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

  /** Order ids of marketplace order ids in one store (webhooks); unknown ones are left out. */
  async idsByExternalIn(tx: Tx, storeId: string, externalOrderIds: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const ext of new Set(externalOrderIds)) {
      const id = await this.repo.refOf(tx, storeId, ext);
      if (id) out.push(id);
    }
    return out;
  }

  /** Orders and their lines inside the caller's transaction, without scope checks (worker side). */
  async readIn(tx: Tx, orderIds: string[]): Promise<{ orders: OrderRow[]; items: OrderItemRow[] }> {
    const ids = [...new Set(orderIds)];
    const [orders, items] = await Promise.all([this.repo.getMany(tx, ids), this.repo.items(tx, ids)]);
    return { orders, items };
  }

  async list(
    ctx: RequestContext,
    filter: Omit<OrderListFilter, "storeScope" | "warehouseScope">,
    sort: OrderSort,
    after: string | ShipByCursor | undefined,
    limit: number,
  ): Promise<{ items: OrderView[]; more: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const rows = await this.repo.list(tx, { ...filter, ...this.scope(ctx) }, sort, after, limit);
      return { items: await this.views(tx, ctx, rows.slice(0, limit)), more: rows.length > limit };
    });
  }

  /** Tab counters and the numbers of the order dashboard (FR-ORD-07, 15). */
  async summary(ctx: RequestContext, filter: Pick<OrderListFilter, "storeId" | "warehouseId">) {
    return withTenantTx(this.db, ctx, (tx) => this.summaryIn(tx, ctx, filter));
  }

  async summaryIn(tx: Tx, ctx: RequestContext, filter: Pick<OrderListFilter, "storeId" | "warehouseId">) {
    const f = { ...filter, ...this.scope(ctx) };
    const now = Date.now();
    const [statuses, overdue, dueSoon, cod] = await Promise.all([
      this.repo.statusCounts(tx, f),
      this.repo.dueCount(tx, f, new Date(now)),
      this.repo.dueCount(tx, f, new Date(now + SLA_WARNING_MS)),
      this.repo.codOutstanding(tx, f),
    ]);
    return { statuses, overdue, dueSoon, codOutstanding: cod };
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
      { ...filter, ...this.scope(ctx), dueBefore: new Date(Date.now() + SLA_WARNING_MS) },
      "ship_by",
      undefined,
      limit,
    );
    return rows.slice(0, limit);
  }

  async get(
    ctx: RequestContext,
    id: string,
  ): Promise<OrderView & { events: OrderEventRow[]; warehouseFixed: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const o = await this.load(tx, ctx, id);
      const [view] = await this.views(tx, ctx, [o]);
      return {
        ...view!,
        problems: await this.repo.problems(tx, [id]),
        events: await this.repo.events(tx, id),
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
      await this.intake.moveWarehouseIn(tx, ctx, o, warehouseId, { type: "user", id: ctx.actor.id });
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
          const store = (await this.stores.stockTargetsIn(tx, [o.storeId])).get(o.storeId);
          if (store?.store.syncMode !== "live") {
            return {
              id,
              ok: false,
              code: "store.read_only",
              message: "Toko masih mode baca saja. Proses pesanan ini di aplikasi lama sampai sinkron diaktifkan.",
            };
          }
          if (o.fulfillmentMode === "marketplace") {
            return {
              id,
              ok: false,
              code: "order.marketplace_fulfilled",
              message: "Pesanan ini dikirim oleh marketplace.",
            };
          }
          if (o.status === "problem") {
            return { id, ok: false, code: "order.has_problems", message: "Selesaikan masalah pesanan ini dulu." };
          }
          if (o.status !== from) {
            return {
              id,
              ok: false,
              code: "order.status_invalid",
              message: `Pesanan berstatus ${STATUS_LABELS[o.status]}, bukan ${STATUS_LABELS[from]}.`,
            };
          }
          if (!o.warehouseId) {
            return { id, ok: false, code: "order.no_warehouse", message: "Gudang pesanan ini belum diketahui." };
          }
          await this.intake.stepIn(tx, ctx, o, [{ to, via: "any" }], { type: "user", id: ctx.actor.id });
          return { id, ok: true };
        }),
      );
    }
    return results;
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
