import type { InvoiceStatus, SubscriptionStatus } from "@omniseller/shared";
import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, globalColumns, money, qty, tstz, ulid } from "../columns";

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

/** The last reminder sent for a subscription's period: the trial ending, the renewal invoice, past due. */
export type SubscriptionReminderStage = "ending" | "due" | "past_due";

/**
 * One tenure of one plan (backend doc 8.32): a 14-day trial of Growth, a paid month that renews, or the
 * free Starter plan (no period end). A tenant has one live row (trialing, active, past_due); ended rows
 * stay as history. `tenant.plan_id` is the plan in force and follows the live row.
 */
export const subscription = pgTable("subscription", {
  ...baseColumns(),
  planId: ulid("plan_id").notNull(),
  status: text("status").$type<SubscriptionStatus>().notNull(),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  currentPeriodStart: tstz("current_period_start").notNull(),
  currentPeriodEnd: tstz("current_period_end"),
  nextPlanId: ulid("next_plan_id"),
  remindedStage: text("reminded_stage").$type<SubscriptionReminderStage>(),
  endedAt: tstz("ended_at"),
});

/** `renewal`: the period after the current one; `upgrade`: a pricier plan from the moment it is paid. */
export type InvoiceKind = "renewal" | "upgrade";

/** A payment asked for one period of one plan: created here, paid on Xendit's page, confirmed by callback. */
export const invoice = pgTable("invoice", {
  ...baseColumns(),
  subscriptionId: ulid("subscription_id").notNull(),
  planId: ulid("plan_id").notNull(),
  number: text("number").notNull(),
  kind: text("kind").$type<InvoiceKind>().notNull(),
  status: text("status").$type<InvoiceStatus>().notNull().default("pending"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  amount: money("amount").notNull(),
  creditAmount: money("credit_amount").notNull().default(0),
  periodStart: tstz("period_start").notNull(),
  periodEnd: tstz("period_end").notNull(),
  dueAt: tstz("due_at").notNull(),
  paidAt: tstz("paid_at"),
  paidAmount: money("paid_amount"),
  paymentMethod: text("payment_method"),
  paymentChannel: text("payment_channel"),
  externalInvoiceId: text("external_invoice_id"),
  invoiceUrl: text("invoice_url"),
  invoiceExpiresAt: tstz("invoice_expires_at"),
  error: text("error"),
  requestedBy: ulid("requested_by"),
});

/** What the business used in a month of its own time zone (`orders`), against the plan's quota. */
export const usageCounter = pgTable("usage_counter", {
  ...baseColumns(),
  metric: text("metric").notNull(),
  period: text("period").notNull(),
  value: qty("value").notNull().default(0),
  warnedPct: integer("warned_pct").notNull().default(0),
});
