import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";

export type BillingState = components["schemas"]["BillingStateDto_Output"];
export type Invoice = BillingState["invoices"][number];
export type Plan = BillingState["plans"][number];
export type SubscriptionStatus = BillingState["status"];
export type InvoiceStatus = Invoice["status"];
export type UsageMetric = keyof BillingState["usage"];

export const USAGE_METRICS = ["orders", "stores", "warehouses", "users"] as const satisfies readonly UsageMetric[];

/** Xendit's payment method codes named under `billing.method_*`; other codes are shown as Xendit sent them. */
export const PAYMENT_METHODS = [
  "BANK_TRANSFER",
  "EWALLET",
  "QR_CODE",
  "CREDIT_CARD",
  "RETAIL_OUTLET",
  "DIRECT_DEBIT",
  "PAYLATER",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function paymentMethodOf(code: string | null): PaymentMethod | null {
  return (PAYMENT_METHODS as readonly string[]).includes(code ?? "") ? (code as PaymentMethod) : null;
}

export const STATUS_TONE: Record<SubscriptionStatus, Tone> = {
  trialing: "info",
  active: "success",
  past_due: "danger",
  expired: "neutral",
  cancelled: "neutral",
};

export const INVOICE_TONE: Record<InvoiceStatus, Tone> = {
  pending: "warning",
  paid: "success",
  expired: "neutral",
  failed: "danger",
  void: "neutral",
};

/** How much of a quota is used, 0 to 100 and over; null when the plan does not limit it. */
export function usagePct(value: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit <= 0) return value > 0 ? 100 : 0;
  return Math.round((value / limit) * 100);
}

/** The bar's color: plain until 80%, a warning to 100%, danger past the quota (the api warns at both). */
export function usageTone(pct: number | null): "ok" | "warning" | "danger" {
  if (pct === null || pct < 80) return "ok";
  return pct >= 100 ? "danger" : "warning";
}

/** Whole days from now to a moment, counting a part of a day as one; 0 for today or earlier. */
export function daysLeft(at: string, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((Date.parse(at) - now.getTime()) / 86_400_000));
}

/**
 * Whether an invoice may be withdrawn by hand: a move up, or the month after a trial. A paid plan's
 * renewal goes away when another plan is chosen (backend doc 8.32).
 */
export function canVoid(invoice: Pick<Invoice, "kind" | "status">, state: Pick<BillingState, "status">): boolean {
  return invoice.status === "pending" && (invoice.kind === "upgrade" || state.status === "trialing");
}

export type PlanAction =
  /** The plan in force, renewing: nothing to choose. */
  | { kind: "current" }
  /** The plan in force, with a change scheduled: calling it off. */
  | { kind: "stay" }
  /** The trial's plan: paying for the month after the trial. */
  | { kind: "keep" }
  /** The plan in force, past due, with nothing to pay yet: a new invoice. */
  | { kind: "renew" }
  /** Takes over when the current period ends (chosen, or paid already). */
  | { kind: "scheduled"; at: string }
  /** Its invoice waits: pay it. */
  | { kind: "pending"; invoice: Invoice }
  /** A pricier plan from when it is paid, less what is left of a paid period. */
  | { kind: "upgrade" }
  /** Another paid plan from when it is paid: from a trial, Starter, or an unpaid period. */
  | { kind: "switch" }
  /** A cheaper plan, Starter included, from the end of the paid period (asks first). */
  | { kind: "at_end" }
  /** The free plan from now: there is no paid period to wait for (asks first). */
  | { kind: "free_now" }
  /** The next period is paid already: no change until it begins. */
  | { kind: "locked"; from: string };

/** What a plan card's button does, given the subscription; the api decides the same way (`planChoice`). */
export function planAction(state: BillingState, plan: Plan): PlanAction {
  const current = state.plan;
  if (state.pendingInvoice?.planCode === plan.code) return { kind: "pending", invoice: state.pendingInvoice };
  const prepaid = state.prepaidInvoice;
  if (prepaid) {
    if (plan.code === current.code) return { kind: "current" };
    return plan.code === prepaid.planCode
      ? { kind: "scheduled", at: prepaid.periodStart }
      : { kind: "locked", from: prepaid.periodStart };
  }
  if (state.nextPlan?.code === plan.code && state.currentPeriodEnd) {
    return { kind: "scheduled", at: state.currentPeriodEnd };
  }
  if (plan.code === current.code) {
    if (state.status === "trialing") return { kind: "keep" };
    if (state.status === "past_due") return { kind: "renew" };
    return state.nextPlan ? { kind: "stay" } : { kind: "current" };
  }
  const paidPeriod = state.status === "active" && state.currentPeriodEnd !== null && current.priceMonthly > 0;
  if (paidPeriod && plan.priceMonthly < current.priceMonthly) return { kind: "at_end" };
  if (plan.priceMonthly === 0) return { kind: "free_now" };
  return plan.priceMonthly > current.priceMonthly ? { kind: "upgrade" } : { kind: "switch" };
}

/** A choice that needs Xendit in this environment: anything that ends in an invoice. */
export function actionNeedsPayments(action: PlanAction, plan: Pick<Plan, "priceMonthly">): boolean {
  if (action.kind === "at_end") return plan.priceMonthly > 0;
  return action.kind === "keep" || action.kind === "renew" || action.kind === "upgrade" || action.kind === "switch";
}

/** Choices that are confirmed first: they change the quotas the business works with. */
export function asksFirst(action: PlanAction): boolean {
  return action.kind === "at_end" || action.kind === "free_now";
}

/** The current plan's standing in one sentence: which message, with what. */
export type PeriodNote =
  | { key: "trialEnds"; date: string; days: number }
  | { key: "trialPaid"; date: string }
  | { key: "pastDue"; date: string }
  | { key: "prepaid"; plan: string; date: string; until: string }
  | { key: "endsOn"; date: string; next: string }
  | { key: "renewsOn"; date: string }
  | { key: "freePlan" };

export function periodNote(state: BillingState, now: Date = new Date()): PeriodNote {
  const end = state.currentPeriodEnd;
  const prepaid = state.prepaidInvoice;
  if (state.status === "trialing" && end) {
    return prepaid ? { key: "trialPaid", date: end } : { key: "trialEnds", date: end, days: daysLeft(end, now) };
  }
  if (state.status === "past_due" && state.lapsesAt) return { key: "pastDue", date: state.lapsesAt };
  if (!end) return { key: "freePlan" };
  if (prepaid) return { key: "prepaid", plan: prepaid.planName, date: prepaid.periodStart, until: prepaid.periodEnd };
  if (state.nextPlan) return { key: "endsOn", date: end, next: state.nextPlan.name };
  return { key: "renewsOn", date: end };
}
