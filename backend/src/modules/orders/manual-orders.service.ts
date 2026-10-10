import { Inject, Injectable } from "@nestjs/common";
import { newId, newIdAt, type OrderStatus } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { nextDocumentNumber } from "../../common/document-number";
import { claimIdempotencyKey, requestHash } from "../../common/idempotency";
import { localDate } from "../../common/time-zone";
import type { DbHandle, Tx } from "../../db/client";
import type { PaymentMethod, ShippingAddress } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { isManualChannel, StoresService } from "../channel/stores.service";
import { TenantsService } from "../identity/tenants.service";
import { InventoryService } from "../inventory/inventory.service";
import { type Actor, OrderIntakeService } from "./order-intake.service";
import { manualOrderNumber, manualTotals, pathTo, SHIPPED_STATUSES } from "./order-plan";
import {
  buyerDataAnonymized,
  discountTooLarge,
  notManual,
  noWarehouse,
  orderHasProblems,
  orderStatusInvalid,
  orderUnpaid,
  orderWarehouseNotFound,
  orderWithoutAddress,
  recipientPhoneMissing,
  variantUnavailable,
} from "./orders.errors";
import type { OrderRow } from "./orders.repository";
import { OrdersRepository } from "./orders.repository";
import { OrdersService, orderStatusLabel } from "./orders.service";

export interface ManualAddress {
  name?: string | undefined;
  phone?: string | undefined;
  line1: string;
  district?: string | undefined;
  city?: string | undefined;
  province?: string | undefined;
  postalCode?: string | undefined;
}

export interface ManualOrderInput {
  /** Manual sales channel; the first one (created on demand) when absent. */
  storeId?: string | undefined;
  /** Chosen warehouse; allocated automatically (FR-ORD-12) when absent. */
  warehouseId?: string | undefined;
  buyer: { name: string; phone?: string | undefined };
  /** Null: no delivery (picked up, sold over the counter). */
  shippingAddress?: ManualAddress | null | undefined;
  items: { variantId: string; qty: number; unitPrice?: number | undefined }[];
  shippingFee: number;
  discount: number;
  paymentMethod: PaymentMethod;
  /** Paid already; cash by default. COD orders are paid on delivery. */
  paid?: boolean | undefined;
  shippingProvider?: string | undefined;
  shippingService?: string | undefined;
  buyerNote?: string | undefined;
  internalNote?: string | undefined;
  orderedAt?: Date | undefined;
}

export interface ManualOrderPatch {
  buyer?: { name?: string | undefined; phone?: string | null | undefined } | undefined;
  shippingAddress?: ManualAddress | null | undefined;
  shippingProvider?: string | null | undefined;
  shippingService?: string | null | undefined;
  trackingNumber?: string | null | undefined;
  buyerNote?: string | null | undefined;
}

const FINISHED: ReadonlySet<OrderStatus> = new Set(["completed", "cancelled", "returned", "return_in_progress"]);

function addressOf(a: ManualAddress, buyer: { name: string; phone: string | null }): ShippingAddress {
  return {
    name: a.name ?? buyer.name,
    ...((a.phone ?? buyer.phone) ? { phone: a.phone ?? buyer.phone! } : {}),
    line1: a.line1,
    ...(a.district ? { district: a.district } : {}),
    ...(a.city ? { city: a.city } : {}),
    ...(a.province ? { province: a.province } : {}),
    ...(a.postalCode ? { postalCode: a.postalCode } : {}),
  };
}

/**
 * Manual orders (PRD FR-ORD-09, 12, backend doc 8.21): sales outside marketplaces (WhatsApp, Instagram,
 * a shop counter) entered by the seller, in a sales channel of channel `manual`. They join the same
 * queue as marketplace orders, reserve stock at once in the warehouse the seller chose or the one
 * allocation found, and are processed by the seller from end to end: paid, accepted and packed with the
 * bulk actions, shipped with a tracking number, completed. Cancelling happens in OrdersService.
 */
@Injectable()
export class ManualOrdersService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrdersRepository) private readonly repo: OrdersRepository,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(OrderIntakeService) private readonly intake: OrderIntakeService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  /**
   * Creates the order and reserves its stock. With an Idempotency-Key, a repeated request (double click,
   * retry after a lost response) returns the first request's order instead of creating another.
   */
  async create(
    ctx: RequestContext,
    input: ManualOrderInput,
    idempotencyKey?: string,
  ): Promise<{ orderId: string; created: boolean }> {
    const timezone = await this.tenants.timezone(ctx);
    const now = new Date();
    const orderedAt = input.orderedAt ?? now;
    const id = newIdAt(orderedAt);
    return withTenantTx(this.db, ctx, async (tx) => {
      if (idempotencyKey) {
        const earlier = await claimIdempotencyKey(tx, ctx, {
          scope: "order.manual",
          key: idempotencyKey,
          hash: requestHash(input),
          resourceId: id,
        });
        if (earlier) return { orderId: earlier, created: false };
      }
      const store = await this.stores.manualStoreIn(tx, ctx, input.storeId);
      const variants = await this.inventory.variantsIn(
        tx,
        input.items.map((i) => i.variantId),
      );
      input.items.forEach((item, i) => {
        const v = variants.get(item.variantId);
        if (v?.variantStatus !== "active" || v.productStatus !== "active") {
          throw variantUnavailable(`items.${i}.variantId`);
        }
      });
      const address = input.shippingAddress ?? null;
      if (address && !(address.phone ?? input.buyer.phone)) throw recipientPhoneMissing();

      let warehouseId: string;
      let allocation: string;
      if (input.warehouseId) {
        if ((await this.inventory.warehousesIn(tx, ctx, input.warehouseId)).length === 0) {
          throw orderWarehouseNotFound("warehouseId");
        }
        warehouseId = input.warehouseId;
        allocation = "chosen";
      } else {
        const a = await this.inventory.allocateIn(tx, {
          lines: input.items,
          buyerProvince: address?.province ?? null,
          home: store.defaultWarehouseId,
          within: ctx.warehouseScope,
        });
        if (!a.warehouseId) throw noWarehouse();
        warehouseId = a.warehouseId;
        allocation = a.reason;
      }

      const lines = input.items.map((item) => {
        const v = variants.get(item.variantId)!;
        return { item, v, unitPrice: item.unitPrice ?? v.basePrice };
      });
      const { subtotal, total } = manualTotals(
        lines.map((l) => ({ unitPrice: l.unitPrice, qty: l.item.qty })),
        input.discount,
        input.shippingFee,
      );
      if (input.discount > subtotal) throw discountTooLarge();

      const period = localDate(timezone, now).slice(2, 7).replace("-", "");
      const number = manualOrderNumber(period, await nextDocumentNumber(tx, ctx.tenantId, "manual_order", period));
      const cod = input.paymentMethod === "cod";
      const paid = !cod && (input.paid ?? input.paymentMethod === "cash");
      const status: OrderStatus = cod || paid ? "new" : "unpaid";
      const buyer = { name: input.buyer.name, phone: input.buyer.phone ?? null };

      const o = await this.intake.createIn(tx, ctx, {
        order: {
          id,
          tenantId: ctx.tenantId,
          storeId: store.id,
          channel: "manual",
          externalOrderId: number,
          status,
          fulfillmentMode: "seller",
          warehouseId,
          isCod: cod,
          paymentMethod: input.paymentMethod,
          buyerName: buyer.name,
          buyerPhone: buyer.phone,
          shippingAddress: address ? addressOf(address, buyer) : null,
          shippingProvider: input.shippingProvider ?? null,
          shippingService: input.shippingService ?? null,
          orderedAt,
          paidAt: paid ? orderedAt : null,
          subtotal,
          discountTotal: input.discount,
          shippingFeeBuyer: input.shippingFee,
          total,
          buyerNote: input.buyerNote ?? null,
          internalNote: input.internalNote ?? null,
          source: "manual",
          // no "new order" notification (FR-NTF-01): someone in the team typed it in
          notifyNew: false,
        },
        items: lines.map((l) => ({
          id: newId(),
          tenantId: ctx.tenantId,
          orderId: id,
          externalItemId: l.v.variantId,
          variantId: l.v.variantId,
          skuSnapshot: l.v.sku,
          titleSnapshot: l.v.productName,
          variantSnapshot: {
            ...(l.v.variantName !== l.v.productName ? { name: l.v.variantName } : {}),
            ...(l.v.imageUrl ? { imageUrl: l.v.imageUrl } : {}),
            ...(l.unitPrice !== l.v.basePrice ? { originalUnitPrice: l.v.basePrice } : {}),
          },
          qty: l.item.qty,
          unitPrice: l.unitPrice,
          discount: 0,
          lineTotal: l.unitPrice * l.item.qty,
          warehouseId,
        })),
        actor: this.actor(ctx),
        payload: { source: "manual", number, allocation, paymentMethod: input.paymentMethod },
      });
      return { orderId: o.id, created: true };
    });
  }

  /**
   * Buyer, address, courier, tracking number, buyer's note. Buyer and address change only until the
   * order is shipped; nothing changes on a finished order. History records which fields changed, not
   * their values (they are personal data).
   */
  async update(ctx: RequestContext, id: string, patch: ManualOrderPatch): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const o = await this.loadManual(tx, ctx, id);
      if (FINISHED.has(o.status)) throw orderStatusInvalid(orderStatusLabel(o.status), "yang belum selesai");
      const touchesBuyer = patch.buyer !== undefined || patch.shippingAddress !== undefined;
      if (touchesBuyer && SHIPPED_STATUSES.has(o.status)) {
        throw orderStatusInvalid(orderStatusLabel(o.status), "yang belum dikirim");
      }
      if (o.buyerAnonymizedAt && (touchesBuyer || patch.buyerNote !== undefined)) throw buyerDataAnonymized();
      const buyer = {
        name: patch.buyer?.name ?? o.buyerName ?? "",
        phone: patch.buyer?.phone !== undefined ? patch.buyer.phone : o.buyerPhone,
      };
      const current = o.shippingAddress;
      const address =
        patch.shippingAddress === undefined
          ? current
            ? addressOf({ ...current, line1: current.line1 ?? "" }, buyer)
            : null
          : patch.shippingAddress
            ? addressOf(patch.shippingAddress, buyer)
            : null;
      if (address && !address.phone) throw recipientPhoneMissing();
      const changes = {
        ...(patch.buyer?.name !== undefined ? { buyerName: buyer.name } : {}),
        ...(patch.buyer?.phone !== undefined ? { buyerPhone: buyer.phone } : {}),
        ...(touchesBuyer ? { shippingAddress: address } : {}),
        ...(patch.shippingProvider !== undefined ? { shippingProvider: patch.shippingProvider } : {}),
        ...(patch.shippingService !== undefined ? { shippingService: patch.shippingService } : {}),
        ...(patch.trackingNumber !== undefined ? { trackingNumber: patch.trackingNumber } : {}),
        ...(patch.buyerNote !== undefined ? { buyerNote: patch.buyerNote } : {}),
      };
      if (Object.keys(changes).length === 0) return;
      await this.repo.update(tx, id, changes);
      await this.intake.recordIn(tx, ctx, id, "details_changed", this.actor(ctx), { fields: Object.keys(changes) });
    });
  }

  /** "Tandai dibayar": a manual order waiting for its money becomes new (FR-ORD-09). */
  async markPaid(ctx: RequestContext, id: string, paidAt?: Date): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const o = await this.loadManual(tx, ctx, id);
      if (o.status !== "unpaid") throw orderStatusInvalid(orderStatusLabel(o.status), "Belum Dibayar");
      const at = paidAt ?? new Date();
      await this.repo.update(tx, id, { paidAt: at });
      const moved = await this.intake.stepIn(
        tx,
        ctx,
        { ...o, paidAt: at },
        [{ to: "new", via: "any" }],
        this.actor(ctx),
      );
      await this.intake.settleIn(tx, ctx, moved, await this.repo.items(tx, [id]));
    });
  }

  /**
   * "Kirim": the parcel went to the courier (or the seller's own delivery), with the courier and the
   * tracking number when there is one. Every seller step on the way is recorded; the reserved units
   * leave the warehouse.
   */
  async ship(
    ctx: RequestContext,
    id: string,
    input: { shippingProvider?: string | undefined; trackingNumber?: string | undefined },
  ): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      await this.shipIn(tx, ctx, await this.loadManual(tx, ctx, id), input);
    });
  }

  /**
   * "Kirim" in the caller's transaction, for a manual order the caller loaded and locked (the courier
   * handover, FR-SHP-05, ships every manual order of its manifest).
   */
  async shipIn(
    tx: Tx,
    ctx: RequestContext,
    o: OrderRow,
    input: {
      shippingProvider?: string | undefined;
      trackingNumber?: string | undefined;
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!isManualChannel(o.channel)) throw notManual();
    this.ready(o);
    if (!o.shippingAddress) throw orderWithoutAddress();
    const steps = pathTo(o.status, "shipped");
    if (!steps) throw orderStatusInvalid(orderStatusLabel(o.status), "yang belum dikirim");
    const info = {
      ...(input.shippingProvider ? { shippingProvider: input.shippingProvider } : {}),
      ...(input.trackingNumber ? { trackingNumber: input.trackingNumber } : {}),
    };
    await this.repo.update(tx, o.id, info);
    const moved = await this.intake.stepIn(tx, ctx, { ...o, ...info }, steps, this.actor(ctx), {
      ...info,
      ...input.payload,
    });
    await this.intake.settleIn(tx, ctx, moved, await this.repo.items(tx, [o.id]));
  }

  /**
   * "Selesai": the buyer has the goods. A shipped order completes; an order without a shipping address
   * (picked up, sold over the counter) completes from any step before shipping. COD money counts as
   * received.
   */
  async complete(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const o = await this.loadManual(tx, ctx, id);
      this.ready(o);
      const sent = o.status === "shipped" || o.status === "delivered";
      if (!sent && o.shippingAddress) throw orderStatusInvalid(orderStatusLabel(o.status), "Dikirim atau Terkirim");
      const steps = pathTo(o.status, "completed");
      if (!steps) throw orderStatusInvalid(orderStatusLabel(o.status), "yang belum selesai");
      const paid = o.isCod && !o.paidAt ? { paidAt: new Date() } : {};
      await this.repo.update(tx, id, paid);
      const moved = await this.intake.stepIn(tx, ctx, { ...o, ...paid }, steps, this.actor(ctx));
      await this.intake.settleIn(tx, ctx, moved, await this.repo.items(tx, [id]));
    });
  }

  private actor(ctx: RequestContext): Actor {
    return { type: "user", id: ctx.actor.id };
  }

  private async loadManual(tx: Tx, ctx: RequestContext, id: string): Promise<OrderRow> {
    const o = await this.orders.visibleIn(tx, ctx, id, true);
    if (!isManualChannel(o.channel)) throw notManual();
    return o;
  }

  /** Paid (or cash on delivery) and without open problems. */
  private ready(o: OrderRow): void {
    if (o.status === "unpaid") throw orderUnpaid();
    if (o.status === "problem") throw orderHasProblems();
  }
}
