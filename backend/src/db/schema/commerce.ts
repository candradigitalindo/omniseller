import type { CommerceInput, CommercePrincipalKind, CommerceResult } from "@omniseller/connector-core";
import type { CommerceStatus } from "@omniseller/shared";
import { boolean, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, tstz, ulid } from "../columns";

export type { CommerceStatus } from "@omniseller/shared";
export const commerceOperation = pgTable("commerce_operation", {
  ...baseColumns(),
  operationId: text("operation_id").notNull(),
  principalKind: text("principal_kind").$type<CommercePrincipalKind>().notNull(),
  storeId: ulid("store_id"),
  accountId: ulid("account_id"),
  requestedBy: ulid("requested_by"),
  isWrite: boolean("is_write").notNull(),
  input: jsonb("input").$type<CommerceInput>().notNull(),
  result: jsonb("result").$type<CommerceResult>(),
  status: text("status").$type<CommerceStatus>().notNull().default("queued"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  claimId: ulid("claim_id"),
  claimedAt: tstz("claimed_at"),
  dispatchedAt: tstz("dispatched_at"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  finishedAt: tstz("finished_at"),
  expiresAt: tstz("expires_at").notNull(),
});
