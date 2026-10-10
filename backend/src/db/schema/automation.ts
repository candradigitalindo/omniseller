import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, ulid } from "../columns";

/** What an order must be for a rule to act on it; an empty list means any (backend doc 8.37). */
export interface OrderRuleConditions {
  storeIds?: string[];
  couriers?: string[];
  warehouseIds?: string[];
  skus?: string[];
  items?: "any" | "single" | "multiple";
  minTotal?: number | null;
  maxTotal?: number | null;
  withinOperatingHours?: boolean;
}

/** What a rule does, in this order: warehouse, tags, accept, arrange (which accepts on the way). */
export interface OrderRuleActions {
  warehouseId?: string | null;
  tagIds?: string[];
  accept?: boolean;
  arrange?: "pickup" | "dropoff" | null;
}

/** Automatic order processing rules (PRD FR-ORD-19, migration 0028). */
export const orderRule = pgTable("order_rule", {
  ...baseColumns(),
  name: text("name").notNull(),
  priority: integer("priority").notNull(),
  active: boolean("active").notNull().default(true),
  conditions: jsonb("conditions").$type<OrderRuleConditions>().notNull().default({}),
  actions: jsonb("actions").$type<OrderRuleActions>().notNull(),
  createdBy: ulid("created_by"),
});
