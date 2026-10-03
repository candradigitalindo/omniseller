import {
  type CancelReason,
  type NormalizedOrder,
  type NormalizedOrderItem,
  type NormalizedPackage,
  type OrderPage,
  type OrderState,
  type PackageState,
  type ShippingServiceType,
  type ShopCredentials,
  toRupiah,
} from "@omniseller/connector-core";
import type { ShopeeClient } from "./client.js";

/**
 * Shopee order APIs (v2.order):
 * - get_order_list: order_sn by create_time or update_time, at most 15 days per request, 100 per page
 *   with a cursor; `request_order_status_pending` opts in to the PENDING status
 * - get_order_detail: up to 50 orders, the rest of the fields through response_optional_fields
 * - cancel_order: before the order ships; OUT_OF_STOCK names the items
 *
 * Statuses: UNPAID, PENDING (paid, held by Shopee), READY_TO_SHIP, PROCESSED (shipment arranged),
 * RETRY_SHIP, SHIPPED, TO_CONFIRM_RECEIVE (delivered), COMPLETED, IN_CANCEL (buyer asked to cancel),
 * CANCELLED, TO_RETURN, INVOICE_PENDING (Brazil).
 */
const WINDOW_SECONDS = 15 * 86_400 - 60;
const PAGE_SIZE = 100;
const DETAIL_BATCH = 50;
const OPTIONAL_FIELDS = [
  "buyer_user_id",
  "buyer_username",
  "recipient_address",
  "item_list",
  "pay_time",
  "buyer_cancel_reason",
  "cancel_by",
  "cancel_reason",
  "fulfillment_flag",
  "pickup_done_time",
  "package_list",
  "shipping_carrier",
  "payment_method",
  "total_amount",
].join(",");

export const SHOPEE_ORDER_STATES: Record<string, OrderState> = {
  UNPAID: "unpaid",
  PENDING: "to_ship",
  READY_TO_SHIP: "to_ship",
  RETRY_SHIP: "to_ship",
  INVOICE_PENDING: "to_ship",
  IN_CANCEL: "to_ship",
  PROCESSED: "seller_processing",
  SHIPPED: "shipped",
  TO_CONFIRM_RECEIVE: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  TO_RETURN: "returning",
};

/**
 * Package fulfillment status (V2.0 Data Definition, PackageFulfillmentStatus / LogisticsStatus) to the
 * connector's package states. LOGISTICS_PICKUP_RETRY is ready again: the courier failed to pick up.
 */
export const SHOPEE_PACKAGE_STATES: Record<string, PackageState> = {
  LOGISTICS_NOT_START: "waiting",
  LOGISTICS_PENDING_ARRANGE: "waiting",
  LOGISTICS_READY: "ready",
  LOGISTICS_PICKUP_RETRY: "ready",
  LOGISTICS_REQUEST_CREATED: "arranged",
  LOGISTICS_PICKUP_DONE: "shipped",
  LOGISTICS_DELIVERY_DONE: "delivered",
  LOGISTICS_COD_REJECTED: "cancelled",
  LOGISTICS_INVALID: "cancelled",
  LOGISTICS_REQUEST_CANCELED: "cancelled",
  LOGISTICS_PICKUP_FAILED: "failed",
  LOGISTICS_DELIVERY_FAILED: "failed",
  LOGISTICS_LOST: "failed",
};

/** Statuses in which a seller may still cancel (cancel_order: "before the order has been shipped"). */
const CANCELLABLE = new Set(["UNPAID", "PENDING", "READY_TO_SHIP", "PROCESSED", "RETRY_SHIP"]);

export const SHOPEE_CANCEL_REASONS: readonly CancelReason[] = [
  { code: "OUT_OF_STOCK", label: "Stok habis", needsItems: true },
  { code: "CUSTOMER_REQUEST", label: "Permintaan pembeli", needsItems: false },
  { code: "COD_NOT_SUPPORTED", label: "COD tidak tersedia untuk alamat pembeli", needsItems: false },
];

interface ShopeeOrderItem {
  item_id?: number | string;
  item_name?: string;
  item_sku?: string;
  model_id?: number | string;
  model_name?: string;
  model_sku?: string;
  model_quantity_purchased?: number;
  model_original_price?: number;
  model_discounted_price?: number;
  line_item_id?: number | string;
  promotion_group_id?: number;
  image_info?: { image_url?: string };
  product_location_id?: string;
  cancelled_qty?: number;
}

interface ShopeeOrder {
  order_sn?: string;
  order_status?: string;
  currency?: string;
  cod?: boolean;
  total_amount?: number;
  shipping_carrier?: string;
  payment_method?: string;
  message_to_seller?: string;
  create_time?: number;
  update_time?: number;
  pay_time?: number;
  ship_by_date?: number;
  pickup_done_time?: number;
  buyer_user_id?: number | string;
  buyer_username?: string;
  recipient_address?: {
    name?: string;
    phone?: string;
    town?: string;
    district?: string;
    city?: string;
    state?: string;
    zipcode?: string;
    full_address?: string;
  };
  item_list?: ShopeeOrderItem[];
  cancel_by?: string;
  cancel_reason?: string;
  buyer_cancel_reason?: string;
  fulfillment_flag?: string;
  package_list?: ShopeePackage[];
}

export interface ShopeePackage {
  package_number?: string;
  logistics_status?: string;
  logistics_channel_id?: number | string;
  shipping_carrier?: string;
  item_list?: {
    item_id?: number | string;
    model_id?: number | string;
    model_quantity?: number;
    promotion_group_id?: number | string;
    product_location_id?: string;
  }[];
}

const at = (seconds: number | undefined): Date | null => (seconds && seconds > 0 ? new Date(seconds * 1000) : null);
const text = (s: string | undefined | null): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

/** Courier service names to the PRD's service types (FR-ORD-07): Instant, Same Day, Next Day, else regular. */
export function serviceTypeOf(name: string | null): ShippingServiceType | null {
  if (!name) return null;
  if (/instant/i.test(name)) return "instant";
  if (/same\s*-?day|sameday/i.test(name)) return "same_day";
  if (/next\s*-?day|nextday/i.test(name)) return "next_day";
  return "regular";
}

function cancelledBy(by: string | undefined): NormalizedOrder["cancelledBy"] {
  switch (by?.toLowerCase()) {
    case "buyer":
      return "buyer";
    case "seller":
      return "seller";
    case "system":
      return "system";
    case "ops":
      return "marketplace";
    default:
      return null;
  }
}

function items(o: ShopeeOrder): NormalizedOrderItem[] {
  const seen = new Map<string, number>();
  return (o.item_list ?? []).map((i) => {
    const itemId = String(i.item_id ?? "");
    const modelId = i.model_id !== undefined && String(i.model_id) !== "0" ? String(i.model_id) : "";
    let lineId = i.line_item_id ? String(i.line_item_id) : `${itemId}:${modelId || 0}:${i.promotion_group_id ?? 0}`;
    const n = (seen.get(lineId) ?? 0) + 1;
    seen.set(lineId, n);
    if (n > 1) lineId = `${lineId}#${n}`;
    const quantity = Math.max(1, Number(i.model_quantity_purchased ?? 1));
    const original = toRupiah(i.model_original_price);
    // bundle deal lines report 0 as discounted price: the discount is not split per item
    const discounted = i.model_discounted_price ? toRupiah(i.model_discounted_price) : null;
    const unit = discounted ?? original ?? 0;
    return {
      externalLineId: lineId,
      externalItemId: itemId,
      externalVariantId: modelId,
      sku: text(i.model_sku) ?? text(i.item_sku),
      title: text(i.item_name) ?? `Item ${itemId}`,
      variantName: text(i.model_name),
      imageUrl: text(i.image_info?.image_url),
      quantity,
      cancelledQuantity: Math.min(quantity, Math.max(0, Number(i.cancelled_qty ?? 0))),
      unitPrice: unit,
      originalUnitPrice: original,
      discount: original !== null && discounted !== null ? Math.max(0, (original - discounted) * quantity) : 0,
      lineTotal: unit * quantity,
      externalWarehouseId: text(i.product_location_id),
    };
  });
}

/** Order lines of each package: package items name item, model, and promotion group, not the line. */
function packages(o: ShopeeOrder, lines: NormalizedOrderItem[]): NormalizedPackage[] {
  const raw = o.item_list ?? [];
  const lineOf = (item: NonNullable<ShopeePackage["item_list"]>[number]): string | undefined => {
    const same = (i: ShopeeOrderItem) =>
      String(i.item_id ?? "") === String(item.item_id ?? "") && String(i.model_id ?? 0) === String(item.model_id ?? 0);
    const exact = raw.findIndex(
      (i) => same(i) && String(i.promotion_group_id ?? 0) === String(item.promotion_group_id ?? 0),
    );
    const index = exact >= 0 ? exact : raw.findIndex(same);
    return index >= 0 ? lines[index]?.externalLineId : undefined;
  };
  return (o.package_list ?? []).map((p) => {
    const status = p.logistics_status ?? "UNKNOWN";
    const units = new Map<string, number>();
    for (const item of p.item_list ?? []) {
      const line = lineOf(item);
      if (line) units.set(line, (units.get(line) ?? 0) + Math.max(1, Number(item.model_quantity ?? 1)));
    }
    return {
      externalPackageId: text(p.package_number) ?? "",
      state: SHOPEE_PACKAGE_STATES[status] ?? "waiting",
      externalStatus: status,
      trackingNumber: null,
      shippingProvider: text(p.shipping_carrier) ?? text(o.shipping_carrier),
      items: [...units].map(([externalLineId, quantity]) => ({ externalLineId, quantity })),
    };
  });
}

export function normalizeShopeeOrder(o: ShopeeOrder): NormalizedOrder {
  const status = o.order_status ?? "UNKNOWN";
  const state = SHOPEE_ORDER_STATES[status] ?? "to_ship";
  const lines = items(o);
  const subtotal = lines.reduce((n, l) => n + l.lineTotal, 0);
  const r = o.recipient_address;
  const carrier = text(o.shipping_carrier);
  return {
    externalOrderId: String(o.order_sn),
    state,
    externalStatus: status,
    platform: null,
    fulfillment: o.fulfillment_flag === "fulfilled_by_shopee" ? "marketplace" : "seller",
    cancelRequested: status === "IN_CANCEL",
    isCod: o.cod === true,
    createdAt: at(o.create_time) ?? new Date(),
    updatedAt: at(o.update_time) ?? at(o.create_time) ?? new Date(),
    paidAt: at(o.pay_time),
    shipByAt: at(o.ship_by_date),
    shippedAt: at(o.pickup_done_time),
    deliveredAt: null,
    cancelledAt: state === "cancelled" ? at(o.update_time) : null,
    cancelledBy: state === "cancelled" ? cancelledBy(o.cancel_by) : null,
    cancelReason: text(o.cancel_reason) ?? text(o.buyer_cancel_reason),
    buyerId: o.buyer_user_id ? String(o.buyer_user_id) : null,
    buyerUsername: text(o.buyer_username),
    recipientAvailable: state !== "unpaid",
    recipient: r
      ? {
          name: text(r.name),
          phone: text(r.phone),
          fullAddress: text(r.full_address),
          district: text(r.district),
          city: text(r.city),
          province: text(r.state),
          postalCode: text(r.zipcode),
        }
      : null,
    buyerNote: text(o.message_to_seller),
    shippingProvider: carrier,
    shippingService: carrier,
    shippingServiceType: serviceTypeOf(carrier),
    trackingNumber: null,
    externalWarehouseId: null,
    currency: o.currency || "IDR",
    subtotal,
    discountTotal: lines.reduce((n, l) => n + l.discount, 0),
    shippingFeeBuyer: 0,
    total: o.total_amount !== undefined ? (toRupiah(o.total_amount) ?? subtotal) : subtotal,
    items: lines,
    packages: packages(o, lines),
  };
}

interface ListResponse {
  response?: { order_list?: { order_sn?: string }[]; more?: boolean; next_cursor?: string };
}

interface DetailResponse {
  response?: { order_list?: ShopeeOrder[] };
}

/** Position in a long range: the start of the current 15-day window and Shopee's cursor inside it. */
interface Position {
  f: number;
  c: string;
}

export function shopeeOrders(client: ShopeeClient) {
  async function getOrders(shop: ShopCredentials, sns: string[]): Promise<NormalizedOrder[]> {
    const out: NormalizedOrder[] = [];
    const ids = [...new Set(sns.filter(Boolean))];
    for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
      const res = await client.shopCall<DetailResponse>(shop, "GET", "/api/v2/order/get_order_detail", {
        query: {
          order_sn_list: ids.slice(i, i + DETAIL_BATCH).join(","),
          response_optional_fields: OPTIONAL_FIELDS,
          request_order_status_pending: "true",
        },
      });
      for (const o of res.response?.order_list ?? []) if (o.order_sn) out.push(normalizeShopeeOrder(o));
    }
    return out;
  }

  return {
    async listOrders(
      shop: ShopCredentials,
      input: { by: "create_time" | "update_time"; from: Date; to: Date; cursor?: string | null },
    ): Promise<OrderPage> {
      const toSec = Math.floor(input.to.getTime() / 1000);
      const pos: Position = input.cursor
        ? (JSON.parse(input.cursor) as Position)
        : { f: Math.floor(input.from.getTime() / 1000), c: "" };
      if (pos.f >= toSec) return { orders: [], nextCursor: null };
      const windowTo = Math.min(pos.f + WINDOW_SECONDS, toSec);
      const res = await client.shopCall<ListResponse>(shop, "GET", "/api/v2/order/get_order_list", {
        query: {
          time_range_field: input.by,
          time_from: String(pos.f),
          time_to: String(windowTo),
          page_size: String(PAGE_SIZE),
          cursor: pos.c,
          response_optional_fields: "order_status",
          request_order_status_pending: "true",
        },
      });
      const sns = (res.response?.order_list ?? []).map((o) => o.order_sn ?? "");
      const orders = await getOrders(shop, sns);
      const next: Position | null =
        res.response?.more && res.response.next_cursor
          ? { f: pos.f, c: res.response.next_cursor }
          : windowTo < toSec
            ? { f: windowTo, c: "" }
            : null;
      return { orders, nextCursor: next ? JSON.stringify(next) : null };
    },

    getOrders,

    cancelReasons(externalStatus: string): CancelReason[] {
      return CANCELLABLE.has(externalStatus) ? [...SHOPEE_CANCEL_REASONS] : [];
    },

    async cancelOrder(
      shop: ShopCredentials,
      input: {
        externalOrderId: string;
        externalStatus: string;
        reason: string;
        items?: { externalItemId: string; externalVariantId: string; quantity: number }[];
      },
    ): Promise<void> {
      await client.shopCall(shop, "POST", "/api/v2/order/cancel_order", {
        body: {
          order_sn: input.externalOrderId,
          cancel_reason: input.reason,
          ...(input.reason === "OUT_OF_STOCK"
            ? {
                item_list: (input.items ?? []).map((i) => ({
                  item_id: Number(i.externalItemId),
                  model_id: Number(i.externalVariantId || 0),
                })),
              }
            : {}),
        },
      });
    },
  };
}
