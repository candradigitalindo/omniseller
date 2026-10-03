import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, tstz, ulid } from "../columns";

export type NotificationSeverity = "info" | "warning" | "critical";

/** In-app notifications (backend doc 7.8.12, PRD FR-NTF-01), one row per recipient. */
export const notification = pgTable("notification", {
  ...baseColumns(),
  /** NULL: every user of the tenant. */
  userId: ulid("user_id"),
  kind: text("kind").notNull(),
  severity: text("severity").$type<NotificationSeverity>().notNull().default("info"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  channelsSent: jsonb("channels_sent").$type<Record<string, unknown>>().notNull().default({}),
  readAt: tstz("read_at"),
});
