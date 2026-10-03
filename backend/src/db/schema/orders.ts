import type { Channel, OrderStatus, ShipmentStatus } from "@omniseller/shared";
import { boolean, char, integer, jsonb, pgTable, smallint, text } from "drizzle-orm/pg-core";
import { appendOnlyColumns, baseColumns, money, tstz, ulid } from "../columns";

export const tag = pgTable("tag", {
  ...baseColumns(),
  name: text("name").notNull(),
  color: text("color"),
  deletedAt: tstz("deleted_at"),
});

export const pickWave = pgTable("pick_wave", {
  ...baseColumns(),
  warehouseId: ulid("warehouse_id").notNull(),
  status: text("status").$type<"open" | "picking" | "done" | "cancelled">().notNull().default("open"),
  createdBy: ulid("created_by"),
  orderCount: integer("order_count").notNull().default(0),
  note: text("note"),
});

export interface ShippingAddress {
  name?: string;
  phone?: string;
  line1?: string;
  district?: string;
  city?: string;
  province?: string;
  postalCode?: string;
}

/** Partitioned monthly on id. Status changes are checked by the order_status_transition trigger. */
export const order = pgTable("order", {
  ...baseColumns(),
  storeId: ulid("store_id").notNull(),
  channel: text("channel").$type<Channel>().notNull(),
  externalOrderId: text("external_order_id").notNull(),
  externalStatus: text("external_status"),
  status: text("status").$type<OrderStatus>().notNull(),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  fulfillmentMode: text("fulfillment_mode").$type<"seller" | "marketplace">().notNull().default("seller"),
  channelWarehouseId: ulid("channel_warehouse_id"),
  warehouseId: ulid("warehouse_id"),
  pickWaveId: ulid("pick_wave_id"),
  customerId: ulid("customer_id"),
  isCod: boolean("is_cod").notNull().default(false),
  isDropship: boolean("is_dropship").notNull().default(false),
  dropshipSender: jsonb("dropship_sender").$type<{ name: string; phone: string }>(),
  buyerUsername: text("buyer_username"),
  buyerName: text("buyer_name"),
  buyerPhone: text("buyer_phone"),
  shippingAddress: jsonb("shipping_address").$type<ShippingAddress>(),
  shippingProvider: text("shipping_provider"),
  shippingService: text("shipping_service"),
  shippingServiceType: text("shipping_service_type").$type<"regular" | "next_day" | "same_day" | "instant">(),
  trackingNumber: text("tracking_number"),
  shipByAt: tstz("ship_by_at"),
  internalShipByAt: tstz("internal_ship_by_at"),
  orderedAt: tstz("ordered_at").notNull(),
  paidAt: tstz("paid_at"),
  shippedAt: tstz("shipped_at"),
  deliveredAt: tstz("delivered_at"),
  completedAt: tstz("completed_at"),
  cancelledAt: tstz("cancelled_at"),
  cancelReason: text("cancel_reason"),
  cancelledBy: text("cancelled_by").$type<"buyer" | "seller" | "marketplace" | "system">(),
  subtotal: money("subtotal").notNull().default(0),
  discountTotal: money("discount_total").notNull().default(0),
  shippingFeeBuyer: money("shipping_fee_buyer").notNull().default(0),
  voucherSeller: money("voucher_seller").notNull().default(0),
  total: money("total").notNull(),
  currency: char("currency", { length: 3 }).notNull().default("IDR"),
  buyerNote: text("buyer_note"),
  internalNote: text("internal_note"),
  source: text("source").$type<"webhook" | "poll" | "manual" | "link" | "distribution" | "migration">().notNull(),
  riskScore: smallint("risk_score"),
  problemCount: integer("problem_count").notNull().default(0),
  rawPayloadRef: text("raw_payload_ref"),
  /** Marketplace update time of the stored snapshot; older snapshots are ignored. */
  externalUpdatedAt: tstz("external_updated_at"),
  /** TikTok Shop commerce_platform in Indonesia: TIKTOK_SHOP or TOKOPEDIA. */
  platform: text("platform"),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  externalBuyerId: text("external_buyer_id"),
});

/** Enforces (store_id, external_order_id) uniqueness, which the partitioned order table cannot. */
export const orderExternalRef = pgTable("order_external_ref", {
  ...appendOnlyColumns(),
  storeId: ulid("store_id").notNull(),
  externalOrderId: text("external_order_id").notNull(),
  orderId: ulid("order_id").notNull(),
});

export const orderItem = pgTable("order_item", {
  ...baseColumns(),
  orderId: ulid("order_id").notNull(),
  externalItemId: text("external_item_id").notNull(),
  listingId: ulid("listing_id"),
  variantId: ulid("variant_id"),
  skuSnapshot: text("sku_snapshot").notNull(),
  titleSnapshot: text("title_snapshot").notNull(),
  variantSnapshot: jsonb("variant_snapshot").$type<Record<string, unknown>>().notNull().default({}),
  qty: integer("qty").notNull(),
  unitPrice: money("unit_price").notNull().default(0),
  discount: money("discount").notNull().default(0),
  lineTotal: money("line_total").notNull().default(0),
  warehouseId: ulid("warehouse_id"),
  reservedQty: integer("reserved_qty").notNull().default(0),
  shippedQty: integer("shipped_qty").notNull().default(0),
  returnedQty: integer("returned_qty").notNull().default(0),
  externalProductId: text("external_product_id"),
  externalSkuId: text("external_sku_id"),
  cancelledQty: integer("cancelled_qty").notNull().default(0),
});

export const orderEvent = pgTable("order_event", {
  ...appendOnlyColumns(),
  orderId: ulid("order_id").notNull(),
  type: text("type").notNull(),
  fromStatus: text("from_status").$type<OrderStatus>(),
  toStatus: text("to_status").$type<OrderStatus>(),
  actorType: text("actor_type").$type<"user" | "system" | "marketplace" | "device" | "api_key">().notNull(),
  actorId: ulid("actor_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
});

export type OrderProblemCode =
  | "unmapped_sku"
  | "insufficient_stock"
  | "unmapped_warehouse"
  | "address_incomplete"
  | "duplicate"
  | "watchlist"
  | "high_value"
  | "fulfillment_conflict";

export const orderProblem = pgTable("order_problem", {
  ...baseColumns(),
  orderId: ulid("order_id").notNull(),
  code: text("code").$type<OrderProblemCode>().notNull(),
  detail: jsonb("detail").$type<Record<string, unknown>>(),
  resolvedAt: tstz("resolved_at"),
  resolvedBy: ulid("resolved_by"),
  resolution: text("resolution"),
});

export const orderTag = pgTable("order_tag", {
  ...baseColumns(),
  orderId: ulid("order_id").notNull(),
  tagId: ulid("tag_id").notNull(),
});

export const shipment = pgTable("shipment", {
  ...baseColumns(),
  orderId: ulid("order_id").notNull(),
  status: text("status").$type<ShipmentStatus>().notNull().default("pending"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  provider: text("provider"),
  service: text("service"),
  externalShipmentId: text("external_shipment_id"),
  trackingNumber: text("tracking_number"),
  labelFileId: ulid("label_file_id"),
  pickupType: text("pickup_type").$type<"pickup" | "dropoff">(),
  pickupAt: tstz("pickup_at"),
  packedAt: tstz("packed_at"),
  handedOverAt: tstz("handed_over_at"),
  deliveredAt: tstz("delivered_at"),
  failedAt: tstz("failed_at"),
  rtoAt: tstz("rto_at"),
  rtoReceivedAt: tstz("rto_received_at"),
  packedBy: ulid("packed_by"),
  handedOverBy: ulid("handed_over_by"),
  failedReason: text("failed_reason"),
  insured: boolean("insured").notNull().default(false),
  insuredValue: money("insured_value"),
  shippingCostActual: money("shipping_cost_actual"),
  weightG: integer("weight_g"),
  dims: jsonb("dims").$type<{ lengthMm: number; widthMm: number; heightMm: number }>(),
  packageCount: integer("package_count").notNull().default(1),
});

export const shipmentPackage = pgTable("shipment_package", {
  ...baseColumns(),
  shipmentId: ulid("shipment_id").notNull(),
  externalPackageId: text("external_package_id"),
  trackingNumber: text("tracking_number"),
  items: jsonb("items").$type<{ orderItemId: string; qty: number }[]>().notNull(),
  labelFileId: ulid("label_file_id"),
});

export const printJob = pgTable("print_job", {
  ...baseColumns(),
  deviceId: ulid("device_id").notNull(),
  kind: text("kind").$type<"label" | "pick_list" | "packing_list" | "invoice" | "barcode" | "manifest">().notNull(),
  fileObjectId: ulid("file_object_id").notNull(),
  printerName: text("printer_name"),
  copies: smallint("copies").notNull().default(1),
  status: text("status").$type<"queued" | "sent" | "printed" | "failed" | "cancelled">().notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  requestedBy: ulid("requested_by"),
  printedAt: tstz("printed_at"),
});
