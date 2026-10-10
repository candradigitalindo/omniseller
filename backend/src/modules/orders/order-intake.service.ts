import { Inject, Injectable } from "@nestjs/common";
import type { NormalizedOrder, NormalizedOrderItem, NormalizedRecipient } from "@omniseller/connector-core";
import { newId, newIdAt, type OrderStatus } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { Tx } from "../../db/client";
import type { OrderProblemCode, order, orderItem } from "../../db/schema";
import { withStatusSource } from "../../db/tenant-tx";
import { OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { UsageMeterService } from "../billing/usage-meter.service";
import { ListingsService } from "../catalog/listings.service";
import type { ChannelWarehouseRow } from "../channel/channel.repository";
import { type StockTarget, StoresService } from "../channel/stores.service";
import { InventoryService, type OrderStockMove } from "../inventory/inventory.service";
import { OrderDeadlinesService } from "./order-deadlines.service";
import {
  detectProblems,
  HIGH_VALUE_RUPIAH,
  HOLD_STATUSES,
  initialStatus,
  itemStockPlan,
  problemStep,
  type StatusStep,
  statusSteps,
  warehouseFixed,
  withoutBuyerData,
} from "./order-plan";
import {
  orderCancelledAfterShipping,
  orderCancelRequestChanged,
  orderNewArrived,
  orderReturnStarted,
  orderStatusChanged,
} from "./orders.events";
import { type OrderItemRow, type OrderRow, OrdersRepository } from "./orders.repository";

export interface IntakeResult {
  orderId: string;
  outcome: "created" | "updated" | "stale";
  /** Marketplace items the order sold that OmniSeller has no listing for yet. */
  unknownItemIds: string[];
}

interface Placement {
  channelWarehouseId: string | null;
  warehouseId: string | null;
  externalWarehouseId: string | null;
  managed: boolean;
}

export type Actor = { type: "marketplace" | "user" | "system"; id: string | null };

/**
 * Who acts for a request in the order history: its user, or the system for a job working for the business
 * (automatic rules, backend doc 8.37), whose context names no user.
 */
export function actorOf(ctx: RequestContext): Actor {
  return ctx.actor.type === "user" ? { type: "user", id: ctx.actor.id } : { type: "system", id: null };
}

const MARKETPLACE: Actor = { type: "marketplace", id: null };
/** History entries per insert: a few parameters each, well under Postgres's 65,535 per statement. */
const RECORD_CHUNK = 1000;

function address(r: NormalizedRecipient | null) {
  if (!r) return null;
  return {
    ...(r.name ? { name: r.name } : {}),
    ...(r.phone ? { phone: r.phone } : {}),
    ...(r.fullAddress ? { line1: r.fullAddress } : {}),
    ...(r.district ? { district: r.district } : {}),
    ...(r.city ? { city: r.city } : {}),
    ...(r.province ? { province: r.province } : {}),
    ...(r.postalCode ? { postalCode: r.postalCode } : {}),
  };
}

const signature = (lines: { product: string | null; sku: string | null; qty: number }[]) =>
  lines
    .map((l) => `${l.product}|${l.sku}|${l.qty}`)
    .sort()
    .join(",");

/**
 * Applies marketplace orders (backend doc 8.14, 7.9; PRD FR-ORD-01, 02, 06, FR-WHS-06, 10, FR-RET-04):
 * one snapshot at a time, inside the caller's transaction. An order is created once per store and
 * marketplace id (order_external_ref), moves only forward, keeps its reservations in line with its
 * status through InventoryService, and opens or closes problems. Ids follow the order time
 * (`newIdAt`), so lists sort by when the order was placed.
 */
@Injectable()
export class OrderIntakeService {
  constructor(
    @Inject(OrdersRepository) private readonly repo: OrdersRepository,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(OrderDeadlinesService) private readonly deadlines: OrderDeadlinesService,
    @Inject(UsageMeterService) private readonly usage: UsageMeterService,
  ) {}

  /** Warehouse of a line (FR-WHS-06): the marketplace's warehouse, else the shop's only seller warehouse. */
  private place(target: StockTarget, externalWarehouseId: string | null): Placement {
    const active = target.warehouses.filter((w) => w.active);
    const sellers = active.filter((w) => w.kind === "seller");
    const cw: ChannelWarehouseRow | undefined =
      (externalWarehouseId ? active.find((w) => w.externalWarehouseId === externalWarehouseId) : undefined) ??
      (sellers.length === 1 ? sellers[0] : undefined) ??
      (externalWarehouseId ? undefined : sellers.find((w) => w.isDefault));
    if (!cw) {
      return {
        channelWarehouseId: null,
        warehouseId: externalWarehouseId ? null : target.store.defaultWarehouseId,
        externalWarehouseId,
        managed: false,
      };
    }
    if (cw.kind === "fulfillment") {
      return { channelWarehouseId: cw.id, warehouseId: null, externalWarehouseId, managed: true };
    }
    return {
      channelWarehouseId: cw.id,
      warehouseId: cw.mappingStatus === "mapped" ? cw.warehouseId : null,
      externalWarehouseId: externalWarehouseId ?? cw.externalWarehouseId,
      managed: false,
    };
  }

  private async event(
    tx: Tx,
    ctx: RequestContext,
    orderId: string,
    type: string,
    actor: Actor,
    extra: { fromStatus?: OrderStatus | null; toStatus?: OrderStatus | null; payload?: Record<string, unknown> } = {},
  ): Promise<void> {
    await this.repo.insertEvents(tx, [
      {
        id: newId(),
        tenantId: ctx.tenantId,
        orderId,
        type,
        fromStatus: extra.fromStatus ?? null,
        toStatus: extra.toStatus ?? null,
        actorType: actor.type,
        actorId: actor.id,
        payload: extra.payload ?? {},
      },
    ]);
  }

  /** Moves the order through `steps`, marketplace facts under withStatusSource (doc 7.9). */
  async stepIn(
    tx: Tx,
    ctx: RequestContext,
    o: OrderRow,
    steps: StatusStep[],
    actor: Actor,
    payload: Record<string, unknown> = {},
  ): Promise<OrderRow> {
    let current = o;
    for (const step of steps) {
      const at = new Date();
      // paid now: a new order for the seller (FR-NTF-01); manual orders were typed in by the team
      const arrives =
        step.to === "new" &&
        current.status === "unpaid" &&
        current.fulfillmentMode === "seller" &&
        current.channel !== "manual";
      const patch = {
        status: step.to,
        ...(step.to === "completed" && !current.completedAt ? { completedAt: at } : {}),
        ...(step.to === "cancelled" && !current.cancelledAt ? { cancelledAt: at } : {}),
        ...(step.to === "shipped" && !current.shippedAt ? { shippedAt: at } : {}),
        ...(step.to === "delivered" && !current.deliveredAt ? { deliveredAt: at } : {}),
        ...(arrives ? { notifyNew: true } : {}),
      };
      const write = () => this.repo.update(tx, current.id, patch);
      if (step.via === "marketplace" || actor.type === "marketplace") await withStatusSource(tx, "marketplace", write);
      else await write();
      await this.event(tx, ctx, current.id, "status_changed", actor, {
        fromStatus: current.status,
        toStatus: step.to,
        payload,
      });
      await this.outbox.enqueue(
        tx,
        ctx,
        orderStatusChanged,
        { orderId: current.id, from: current.status, to: step.to, actorType: actor.type, actorId: actor.id },
        current.id,
      );
      // the automatic rules look at it (FR-ORD-19, backend doc 8.37)
      if (arrives) await this.outbox.enqueue(tx, ctx, orderNewArrived, { orderId: current.id }, current.id);
      // the returns module follows (backend doc 8.26): a return the marketplace started is read at once,
      // and the parcel of an order cancelled after it shipped is expected back
      if (step.to === "return_in_progress" && actor.type === "marketplace") {
        await this.outbox.enqueue(
          tx,
          ctx,
          orderReturnStarted,
          { orderId: current.id, storeId: current.storeId, at: at.toISOString() },
          current.id,
        );
      }
      if (step.to === "cancelled" && current.status === "shipped" && current.fulfillmentMode === "seller") {
        await this.outbox.enqueue(
          tx,
          ctx,
          orderCancelledAfterShipping,
          { orderId: current.id, storeId: current.storeId },
          current.id,
        );
      }
      current = { ...current, ...patch };
    }
    return current;
  }

  /**
   * A seller-side step requested by another module (fulfillment: packed to ready to ship once the label
   * is ready). Nothing happens unless the order is still in one of `from`.
   */
  async advanceIn(
    tx: Tx,
    ctx: RequestContext,
    orderId: string,
    from: readonly OrderStatus[],
    to: OrderStatus,
    actor: Actor,
    payload: Record<string, unknown> = {},
  ): Promise<boolean> {
    const o = await this.repo.get(tx, orderId, true);
    if (!o || !from.includes(o.status)) return false;
    await this.stepIn(tx, ctx, o, [{ to, via: "any" }], actor, payload);
    return true;
  }

  /** History entries written by other modules (fulfillment: shipment arranged, label printed). */
  async recordIn(
    tx: Tx,
    ctx: RequestContext,
    orderId: string,
    type: string,
    actor: Actor,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.event(tx, ctx, orderId, type, actor, { payload });
  }

  /**
   * The same history entry for many orders (fulfillment: the orders a printed document holds), written in
   * a few statements instead of one per order.
   */
  async recordManyIn(
    tx: Tx,
    ctx: RequestContext,
    orderIds: readonly string[],
    type: string,
    actor: Actor,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    for (let i = 0; i < orderIds.length; i += RECORD_CHUNK) {
      await this.repo.insertEvents(
        tx,
        orderIds.slice(i, i + RECORD_CHUNK).map((orderId) => ({
          id: newId(),
          tenantId: ctx.tenantId,
          orderId,
          type,
          actorType: actor.type,
          actorId: actor.id,
          payload,
        })),
      );
    }
  }

  /**
   * Returned goods came back to a warehouse (returns module, FR-RET-03): the units received count as
   * returned on their lines, the history says what came back, and an order in return_in_progress whose
   * every shipped unit is back becomes returned. Lines never count more than they shipped.
   */
  async returnReceivedIn(
    tx: Tx,
    ctx: RequestContext,
    orderId: string,
    lines: { orderItemId: string; qty: number }[],
    actor: Actor,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const o = await this.repo.get(tx, orderId, true);
    if (!o) return;
    const items = await this.repo.items(tx, [orderId]);
    for (const line of lines) {
      const item = items.find((i) => i.id === line.orderItemId);
      if (!item || line.qty <= 0) continue;
      const returned = Math.min(item.shippedQty, item.returnedQty + line.qty);
      if (returned !== item.returnedQty) await this.repo.updateItem(tx, item.id, { returnedQty: returned });
      item.returnedQty = returned;
    }
    await this.event(tx, ctx, orderId, "return_received", actor, { payload });
    const shipped = items.filter((i) => i.shippedQty > 0);
    if (
      o.status === "return_in_progress" &&
      shipped.length > 0 &&
      shipped.every((i) => i.returnedQty >= i.shippedQty)
    ) {
      await this.stepIn(tx, ctx, o, [{ to: "returned", via: "any" }], actor, payload);
    }
  }

  /** Courier and tracking number learned from the shipment (Shopee gives the number only to logistics APIs). */
  async setShippingIn(
    tx: Tx,
    orderId: string,
    info: { trackingNumber?: string | null; shippingProvider?: string | null },
  ): Promise<void> {
    await this.repo.update(tx, orderId, {
      ...(info.trackingNumber ? { trackingNumber: info.trackingNumber } : {}),
      ...(info.shippingProvider ? { shippingProvider: info.shippingProvider } : {}),
    });
  }

  async applyIn(
    tx: Tx,
    ctx: RequestContext,
    target: StockTarget,
    snap: NormalizedOrder,
    meta: { source: "webhook" | "poll"; rawRef?: string | null },
  ): Promise<IntakeResult> {
    const store = target.store;
    const listings = await this.listings.byExternalIn(
      tx,
      store.id,
      snap.items.map((i) => ({ externalItemId: i.externalItemId, externalVariantId: i.externalVariantId })),
    );
    const listingOf = (i: NormalizedOrderItem) => listings.get(`${i.externalItemId}|${i.externalVariantId}`);
    const unknownItemIds = [
      ...new Set(snap.items.filter((i) => !listingOf(i) && i.externalItemId).map((i) => i.externalItemId)),
    ];
    const placements = new Map(
      snap.items.map((i) => [i.externalLineId, this.place(target, i.externalWarehouseId ?? snap.externalWarehouseId)]),
    );
    const orderPlace = [...placements.values()][0] ?? this.place(target, snap.externalWarehouseId);
    const sellerWarehouses = target.warehouses.filter((w) => w.active && w.kind === "seller").length;
    const fields = {
      externalStatus: snap.externalStatus,
      platform: snap.platform,
      cancelRequested: snap.cancelRequested,
      isCod: snap.isCod,
      shipByAt: snap.shipByAt,
      paidAt: snap.paidAt,
      cancelReason: snap.cancelReason,
      cancelledBy: snap.cancelledBy,
      subtotal: snap.subtotal,
      discountTotal: snap.discountTotal,
      shippingFeeBuyer: snap.shippingFeeBuyer,
      total: snap.total,
      currency: snap.currency.slice(0, 3),
      buyerNote: snap.buyerNote,
      externalUpdatedAt: snap.updatedAt,
      ...(snap.trackingNumber ? { trackingNumber: snap.trackingNumber } : {}),
      ...(snap.shippingProvider ? { shippingProvider: snap.shippingProvider } : {}),
      ...(snap.shippingService ? { shippingService: snap.shippingService } : {}),
      ...(snap.shippingServiceType ? { shippingServiceType: snap.shippingServiceType } : {}),
      ...(snap.shippedAt ? { shippedAt: snap.shippedAt } : {}),
      ...(snap.deliveredAt ? { deliveredAt: snap.deliveredAt } : {}),
      ...(snap.cancelledAt ? { cancelledAt: snap.cancelledAt } : {}),
      ...(snap.buyerId ? { externalBuyerId: snap.buyerId } : {}),
      ...(snap.buyerUsername ? { buyerUsername: snap.buyerUsername } : {}),
      ...(snap.recipientAvailable && snap.recipient
        ? {
            buyerName: snap.recipient.name,
            buyerPhone: snap.recipient.phone,
            shippingAddress: address(snap.recipient),
          }
        : {}),
    };

    const existingId = await this.repo.refOf(tx, store.id, snap.externalOrderId);
    if (!existingId) {
      const fulfillment =
        snap.fulfillment === "marketplace" || (orderPlace.managed && snap.items.length > 0) ? "marketplace" : "seller";
      const status = initialStatus({ state: snap.state, fulfillment });
      const id = newIdAt(snap.createdAt);
      // FR-ORD-12: a store without multi-warehouse that asked for it ships each new order from the
      // nearest warehouse that has every item, instead of its mapped warehouse
      let allocation: { warehouseId: string; reason: string } | null = null;
      if (
        fulfillment === "seller" &&
        HOLD_STATUSES.has(status) &&
        store.settings.autoAllocate === true &&
        !warehouseFixed(store.channel, sellerWarehouses)
      ) {
        const a = await this.inventory.allocateIn(tx, {
          lines: snap.items.flatMap((i) => {
            const variantId = listingOf(i)?.variantId;
            return variantId ? [{ variantId, qty: i.quantity - i.cancelledQuantity }] : [];
          }),
          buyerProvince: snap.recipientAvailable ? (snap.recipient?.province ?? null) : null,
          home: orderPlace.warehouseId ?? store.defaultWarehouseId,
        });
        if (a.warehouseId) {
          allocation = { warehouseId: a.warehouseId, reason: a.reason };
          for (const [line, place] of placements) placements.set(line, { ...place, warehouseId: a.warehouseId });
        }
      }
      // the 90-day import is history, not news: only orders after it are announced (FR-NTF-01)
      const arrives = fulfillment === "seller" && status === "new" && store.lastOrderSyncAt !== null;
      await this.repo.insertOrder(tx, {
        id,
        tenantId: ctx.tenantId,
        storeId: store.id,
        channel: store.channel,
        externalOrderId: snap.externalOrderId,
        status,
        fulfillmentMode: fulfillment,
        channelWarehouseId: orderPlace.channelWarehouseId,
        warehouseId: allocation?.warehouseId ?? orderPlace.warehouseId,
        orderedAt: snap.createdAt,
        completedAt: status === "completed" ? snap.updatedAt : null,
        notifyNew: arrives,
        source: meta.source,
        rawPayloadRef: meta.rawRef ?? null,
        ...fields,
      });
      // the automatic rules look at it (FR-ORD-19, backend doc 8.37)
      if (arrives) await this.outbox.enqueue(tx, ctx, orderNewArrived, { orderId: id }, id);
      // every order counts towards the month's quota (backend doc 8.32); none is refused for it
      await this.usage.countIn(tx, ctx, "orders", snap.createdAt);
      await this.repo.insertRef(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        storeId: store.id,
        externalOrderId: snap.externalOrderId,
        orderId: id,
      });
      await this.repo.insertItems(
        tx,
        snap.items.map((i) => this.itemRow(ctx, id, i, listingOf(i), placements.get(i.externalLineId)!)),
      );
      await this.event(tx, ctx, id, "created", MARKETPLACE, {
        toStatus: status,
        payload: {
          externalStatus: snap.externalStatus,
          source: meta.source,
          ...(allocation ? { allocation: allocation.reason, warehouseId: allocation.warehouseId } : {}),
        },
      });
      if (snap.cancelRequested) {
        await this.outbox.enqueue(
          tx,
          ctx,
          orderCancelRequestChanged,
          { orderId: id, storeId: store.id, requested: true },
          id,
        );
      }
      let o = (await this.repo.get(tx, id))!;
      if (fulfillment === "seller" && HOLD_STATUSES.has(status)) await this.intakeChecksIn(tx, ctx, o, snap);
      o = await this.settleIn(tx, ctx, o, await this.repo.items(tx, [id]), {
        recipientAvailable: snap.recipientAvailable,
        recipient: snap.recipient,
      });
      return { orderId: id, outcome: "created", unknownItemIds };
    }

    const current = (await this.repo.get(tx, existingId, true))!;
    if (current.externalUpdatedAt && snap.updatedAt < current.externalUpdatedAt) {
      return { orderId: existingId, outcome: "stale", unknownItemIds: [] };
    }
    // buyer data anonymized (backend doc 8.34) stays so whatever a later snapshot says
    const update = current.buyerAnonymizedAt ? withoutBuyerData(fields) : fields;
    await this.repo.update(tx, existingId, update);
    if (current.cancelRequested !== snap.cancelRequested) {
      await this.outbox.enqueue(
        tx,
        ctx,
        orderCancelRequestChanged,
        { orderId: existingId, storeId: store.id, requested: snap.cancelRequested },
        existingId,
      );
    }
    // lines: quantities and cancellations change; new lines are rare but possible
    const items = await this.repo.items(tx, [existingId]);
    for (const line of snap.items) {
      const item = items.find((i) => i.externalItemId === line.externalLineId);
      const listing = listingOf(line);
      if (!item) {
        await this.repo.insertItems(tx, [
          this.itemRow(ctx, existingId, line, listing, placements.get(line.externalLineId)!),
        ]);
        continue;
      }
      const cancelledQty = Math.min(line.cancelledQuantity, item.qty);
      await this.repo.updateItem(tx, item.id, {
        ...(cancelledQty !== item.cancelledQty ? { cancelledQty } : {}),
        ...(!item.variantId && listing?.variantId
          ? { listingId: listing.id, variantId: listing.variantId }
          : !item.listingId && listing
            ? { listingId: listing.id }
            : {}),
      });
    }
    const o = await this.stepIn(
      tx,
      ctx,
      { ...current, ...update },
      statusSteps(current.status, { state: snap.state, fulfillment: current.fulfillmentMode }),
      MARKETPLACE,
      { externalStatus: snap.externalStatus },
    );
    await this.settleIn(tx, ctx, o, await this.repo.items(tx, [existingId]), {
      recipientAvailable: snap.recipientAvailable,
      recipient: snap.recipient,
    });
    return { orderId: existingId, outcome: "updated", unknownItemIds };
  }

  private itemRow(
    ctx: RequestContext,
    orderId: string,
    i: NormalizedOrderItem,
    listing: { id: string; variantId: string | null } | undefined,
    place: Placement,
  ) {
    return {
      id: newId(),
      tenantId: ctx.tenantId,
      orderId,
      externalItemId: i.externalLineId,
      externalProductId: i.externalItemId || null,
      externalSkuId: i.externalVariantId,
      listingId: listing?.id ?? null,
      variantId: listing?.variantId ?? null,
      skuSnapshot: i.sku ?? "",
      titleSnapshot: i.title,
      variantSnapshot: {
        ...(i.variantName ? { name: i.variantName } : {}),
        ...(i.imageUrl ? { imageUrl: i.imageUrl } : {}),
        ...(i.originalUnitPrice !== null ? { originalUnitPrice: i.originalUnitPrice } : {}),
        ...(place.externalWarehouseId ? { externalWarehouseId: place.externalWarehouseId } : {}),
      },
      qty: i.quantity,
      cancelledQty: Math.min(i.cancelledQuantity, i.quantity),
      unitPrice: i.unitPrice,
      discount: i.discount,
      lineTotal: i.lineTotal,
      warehouseId: place.warehouseId,
    };
  }

  /**
   * An order OmniSeller itself creates (manual orders, FR-ORD-09): the order, its reference, its lines,
   * and the first history entry, then reservations and problems like any order. The caller has checked
   * what it holds; the address is not judged (the seller typed it).
   */
  async createIn(
    tx: Tx,
    ctx: RequestContext,
    input: {
      order: typeof order.$inferInsert & { id: string };
      items: (typeof orderItem.$inferInsert)[];
      actor: Actor;
      payload: Record<string, unknown>;
    },
  ): Promise<OrderRow> {
    const o = input.order;
    await this.repo.insertOrder(tx, o);
    await this.usage.countIn(tx, ctx, "orders", o.orderedAt ?? new Date());
    await this.repo.insertRef(tx, {
      id: newId(),
      tenantId: ctx.tenantId,
      storeId: o.storeId,
      externalOrderId: o.externalOrderId,
      orderId: o.id,
    });
    await this.repo.insertItems(tx, input.items);
    await this.event(tx, ctx, o.id, "created", input.actor, { toStatus: o.status, payload: input.payload });
    return this.settleIn(tx, ctx, (await this.repo.get(tx, o.id))!, await this.repo.items(tx, [o.id]));
  }

  /**
   * Moves an order nothing was packed for to another warehouse (FR-ORD-12): the reservations of the old
   * warehouse are released, the lines and the order point at the new one, and settling reserves there
   * and re-judges the stock problems. The caller has checked that the order may move.
   */
  async moveWarehouseIn(
    tx: Tx,
    ctx: RequestContext,
    o: OrderRow,
    warehouseId: string,
    actor: Actor,
  ): Promise<OrderRow> {
    const items = await this.repo.items(tx, [o.id]);
    await this.inventory.orderMovementsIn(
      tx,
      ctx,
      items
        .filter((i) => i.reservedQty > 0 && i.variantId && i.warehouseId)
        .map((i) => ({
          orderItemId: i.id,
          variantId: i.variantId!,
          warehouseId: i.warehouseId!,
          type: "order_release" as const,
          qty: i.reservedQty,
        })),
    );
    for (const i of items) await this.repo.updateItem(tx, i.id, { warehouseId, reservedQty: 0 });
    await this.repo.update(tx, o.id, { warehouseId });
    await this.event(tx, ctx, o.id, "warehouse_changed", actor, { payload: { from: o.warehouseId, to: warehouseId } });
    return this.settleIn(tx, ctx, { ...o, warehouseId }, await this.repo.items(tx, [o.id]));
  }

  /** Checks made once, when the order comes in: duplicate order and unusual value (FR-ORD-06). */
  private async intakeChecksIn(tx: Tx, ctx: RequestContext, o: OrderRow, snap: NormalizedOrder): Promise<void> {
    if (o.externalBuyerId) {
      const mine = signature(
        snap.items.map((i) => ({ product: i.externalItemId, sku: i.externalVariantId, qty: i.quantity })),
      );
      const others = await this.repo.sameBuyerOrders(tx, o.storeId, o.externalBuyerId, o.orderedAt, o.id);
      const items = await this.repo.items(
        tx,
        others.map((x) => x.id),
      );
      const twin = others.find(
        (x) =>
          signature(
            items
              .filter((i) => i.orderId === x.id)
              .map((i) => ({ product: i.externalProductId, sku: i.externalSkuId, qty: i.qty })),
          ) === mine,
      );
      if (twin) {
        await this.openIn(tx, ctx, o.id, "duplicate", {
          otherOrderId: twin.id,
          otherExternalOrderId: twin.externalOrderId,
        });
      }
    }
    if (o.total >= HIGH_VALUE_RUPIAH) await this.openIn(tx, ctx, o.id, "high_value", { total: o.total });
  }

  private async openIn(
    tx: Tx,
    ctx: RequestContext,
    orderId: string,
    code: OrderProblemCode,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const opened = await this.repo.openProblem(tx, { id: newId(), tenantId: ctx.tenantId, orderId, code, detail });
    if (opened)
      await this.event(tx, ctx, orderId, "problem_added", { type: "system", id: null }, { payload: { code, detail } });
  }

  /**
   * Brings reservations in line with the status, then problems in line with the order, then the
   * new/problem status in line with the open problems. Without a snapshot the address is not judged and
   * its problem is left as it is.
   */
  async settleIn(
    tx: Tx,
    ctx: RequestContext,
    o: OrderRow,
    items: OrderItemRow[],
    snapshot?: { recipientAvailable: boolean; recipient: NormalizedRecipient | null },
  ): Promise<OrderRow> {
    const moves: OrderStockMove[] = [];
    for (const item of items) {
      const plan = itemStockPlan(o.status, o.fulfillmentMode, item);
      for (const m of plan.moves) {
        moves.push({ orderItemId: item.id, variantId: item.variantId!, warehouseId: item.warehouseId!, ...m });
      }
      if (plan.reservedQty !== item.reservedQty || plan.shippedQty !== item.shippedQty) {
        await this.repo.updateItem(tx, item.id, { reservedQty: plan.reservedQty, shippedQty: plan.shippedQty });
      }
    }
    const { shortfalls } = await this.inventory.orderMovementsIn(tx, ctx, moves);
    if (shortfalls.length > 0) {
      await this.event(
        tx,
        ctx,
        o.id,
        "stock_shortfall",
        { type: "system", id: null },
        { payload: { items: shortfalls } },
      );
    }

    const mapped = items.filter((i) => i.variantId && i.warehouseId);
    const stock = await this.inventory.stockIn(
      tx,
      mapped.map((i) => i.variantId!),
      mapped.map((i) => i.warehouseId!),
    );
    const problemItems = items.map((i) => ({
      sku: i.skuSnapshot,
      title: i.titleSnapshot,
      open: i.qty - i.cancelledQty,
      variantId: i.variantId,
      warehouseId: i.warehouseId,
      externalWarehouseId: (i.variantSnapshot.externalWarehouseId as string | undefined) ?? null,
    }));
    const found = detectProblems({
      status: o.status,
      fulfillment: o.fulfillmentMode,
      recipientAvailable: snapshot?.recipientAvailable ?? false,
      recipient: snapshot?.recipient ?? null,
      items: problemItems,
      stock,
    });
    // an unmapped line stays a problem after shipping: its sale never left the stock
    const stillUnmapped = problemItems.filter((i) => !i.variantId && i.open > 0);
    if (
      !HOLD_STATUSES.has(o.status) &&
      o.status !== "cancelled" &&
      o.fulfillmentMode === "seller" &&
      stillUnmapped.length
    ) {
      found.set("unmapped_sku", { items: stillUnmapped.map((i) => ({ sku: i.sku, title: i.title })) });
    }

    const all = await this.repo.problems(tx, [o.id]);
    const open = all.filter((p) => !p.resolvedAt);
    const dismissed = new Set(all.filter((p) => p.resolvedBy).map((p) => p.code));
    const judged = new Set<OrderProblemCode>(["unmapped_sku", "unmapped_warehouse", "insufficient_stock"]);
    if (snapshot) judged.add("address_incomplete");
    for (const [code, detail] of found) {
      if (!open.some((p) => p.code === code) && !dismissed.has(code)) await this.openIn(tx, ctx, o.id, code, detail);
    }
    const stale = open.filter((p) => !found.has(p.code) && (judged.has(p.code) || !HOLD_STATUSES.has(o.status)));
    if (stale.length > 0) {
      await this.repo.resolveProblems(
        tx,
        stale.map((p) => p.id),
        null,
        "auto",
      );
      for (const p of stale) {
        await this.event(
          tx,
          ctx,
          o.id,
          "problem_resolved",
          { type: "system", id: null },
          {
            payload: { code: p.code, resolution: "auto" },
          },
        );
      }
    }
    const openCount = (await this.repo.problems(tx, [o.id], true)).length;
    let current = o;
    if (openCount !== o.problemCount) {
      await this.repo.update(tx, o.id, { problemCount: openCount });
      current = { ...current, problemCount: openCount };
    }
    const step = problemStep(current.status, openCount);
    const settled = step ? await this.stepIn(tx, ctx, current, [step], { type: "system", id: null }) : current;
    // the courier cut-off it has to make (backend doc 8.31): its warehouse, courier, or payment may be new
    const deadlines = await this.deadlines.refreshIn(tx, ctx, [o.id]);
    return deadlines.has(o.id) ? { ...settled, internalShipByAt: deadlines.get(o.id) ?? null } : settled;
  }

  /**
   * FR-INT-07: these orders stop holding stock, because their store was disconnected and nothing will
   * ship them through OmniSeller any more; each order's history says so. Statuses stay as they were.
   * Returns the lines released.
   */
  async releaseForDisconnectIn(tx: Tx, ctx: RequestContext, orderIds: string[]): Promise<number> {
    const held = (await this.repo.items(tx, orderIds)).filter((i) => i.reservedQty > 0);
    await this.inventory.orderMovementsIn(
      tx,
      ctx,
      held
        .filter((i) => i.variantId && i.warehouseId)
        .map((i) => ({
          orderItemId: i.id,
          variantId: i.variantId!,
          warehouseId: i.warehouseId!,
          type: "order_release" as const,
          qty: i.reservedQty,
        })),
    );
    for (const i of held) await this.repo.updateItem(tx, i.id, { reservedQty: 0 });
    for (const orderId of [...new Set(held.map((i) => i.orderId))]) {
      const units = held.filter((i) => i.orderId === orderId).reduce((n, i) => n + i.reservedQty, 0);
      await this.event(
        tx,
        ctx,
        orderId,
        "store_disconnected",
        { type: "system", id: null },
        { payload: { released: units } },
      );
    }
    return held.length;
  }

  /** A listing got a variant: lines that sold it get the variant, then reservations and problems follow. */
  async attachListingIn(tx: Tx, ctx: RequestContext, listingId: string): Promise<string[]> {
    const [listing] = await this.listings.listingsByIdsIn(tx, [listingId]);
    if (!listing?.variantId) return [];
    // a disconnected store's orders no longer hold stock (FR-INT-07)
    if ((await this.stores.disconnectedIdsIn(tx)).has(listing.storeId)) return [];
    const items = await this.repo.unmappedItemsFor(tx, listing);
    const orderIds = [...new Set(items.map((i) => i.orderId))].sort();
    for (const orderId of orderIds) {
      const o = await this.repo.get(tx, orderId, true);
      if (!o) continue;
      for (const i of items.filter((x) => x.orderId === orderId)) {
        await this.repo.updateItem(tx, i.id, { listingId: listing.id, variantId: listing.variantId });
      }
      await this.settleIn(tx, ctx, o, await this.repo.items(tx, [orderId]));
    }
    return orderIds;
  }

  /** Stock changed: orders short of these items may no longer be. */
  async recheckStockIn(
    tx: Tx,
    ctx: RequestContext,
    pairs: { variantId: string; warehouseId: string }[],
  ): Promise<number> {
    const ids = (await this.repo.ordersWithOpenProblemOn(tx, "insufficient_stock", pairs)).sort();
    const detached = ids.length > 0 ? await this.stores.disconnectedIdsIn(tx) : new Set<string>();
    let settled = 0;
    for (const id of ids) {
      const o = await this.repo.get(tx, id, true);
      // a disconnected store's orders no longer hold stock (FR-INT-07)
      if (!o || detached.has(o.storeId)) continue;
      await this.settleIn(tx, ctx, o, await this.repo.items(tx, [id]));
      settled++;
    }
    return settled;
  }
}
