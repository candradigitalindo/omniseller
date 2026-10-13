import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, tstz, ulid } from "../columns";
import type { AutoPrintIntent } from "./orders";

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

/** The label a rule prints once the shipment's label is ready (FR-SHP-18): on which agent, and how. */
export interface OrderRulePrint {
  deviceId: string;
  format?: "thermal" | "a4";
  template?: "standard" | "custom";
  packingList?: boolean;
}

/**
 * What a rule does, in this order: warehouse, tags, accept, arrange (which accepts on the way). `arrangeAt`
 * sends the arrange request at that business-local time instead of at once; `print` prints the label
 * when it is ready. Both only with `arrange`.
 */
export interface OrderRuleActions {
  warehouseId?: string | null;
  tagIds?: string[];
  accept?: boolean;
  arrange?: "pickup" | "dropoff" | null;
  arrangeAt?: string | null;
  print?: OrderRulePrint | null;
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

/**
 * An order whose rule arranges the shipment at a time of day, waiting for that time (backend doc 8.37,
 * migration 0029). Short-lived: the row goes when the arrange is requested, refused, or skipped.
 */
export const orderRuleSchedule = pgTable("order_rule_schedule", {
  ...baseColumns(),
  orderId: ulid("order_id").notNull(),
  ruleId: ulid("rule_id"),
  method: text("method").$type<"pickup" | "dropoff">().notNull(),
  dueAt: tstz("due_at").notNull(),
  print: jsonb("print").$type<AutoPrintIntent>(),
  attempts: integer("attempts").notNull().default(0),
  claimedAt: tstz("claimed_at"),
});
