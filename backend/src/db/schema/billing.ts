import { boolean, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { globalColumns, money } from "../columns";

export interface PlanLimits {
  stores: number | null;
  warehouses: number | null;
  orders_per_month: number | null;
  users: number | null;
}

export const plan = pgTable("plan", {
  ...globalColumns(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  limits: jsonb("limits")
    .$type<PlanLimits>()
    .notNull()
    .default({ stores: null, warehouses: null, orders_per_month: null, users: null }),
  features: text("features").array().notNull().default([]),
  priceMonthly: money("price_monthly").notNull().default(0),
  active: boolean("active").notNull().default(true),
});
