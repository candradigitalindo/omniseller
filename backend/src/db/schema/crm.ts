import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, money, tstz } from "../columns";

export const customer = pgTable("customer", {
  ...baseColumns(),
  channel: text("channel").notNull(),
  externalBuyerId: text("external_buyer_id").notNull(),
  displayName: text("display_name"),
  phoneMasked: text("phone_masked"),
  totalOrders: integer("total_orders").notNull().default(0),
  totalSpent: money("total_spent").notNull().default(0),
  firstOrderAt: tstz("first_order_at"),
  lastOrderAt: tstz("last_order_at"),
  watchlist: boolean("watchlist").notNull().default(false),
  watchlistReason: text("watchlist_reason"),
  watchlistUntil: tstz("watchlist_until"),
  deletedAt: tstz("deleted_at"),
});
