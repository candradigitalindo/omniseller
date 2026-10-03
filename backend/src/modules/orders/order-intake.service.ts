import { Inject, Injectable } from "@nestjs/common";
import type { NormalizedOrder, NormalizedOrderItem, NormalizedRecipient } from "@omniseller/connector-core";
import { newId, newIdAt, type OrderStatus } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { Tx } from "../../db/client";
import type { OrderProblemCode } from "../../db/schema";
import { withStatusSource } from "../../db/tenant-tx";
import { OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { ListingsService } from "../catalog/listings.service";
import type { ChannelWarehouseRow } from "../channel/channel.repository";
import type { StockTarget } from "../channel/stores.service";
import { InventoryService, type OrderStockMove } from "../inventory/inventory.service";
import {
  detectProblems,
  HIGH_VALUE_RUPIAH,
  HOLD_STATUSES,
  initialStatus,
  itemStockPlan,
  problemStep,
  type StatusStep,
  statusSteps,
} from "./order-plan";
import { orderStatusChanged } from "./orders.events";
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

const MARKETPLACE: Actor = { type: "marketplace", id: null };

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
      const patch = {
        status: step.to,
        ...(step.to === "completed" && !current.completedAt ? { completedAt: at } : {}),
        ...(step.to === "cancelled" && !current.cancelledAt ? { cancelledAt: at } : {}),
        ...(step.to === "shipped" && !current.shippedAt ? { shippedAt: at } : {}),
        ...(step.to === "delivered" && !current.deliveredAt ? { deliveredAt: at } : {}),
        // paid now: a new order for the seller (FR-NTF-01)
        ...(step.to === "new" && current.status === "unpaid" && current.fulfillmentMode === "seller"
          ? { notifyNew: true }
          : {}),
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
      await this.repo.insertOrder(tx, {
        id,
        tenantId: ctx.tenantId,
        storeId: store.id,
        channel: store.channel,
        externalOrderId: snap.externalOrderId,
        status,
        fulfillmentMode: fulfillment,
        channelWarehouseId: orderPlace.channelWarehouseId,
        warehouseId: orderPlace.warehouseId,
        orderedAt: snap.createdAt,
        completedAt: status === "completed" ? snap.updatedAt : null,
        // the 90-day import is history, not news: only orders after it are announced (FR-NTF-01)
        notifyNew: fulfillment === "seller" && status === "new" && store.lastOrderSyncAt !== null,
        source: meta.source,
        rawPayloadRef: meta.rawRef ?? null,
        ...fields,
      });
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
        payload: { externalStatus: snap.externalStatus, source: meta.source },
      });
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
    await this.repo.update(tx, existingId, fields);
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
      { ...current, ...fields },
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
    return step ? this.stepIn(tx, ctx, current, [step], { type: "system", id: null }) : current;
  }

  /** A listing got a variant: lines that sold it get the variant, then reservations and problems follow. */
  async attachListingIn(tx: Tx, ctx: RequestContext, listingId: string): Promise<string[]> {
    const [listing] = await this.listings.listingsByIdsIn(tx, [listingId]);
    if (!listing?.variantId) return [];
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
    for (const id of ids) {
      const o = await this.repo.get(tx, id, true);
      if (o) await this.settleIn(tx, ctx, o, await this.repo.items(tx, [id]));
    }
    return ids.length;
  }
}
