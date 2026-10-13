import { boolean, date, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
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

/** What a user wants per kind of notification (UI L44); no row means the kind's default. */
export const notificationPreference = pgTable("notification_preference", {
  ...baseColumns(),
  userId: ulid("user_id").notNull(),
  kind: text("kind").notNull(),
  inApp: boolean("in_app").notNull().default(true),
  email: boolean("email").notNull().default(false),
  whatsapp: boolean("whatsapp").notNull().default(false),
});

/** One daily operational email run per business and local date (PRD FR-NTF-02). */
export const dailyDigest = pgTable("daily_digest", {
  ...baseColumns(),
  digestDate: date("digest_date", { mode: "string" }).notNull(),
  recipients: integer("recipients").notNull().default(0),
});

/** One scheduled report email run per business, cadence, and period (PRD FR-RPT-05, backend doc 8.20). */
export const reportScheduleRun = pgTable("report_schedule_run", {
  ...baseColumns(),
  cadence: text("cadence").$type<"weekly" | "monthly">().notNull(),
  periodStart: date("period_start", { mode: "string" }).notNull(),
  periodEnd: date("period_end", { mode: "string" }).notNull(),
  recipients: integer("recipients").notNull().default(0),
});
