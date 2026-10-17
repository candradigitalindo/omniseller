import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, bytea } from "../columns";

export const marketplaceApplication = pgTable("marketplace_application", {
  ...baseColumns(),
  channel: text("channel").$type<"shopee" | "tiktokshop">().notNull(),
  environment: text("environment").$type<"production" | "sandbox">().notNull().default("production"),
  enabled: boolean("enabled").notNull().default(true),
  partnerId: text("partner_id"),
  appKey: text("app_key"),
  serviceId: text("service_id"),
  secretEnc: bytea("secret_enc"),
});
