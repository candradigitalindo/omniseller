/**
 * Status values mirrored from the CHECK constraints in backend/drizzle/migrations.
 * Allowed transitions live only in the database (`<table>_status_transition`, enforced by trigger).
 */
export const ORDER_STATUSES = [
  "unpaid",
  "new",
  "problem",
  "ready_to_pack",
  "packed",
  "ready_to_ship",
  "shipped",
  "delivered",
  "completed",
  "return_in_progress",
  "returned",
  "marketplace_fulfilled",
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const SHIPMENT_STATUSES = [
  "pending",
  "arranged",
  "label_ready",
  "packed",
  "handed_over",
  "in_transit",
  "delivered",
  "failed",
  "rto_in_transit",
  "rto_received",
  "cancelled",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const SYNC_JOB_STATUSES = ["queued", "running", "succeeded", "failed", "skipped"] as const;
export type SyncJobStatus = (typeof SYNC_JOB_STATUSES)[number];

export const DOCUMENT_JOB_STATUSES = ["queued", "running", "ready", "failed"] as const;
export type DocumentJobStatus = (typeof DOCUMENT_JOB_STATUSES)[number];

export const DATA_EXPORT_STATUSES = DOCUMENT_JOB_STATUSES;
export type DataExportStatus = DocumentJobStatus;

/** Imports from another app (backend doc 7.9, 8.19). */
export const MIGRATION_JOB_STATUSES = [
  "uploaded",
  "validating",
  "validated",
  "invalid",
  "importing",
  "imported",
  "failed",
] as const;
export type MigrationJobStatus = (typeof MIGRATION_JOB_STATUSES)[number];

/** The app a migration file comes from; `omniseller` is OmniSeller's own template (PRD 18.2). */
export const MIGRATION_SOURCE_APPS = ["omniseller", "bigseller", "ginee", "jubelio", "spreadsheet", "other"] as const;
export type MigrationSourceApp = (typeof MIGRATION_SOURCE_APPS)[number];

/** A print job for a print agent (FR-SHP-17, backend doc 8.24): `sent` once the agent took the file. */
export const PRINT_JOB_STATUSES = ["queued", "sent", "printed", "failed", "cancelled"] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

/** A courier handover manifest (FR-SHP-05, backend doc 8.24). */
export const HANDOVER_STATUSES = ["open", "completed", "cancelled"] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];

/** Copying listings into drafts for another store (FR-PRD-13, backend doc 8.25). */
export const LISTING_COPY_STATUSES = ["preparing", "ready", "failed", "cancelled"] as const;
export type ListingCopyStatus = (typeof LISTING_COPY_STATUSES)[number];

/** A copied listing reviewed before it is created in the target store (FR-PRD-13). */
export const LISTING_DRAFT_STATUSES = ["preparing", "draft", "publishing", "published", "failed"] as const;
export type ListingDraftStatus = (typeof LISTING_DRAFT_STATUSES)[number];

/**
 * A buyer's return, refund, or cancellation request, or a parcel coming back (FR-RET-01, 06; backend
 * doc 8.26). refunded, cancelled, and closed are final; a marketplace may open a request again.
 */
export const RETURN_REQUEST_STATUSES = [
  "requested",
  "negotiating",
  "accepted",
  "in_transit",
  "rejected",
  "disputed",
  "refunded",
  "cancelled",
  "closed",
] as const;
export type ReturnRequestStatus = (typeof RETURN_REQUEST_STATUSES)[number];

export const RETURN_KINDS = ["return_refund", "refund_only", "replacement", "exchange", "cancellation", "rto"] as const;
export type ReturnRequestKind = (typeof RETURN_KINDS)[number];

/** A stock count (FR-STK-08): counted, reviewed, applied by the worker; cancelled before that. */
export const STOCK_COUNT_STATUSES = ["counting", "review", "applied", "cancelled"] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];

/** A stock transfer between warehouses (FR-STK-09). */
export const STOCK_TRANSFER_STATUSES = ["draft", "sent", "received", "cancelled"] as const;
export type StockTransferStatus = (typeof STOCK_TRANSFER_STATUSES)[number];

/** A tenure of a plan (PRD 15.1, backend doc 8.32): trialing or paid, late, then ended by lapse or choice. */
export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "expired", "cancelled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** A subscription invoice paid through Xendit (backend doc 8.32); void: withdrawn before payment. */
export const INVOICE_STATUSES = ["pending", "paid", "expired", "failed", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** A store's switch from parallel mode to OmniSeller (FR-MIG-06); undone within 24 hours. */
export const STORE_CUTOVER_STATUSES = ["done", "undone"] as const;
export type StoreCutoverStatus = (typeof STORE_CUTOVER_STATUSES)[number];

export const CHANNELS = ["shopee", "tiktokshop", "lazada", "blibli", "shopify", "woocommerce", "manual"] as const;
export type Channel = (typeof CHANNELS)[number];

export const STOCK_MOVEMENT_TYPES = [
  "order_reserve",
  "order_release",
  "order_ship",
  "return_restock",
  "return_quarantine",
  "adjustment",
  "count_apply",
  "transfer_out",
  "transfer_in",
  "purchase_receipt",
  "quarantine_in",
  "quarantine_out",
  "campaign_hold",
  "campaign_release",
  "migration_initial",
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/** Reasons for a manual stock adjustment (FR-STK-05): the API takes the code, screens show the label. */
export const STOCK_ADJUSTMENT_REASONS = {
  damaged: "Rusak",
  lost: "Hilang",
  correction: "Koreksi",
  sample: "Sampel",
  other: "Lainnya",
} as const;
export type StockAdjustmentReason = keyof typeof STOCK_ADJUSTMENT_REASONS;

/**
 * Who is asking for a status change. Marketplace-driven changes may skip seller-side steps
 * (for example `ready_to_pack -> shipped` when the courier picks up a parcel that was never scanned).
 */
export type StatusSource = "app" | "marketplace";

export const LISTING_PRICE_CHANGE_STATUSES = ["queued", "processing", "succeeded", "failed", "cancelled"] as const;
