import { bigint, customType, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Column helpers for the Drizzle mirror of the SQL schema.
 * The SQL migrations in drizzle/migrations are the source of truth for constraints (composite tenant
 * FKs, CHECKs, partitions); these definitions give queries their types, and test/schema verifies that
 * both agree column by column.
 */

/** The `ulid` domain: text COLLATE "C" constrained to 26 Crockford base32 characters. */
export const ulid = customType<{ data: string; driverData: string }>({
  dataType() {
    return "ulid";
  },
});

/** Binary data (encrypted tokens and keys). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Whole rupiah. pg returns int8 as a string; mode "number" converts and the int8 parser rejects unsafe values. */
export const money = (name: string) => bigint(name, { mode: "number" });

export const qty = (name: string) => bigint(name, { mode: "number" });

/** id, tenant_id, created_at, updated_at, row_version (backend doc 7.2, invariant I5). */
export const baseColumns = () => ({
  id: ulid("id").primaryKey(),
  tenantId: ulid("tenant_id").notNull(),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
  rowVersion: integer("row_version").notNull().default(1),
});

/** Append-only tables (ledgers, events): no updated_at / row_version. */
export const appendOnlyColumns = () => ({
  id: ulid("id").primaryKey(),
  tenantId: ulid("tenant_id").notNull(),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

/** Global mutable tables (no tenant_id). */
export const globalColumns = () => ({
  id: ulid("id").primaryKey(),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
  rowVersion: integer("row_version").notNull().default(1),
});
