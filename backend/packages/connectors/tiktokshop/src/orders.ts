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
import type { TiktokShopClient } from "./client.js";

/**
 * TikTok Shop order APIs:
 * - Get Order List (POST /order/202309/orders/search): full orders, filtered by create or update time,
 *   up to 100 per page with page_token
 * - Get Order Detail (GET /order/202507/orders?ids=): up to 50 orders
 * - Cancel Order (POST /return_refund/202602/cancellations): seller cancellation with a reason valid
 *   for the order status (Indonesian list in "Cancel reasons")
 *
 * Every line item is one unit; units of one SKU are grouped into one order line here. In Indonesia an
 * order carries `commerce_platform` (TIKTOK_SHOP or TOKOPEDIA). The address is hidden while UNPAID and
 * ON_HOLD.
 */
const PAGE_SIZE = 50;
const DETAIL_BATCH = 50;

export const TIKTOK_ORDER_STATES: Record<string, OrderState> = {
  UNPAID: "unpaid",
  ON_HOLD: "to_ship",
  AWAITING_SHIPMENT: "to_ship",
  // some packages are on their way, others not yet: nothing has left completely
  PARTIALLY_SHIPPING: "seller_processing",
  AWAITING_COLLECTION: "seller_processing",
  IN_TRANSIT: "shipped",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  // the order status change webhook says CANCEL
  CANCEL: "cancelled",
};

/** Package status of a line item (Get Order Detail) or a package (Get Package Detail). */
export const TIKTOK_PACKAGE_STATES: Record<string, PackageState> = {
  TO_FULFILL: "ready",
  // spelled with a space in one place of Get Package Detail
  "TO FULFILL": "ready",
  PROCESSING: "arranged",
  FULFILLING: "shipped",
  COMPLETED: "delivered",
  CANCELLED: "cancelled",
};

/** Indonesian seller cancel reasons; "unable to deliver" was withdrawn for Indonesia on 31 Aug 2025. */
const UNPAID_REASONS: readonly CancelReason[] = [
  { code: "seller_cancel_unpaid_reason_out_of_stock", label: "Stok habis", needsItems: false },
  { code: "seller_cancel_unpaid_reason_wrong_price", label: "Kesalahan harga", needsItems: false },
  {
    code: "seller_cancel_unpaid_reason_buyer_hasnt_paid_within_time_allowed",
    label: "Pembeli tidak membayar tepat waktu",
    needsItems: false,
  },
];
const PAID_REASONS: readonly CancelReason[] = [
  // counted as the seller's fault in Indonesia since 31 Aug 2025
  { code: "seller_cancel_reason_out_of_stock", label: "Stok habis (dihitung kesalahan penjual)", needsItems: false },
  { code: "seller_cancel_reason_wrong_price", label: "Kesalahan harga", needsItems: false },
];

interface LineItem {
  id?: string;
  sku_id?: string;
  product_id?: string;
  product_name?: string;
  sku_name?: string;
  sku_image?: string;
  seller_sku?: string;
  original_price?: string;
  sale_price?: string;
  display_status?: string;
  package_id?: string;
  package_status?: string;
  tracking_number?: string;
  shipping_provider_name?: string;
}

export interface TiktokOrder {
  id?: string;
  status?: string;
  commerce_platform?: string;
  fulfillment_type?: string;
  is_buyer_request_cancel?: boolean;
  is_cod?: boolean;
  create_time?: number;
  update_time?: number;
  paid_time?: number;
  rts_sla_time?: number;
  tts_sla_time?: number;
  collection_time?: number;
  delivery_time?: number;
  cancel_time?: number;
  cancellation_initiator?: string;
  cancel_reason?: string;
  user_id?: string;
  buyer_nickname?: string;
  buyer_message?: string;
  recipient_address?: {
    name?: string;
    phone_number?: string;
    full_address?: string;
    address_detail?: string;
    postal_code?: string;
    district_info?: { address_level?: string; address_name?: string }[];
  };
  shipping_provider?: string;
  delivery_option_name?: string;
  tracking_number?: string;
  warehouse_id?: string;
  shipping_type?: string;
  packages?: { id?: string }[];
  payment?: {
    currency?: string;
    sub_total?: string;
    shipping_fee?: string;
    seller_discount?: string;
    platform_discount?: string;
    total_amount?: string;
  };
  line_items?: LineItem[];
}

const at = (seconds: number | undefined): Date | null => (seconds && seconds > 0 ? new Date(seconds * 1000) : null);
const text = (s: string | undefined | null): string | null => {
  const t = s?.trim();
  return t ? t : null;
};
const money = (s: string | undefined): number => toRupiah(s) ?? 0;

export function tiktokServiceType(name: string | null): ShippingServiceType | null {
  if (!name) return null;
  if (/instant/i.test(name)) return "instant";
  if (/same\s*-?day|sameday/i.test(name)) return "same_day";
  if (/next\s*-?day|nextday/i.test(name)) return "next_day";
  return "regular";
}

function cancelledBy(by: string | undefined): NormalizedOrder["cancelledBy"] {
  switch (by) {
    case "BUYER":
      return "buyer";
    case "SELLER":
      return "seller";
    case "SYSTEM":
      return "system";
    case "OPERATOR":
      return "marketplace";
    default:
      return null;
  }
}

function lines(o: TiktokOrder): NormalizedOrderItem[] {
  const bySku = new Map<string, LineItem[]>();
  for (const l of o.line_items ?? []) {
    const key = l.sku_id ?? l.id ?? "";
    bySku.set(key, [...(bySku.get(key) ?? []), l]);
  }
  return [...bySku.entries()].map(([skuId, units]) => {
    const first = units[0]!;
    const sale = units.reduce((n, u) => n + money(u.sale_price), 0);
    const original = units.reduce((n, u) => n + money(u.original_price ?? u.sale_price), 0);
    return {
      externalLineId: skuId,
      externalItemId: first.product_id ?? "",
      externalVariantId: skuId,
      sku: text(first.seller_sku),
      title: text(first.product_name) ?? `Produk ${first.product_id ?? ""}`,
      variantName: text(first.sku_name),
      imageUrl: text(first.sku_image),
      quantity: units.length,
      cancelledQuantity: units.filter((u) => u.display_status === "CANCELLED").length,
      unitPrice: Math.round(sale / units.length),
      originalUnitPrice: Math.round(original / units.length),
      discount: Math.max(0, original - sale),
      lineTotal: sale,
      externalWarehouseId: text(o.warehouse_id),
    };
  });
}

/** Packages from the order's package ids and the package fields of its line items (one per unit). */
function packages(o: TiktokOrder): NormalizedPackage[] {
  const ids = new Set<string>();
  for (const p of o.packages ?? []) if (p.id) ids.add(String(p.id));
  for (const l of o.line_items ?? []) if (l.package_id) ids.add(String(l.package_id));
  // the order is not ready while unpaid or in the buyer's remorse window, whatever the package says
  const held = o.status === "UNPAID" || o.status === "ON_HOLD";
  return [...ids].map((id) => {
    const units = (o.line_items ?? []).filter((l) => String(l.package_id ?? "") === id);
    const status = units.find((l) => l.package_status)?.package_status ?? "";
    const perLine = new Map<string, number>();
    for (const l of units) {
      const line = l.sku_id ?? l.id ?? "";
      perLine.set(line, (perLine.get(line) ?? 0) + 1);
    }
    return {
      externalPackageId: id,
      state: held ? "waiting" : (TIKTOK_PACKAGE_STATES[status] ?? "waiting"),
      externalStatus: status || (o.status ?? ""),
      trackingNumber: text(units.find((l) => l.tracking_number)?.tracking_number) ?? text(o.tracking_number),
      shippingProvider:
        text(units.find((l) => l.shipping_provider_name)?.shipping_provider_name) ?? text(o.shipping_provider),
      items: [...perLine].map(([externalLineId, quantity]) => ({ externalLineId, quantity })),
    };
  });
}

export function normalizeTiktokOrder(o: TiktokOrder): NormalizedOrder {
  const status = o.status ?? "UNKNOWN";
  const state = TIKTOK_ORDER_STATES[status] ?? "to_ship";
  const items = lines(o);
  const r = o.recipient_address;
  const level = (l: string) => text(r?.district_info?.find((d) => d.address_level === l)?.address_name);
  const service = text(o.delivery_option_name);
  const p = o.payment ?? {};
  return {
    externalOrderId: String(o.id),
    state,
    externalStatus: status,
    platform: text(o.commerce_platform),
    fulfillment:
      o.fulfillment_type === "FULFILLMENT_BY_TIKTOK" || o.fulfillment_type === "FULFILLMENT_BY_DILAYANI_TOKOPEDIA"
        ? "marketplace"
        : "seller",
    cancelRequested: o.is_buyer_request_cancel === true,
    isCod: o.is_cod === true,
    createdAt: at(o.create_time) ?? new Date(),
    updatedAt: at(o.update_time) ?? at(o.create_time) ?? new Date(),
    paidAt: at(o.paid_time),
    shipByAt: at(o.rts_sla_time) ?? at(o.tts_sla_time),
    shippedAt: at(o.collection_time),
    deliveredAt: at(o.delivery_time),
    cancelledAt: state === "cancelled" ? (at(o.cancel_time) ?? at(o.update_time)) : null,
    cancelledBy: state === "cancelled" ? cancelledBy(o.cancellation_initiator) : null,
    cancelReason: text(o.cancel_reason),
    buyerId: text(o.user_id),
    buyerUsername: text(o.buyer_nickname),
    recipientAvailable: status !== "UNPAID" && status !== "ON_HOLD",
    recipient: r
      ? {
          name: text(r.name),
          phone: text(r.phone_number),
          fullAddress: text(r.full_address) ?? text(r.address_detail),
          district: level("L3"),
          city: level("L2"),
          province: level("L1"),
          postalCode: text(r.postal_code),
        }
      : null,
    buyerNote: text(o.buyer_message),
    shippingProvider: text(o.shipping_provider),
    shippingService: service,
    shippingServiceType: tiktokServiceType(service),
    trackingNumber: text(o.tracking_number),
    externalWarehouseId: text(o.warehouse_id),
    currency: p.currency || "IDR",
    subtotal: p.sub_total !== undefined ? money(p.sub_total) : items.reduce((n, i) => n + i.lineTotal, 0),
    discountTotal: money(p.seller_discount) + money(p.platform_discount),
    shippingFeeBuyer: money(p.shipping_fee),
    total: p.total_amount !== undefined ? money(p.total_amount) : items.reduce((n, i) => n + i.lineTotal, 0),
    items,
    packages: packages(o),
  };
}

interface SearchData {
  orders?: TiktokOrder[];
  next_page_token?: string;
}

export function tiktokOrders(client: TiktokShopClient) {
  return {
    async listOrders(
      shop: ShopCredentials,
      input: { by: "create_time" | "update_time"; from: Date; to: Date; cursor?: string | null },
    ): Promise<OrderPage> {
      const range =
        input.by === "create_time"
          ? {
              create_time_ge: Math.floor(input.from.getTime() / 1000),
              create_time_lt: Math.floor(input.to.getTime() / 1000),
            }
          : {
              update_time_ge: Math.floor(input.from.getTime() / 1000),
              update_time_lt: Math.floor(input.to.getTime() / 1000),
            };
      const data = await client.call<SearchData>({
        method: "POST",
        path: "/order/202309/orders/search",
        accessToken: shop.accessToken,
        shopCipher: shop.shopCipher,
        query: {
          page_size: String(PAGE_SIZE),
          sort_field: input.by,
          sort_order: "ASC",
          ...(input.cursor ? { page_token: input.cursor } : {}),
        },
        body: range,
      });
      return {
        orders: (data.orders ?? []).filter((o) => o.id).map(normalizeTiktokOrder),
        nextCursor: data.next_page_token || null,
      };
    },

    async getOrders(shop: ShopCredentials, externalOrderIds: string[]): Promise<NormalizedOrder[]> {
      const out: NormalizedOrder[] = [];
      const ids = [...new Set(externalOrderIds.filter(Boolean))];
      for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
        const data = await client.call<{ orders?: TiktokOrder[] }>({
          method: "GET",
          path: "/order/202507/orders",
          accessToken: shop.accessToken,
          shopCipher: shop.shopCipher,
          query: { ids: ids.slice(i, i + DETAIL_BATCH).join(",") },
        });
        for (const o of data.orders ?? []) if (o.id) out.push(normalizeTiktokOrder(o));
      }
      return out;
    },

    cancelReasons(externalStatus: string): CancelReason[] {
      if (externalStatus === "UNPAID") return [...UNPAID_REASONS];
      if (externalStatus === "ON_HOLD" || externalStatus === "AWAITING_SHIPMENT") return [...PAID_REASONS];
      return [];
    },

    async cancelOrder(
      shop: ShopCredentials,
      input: { externalOrderId: string; externalStatus: string; reason: string },
    ): Promise<void> {
      await client.call({
        method: "POST",
        path: "/return_refund/202602/cancellations",
        accessToken: shop.accessToken,
        shopCipher: shop.shopCipher,
        body: { order_id: input.externalOrderId, cancel_reason: input.reason },
      });
    },
  };
}
