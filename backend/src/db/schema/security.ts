import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, bytea, tstz } from "../columns";

/**
 * Tenant data encryption keys (technology doc 19.3). The DEK is stored wrapped by the KMS key (or the
 * local master key in local and test); only the worker can read this table.
 */
export const tenantKey = pgTable("tenant_key", {
  ...baseColumns(),
  version: integer("version").notNull(),
  provider: text("provider").$type<"local" | "aws_kms">().notNull(),
  keyRef: text("key_ref").notNull(),
  wrappedDek: bytea("wrapped_dek").notNull(),
  retiredAt: tstz("retired_at"),
});
