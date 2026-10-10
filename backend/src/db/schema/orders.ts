import type {
  Channel,
  DocumentJobStatus,
  HandoverStatus,
  OrderStatus,
  PrintJobStatus,
  ShipmentStatus,
} from "@omniseller/shared";
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

export const PAYMENT_METHODS = ["transfer", "cash", "ewallet", "cod", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

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
  /** Ship-by alerts already sent (FR-SHP-10). */
  slaAlertLevel: text("sla_alert_level").$type<"warning" | "overdue">(),
  /** Waits for the next new-order notification (FR-NTF-01). */
  notifyNew: boolean("notify_new").notNull().default(false),
  /** How a manual order is paid (FR-ORD-09); NULL for marketplace orders. */
  paymentMethod: text("payment_method").$type<PaymentMethod>(),
  /** When the buyer's personal data was anonymized (PRD 12.1, migration 0025); NULL while it is kept. */
  buyerAnonymizedAt: tstz("buyer_anonymized_at"),
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
  arrangedAt: tstz("arranged_at"),
  lastError: text("last_error"),
  insured: boolean("insured").notNull().default(false),
  insuredValue: money("insured_value"),
  shippingCostActual: money("shipping_cost_actual"),
  weightG: integer("weight_g"),
  dims: jsonb("dims").$type<{ lengthMm: number; widthMm: number; heightMm: number }>(),
  packageCount: integer("package_count").notNull().default(1),
  /** Where the parcel is, from the marketplace's tracking (FR-SHP-07, backend doc 8.22). */
  trackingStage: text("tracking_stage").$type<TrackingStage>(),
  /** Newest first; descriptions may name who received the parcel (personal data). */
  trackingEvents: jsonb("tracking_events").$type<StoredTrackingEvent[]>().notNull().default([]),
  trackingEventAt: tstz("tracking_event_at"),
  trackingSyncedAt: tstz("tracking_synced_at"),
  trackingError: text("tracking_error"),
});

export const TRACKING_STAGES = [
  "waiting_pickup",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "failed",
  "returning",
  "returned",
  "lost",
  "cancelled",
] as const;
export type TrackingStage = (typeof TRACKING_STAGES)[number];

export interface StoredTrackingEvent {
  /** ISO 8601. */
  at: string;
  description: string;
  code: string | null;
  stage: TrackingStage | null;
  /** Shopee package number of a split order's parcel. */
  packageId?: string;
  returnCode?: string;
}

/** The custom label template of a business (FR-SHP-16, UI L42). */
export const labelTemplate = pgTable("label_template", {
  ...baseColumns(),
  showSku: boolean("show_sku").notNull().default(true),
  showVariant: boolean("show_variant").notNull().default(true),
  showBin: boolean("show_bin").notNull().default(true),
  showBuyerNote: boolean("show_buyer_note").notNull().default(true),
  showTags: boolean("show_tags").notNull().default(false),
});

export const shipmentPackage = pgTable("shipment_package", {
  ...baseColumns(),
  shipmentId: ulid("shipment_id").notNull(),
  externalPackageId: text("external_package_id"),
  trackingNumber: text("tracking_number"),
  items: jsonb("items").$type<{ orderItemId: string; qty: number }[]>().notNull(),
  labelFileId: ulid("label_file_id"),
});

export type PrintJobKind = "label" | "pick_list" | "packing_list" | "invoice" | "barcode" | "manifest" | "test";

/**
 * What a print agent prints (backend doc 8.24). A job waits for its document (`document_id`) until the
 * worker attaches the file; status changes are checked by trigger.
 */
export const printJob = pgTable("print_job", {
  ...baseColumns(),
  deviceId: ulid("device_id").notNull(),
  kind: text("kind").$type<PrintJobKind>().notNull(),
  fileObjectId: ulid("file_object_id"),
  printerName: text("printer_name"),
  copies: smallint("copies").notNull().default(1),
  status: text("status").$type<PrintJobStatus>().notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  requestedBy: ulid("requested_by"),
  printedAt: tstz("printed_at"),
  documentId: ulid("document_id"),
  title: text("title").notNull().default(""),
  sentAt: tstz("sent_at"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
});

export type DocumentKind =
  | "labels"
  | "pick_list"
  | "packing_list"
  | "barcode_labels"
  | "handover_manifest"
  | "test_page";

export interface DocumentParams {
  /** Orders of label, pick list, and packing list documents; empty for barcode labels. */
  orderIds: string[];
  /** Labels and packing lists: thermal 100 x 150 mm, or A4 with 4 per page (FR-SHP-01, 03). */
  format?: "thermal" | "a4";
  /** Labels: `custom` adds the business's template under each marketplace label (FR-SHP-16). */
  template?: "standard" | "custom";
  /** Labels: each order's packing list right after its label (FR-SHP-03). */
  packingList?: boolean;
  /** Barcode labels (FR-PRD-12): which variants, how many labels each, in this order. */
  items?: { variantId: string; copies: number }[];
  /** Barcode labels: label stock or A4 sheet. */
  labelFormat?: "label_50x30" | "label_40x30" | "a4_3x10";
  /** Handover manifest (FR-SHP-05). */
  handoverId?: string;
  /** Test page of a print agent (UI L42): which computer and printer it was sent to. */
  device?: { name: string; printer: string | null };
}

export interface DocumentResult {
  orders?: number;
  labels?: number;
  /** Orders (or, for barcode labels, variants) left out, with the reason. */
  missing?: { orderId?: string; variantId?: string; code: string; message: string }[];
  /** Barcode labels: variants whose bars came out denser than two printer dots. */
  dense?: string[];
}

/** Printable documents the worker renders on request (backend doc 8.15). Status changes are checked by trigger. */
export const documentJob = pgTable("document_job", {
  ...baseColumns(),
  kind: text("kind").$type<DocumentKind>().notNull(),
  status: text("status").$type<DocumentJobStatus>().notNull().default("queued"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  params: jsonb("params").$type<DocumentParams>().notNull(),
  result: jsonb("result").$type<DocumentResult>().notNull().default({}),
  fileObjectId: ulid("file_object_id"),
  pageCount: integer("page_count"),
  error: text("error"),
  requestedBy: ulid("requested_by"),
  finishedAt: tstz("finished_at"),
});

/** Courier handover manifests (FR-SHP-05, backend doc 8.24): one open per warehouse and courier. */
export const handover = pgTable("handover", {
  ...baseColumns(),
  number: text("number").notNull(),
  warehouseId: ulid("warehouse_id").notNull(),
  courier: text("courier").notNull(),
  status: text("status").$type<HandoverStatus>().notNull().default("open"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  receivedBy: text("received_by"),
  createdBy: ulid("created_by"),
  completedBy: ulid("completed_by"),
  completedAt: tstz("completed_at"),
});

/** A parcel scanned into a manifest. */
export const handoverItem = pgTable("handover_item", {
  ...baseColumns(),
  handoverId: ulid("handover_id").notNull(),
  orderId: ulid("order_id").notNull(),
  shipmentId: ulid("shipment_id"),
  trackingNumber: text("tracking_number").notNull(),
  orderNumber: text("order_number").notNull(),
  scannedBy: ulid("scanned_by"),
});
