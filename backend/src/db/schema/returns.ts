import type { ReturnRequestKind, ReturnRequestStatus } from "@omniseller/shared";
import { boolean, char, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, money, tstz, ulid } from "../columns";

// ---- buyers' return, refund, and cancellation requests (PRD FR-RET-01..07, backend doc 8.26) ----

/** A photo or video of a request, as the marketplace serves it. */
export interface ReturnEvidenceEntry {
  type: "image" | "video";
  url: string;
  thumbnailUrl: string | null;
  by: "buyer" | "seller" | "marketplace";
}

/** A decision the seller may take, as the worker read it from the marketplace (connector ReturnDecision). */
export interface ReturnDecisionOption {
  code: string;
  action: "accept" | "reject";
  label: string;
  reasons: {
    code: string;
    label: string;
    evidence: { module: number; requirement: string; required: boolean }[];
  }[];
  needsEmail: boolean;
}

/** A photo the seller uploaded for a rejection. */
export interface SellerEvidenceFile {
  fileId: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  uploadedBy: string | null;
}

/** What the seller decided, kept until it is sent; the email goes once it is. */
export interface ReturnResponseDetail {
  label: string;
  reason: string | null;
  reasonLabel: string | null;
  comment: string | null;
  evidence: { fileId: string; module: number | null }[];
  email?: string | null;
}

export const returnRequest = pgTable("return_request", {
  ...baseColumns(),
  storeId: ulid("store_id").notNull(),
  orderId: ulid("order_id").notNull(),
  warehouseId: ulid("warehouse_id"),
  kind: text("kind").$type<ReturnRequestKind>().notNull(),
  externalReturnId: text("external_return_id"),
  status: text("status").$type<ReturnRequestStatus>().notNull(),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  externalStatus: text("external_status"),
  initiator: text("initiator").$type<"buyer" | "seller" | "marketplace">(),
  reasonCode: text("reason_code"),
  reason: text("reason"),
  evidence: jsonb("evidence").$type<ReturnEvidenceEntry[]>().notNull().default([]),
  refundAmount: money("refund_amount"),
  currency: char("currency", { length: 3 }).notNull().default("IDR"),
  respondByAt: tstz("respond_by_at"),
  sellerAction: text("seller_action"),
  goodsReturn: boolean("goods_return").notNull().default(false),
  returnTrackingNumber: text("return_tracking_number"),
  returnCarrier: text("return_carrier"),
  externalCreatedAt: tstz("external_created_at"),
  externalUpdatedAt: tstz("external_updated_at"),
  decisions: jsonb("decisions").$type<ReturnDecisionOption[]>(),
  decisionsFor: text("decisions_for"),
  decisionsReadAt: tstz("decisions_read_at"),
  decisionsClaimedAt: tstz("decisions_claimed_at"),
  sellerEvidence: jsonb("seller_evidence").$type<SellerEvidenceFile[]>().notNull().default([]),
  decision: text("decision"),
  decisionAction: text("decision_action").$type<"accept" | "reject">(),
  decidedFor: text("decided_for"),
  responseStatus: text("response_status").$type<"pending" | "sent" | "failed">(),
  response: jsonb("response").$type<ReturnResponseDetail>(),
  responseAttempt: integer("response_attempt").notNull().default(0),
  responseError: text("response_error"),
  decidedAt: tstz("decided_at"),
  decidedBy: ulid("decided_by"),
  receivedAt: tstz("received_at"),
  receivedBy: ulid("received_by"),
  receivedWarehouseId: ulid("received_warehouse_id"),
  receiptNote: text("receipt_note"),
  notifyNew: boolean("notify_new").notNull().default(false),
  dueAlertedAt: tstz("due_alerted_at"),
});

export const returnItem = pgTable("return_item", {
  ...baseColumns(),
  returnRequestId: ulid("return_request_id").notNull(),
  orderItemId: ulid("order_item_id"),
  externalItemId: text("external_item_id").notNull().default(""),
  externalVariantId: text("external_variant_id").notNull().default(""),
  sku: text("sku"),
  title: text("title"),
  qty: integer("qty").notNull(),
  refundAmount: money("refund_amount"),
  sellableQty: integer("sellable_qty"),
  damagedQty: integer("damaged_qty"),
  missingQty: integer("missing_qty"),
  receivedAt: tstz("received_at"),
});
