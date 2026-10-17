import type { CommercePrincipalKind } from "@omniseller/connector-core";
import { bigint, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, tstz, ulid } from "../columns";
export const commerceFile = pgTable("commerce_file", {
  ...baseColumns(),
  operationId: text("operation_id").notNull(),
  principalKind: text("principal_kind").$type<CommercePrincipalKind>().notNull(),
  storeId: ulid("store_id"),
  accountId: ulid("account_id"),
  fileId: ulid("file_id"),
  createdBy: ulid("created_by"),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  expiresAt: tstz("expires_at").notNull(),
});
