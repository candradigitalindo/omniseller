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
