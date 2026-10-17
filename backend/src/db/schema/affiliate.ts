import type { OpenCampaignProductQuery } from "@omniseller/connector-core";
import type { AffiliateQueryStatus } from "@omniseller/shared";
import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, tstz, ulid } from "../columns";

export interface AffiliateProductSnapshot {
  externalItemId: string;
  title: string;
  externalCampaignId: string;
  status: "upcoming" | "ongoing" | "terminating" | "unknown";
  externalStatus: string;
  commissionBasisPoints: number;
  startsAt: string;
  endsAt: string | null;
  pendingTerminationAt: string | null;
  protections: { commissionBasisPoints: number; endsAt: string }[];
  maxCommissionBasisPointsToday: number | null;
}
export const affiliateProductQuery = pgTable("affiliate_product_query", {
  ...baseColumns(),
  storeId: ulid("store_id").notNull(),
  requestedBy: ulid("requested_by"),
  query: jsonb("query").$type<OpenCampaignProductQuery>().notNull(),
  items: jsonb("items").$type<AffiliateProductSnapshot[]>().notNull().default([]),
  total: integer("total"),
  nextCursor: text("next_cursor"),
  status: text("status").$type<AffiliateQueryStatus>().notNull().default("queued"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  claimId: ulid("claim_id"),
  claimedAt: tstz("claimed_at"),
  finishedAt: tstz("finished_at"),
  expiresAt: tstz("expires_at").notNull(),
});
