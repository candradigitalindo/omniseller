import { inet, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { appendOnlyColumns, ulid } from "../columns";

/** Append only (trigger audit_log_immutable); rows are written by the audit_row() trigger, never by the app. */
export const auditLog = pgTable("audit_log", {
  ...appendOnlyColumns(),
  actorType: text("actor_type").$type<"user" | "system" | "api_key" | "device">().notNull(),
  actorId: text("actor_id"),
  requestId: text("request_id"),
  action: text("action").$type<"insert" | "update" | "delete">().notNull(),
  entityType: text("entity_type").notNull(),
  entityId: ulid("entity_id").notNull(),
  before: jsonb("before").$type<Record<string, unknown>>(),
  after: jsonb("after").$type<Record<string, unknown>>(),
  ip: inet("ip"),
});
