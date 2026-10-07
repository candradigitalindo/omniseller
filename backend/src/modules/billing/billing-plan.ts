import type { InvoiceStatus, SubscriptionStatus } from "@omniseller/shared";

/**
 * Subscriptions, their invoices, and usage as rules (PRD 15.1 and 15.4, technology doc ADR-020, UI L45,
 * backend doc 8.32). Pure functions; `BillingService` reads and writes.
 *
 * Plan changes are fair without refunds: a move up starts when it is paid, less what is left of a paid
 * period; a move down (a cheaper plan or Starter) waits for the end of the period already paid; the
 * period after the current one may be paid early and starts when the current one ends.
 */

/** A new business tries Growth for this long, then falls back to Starter unless it pays (PRD 15.4). */
export const TRIAL_DAYS = 14;
/** A paid plan keeps working this long after its period ended unpaid, then the business is on Starter. */
export const GRACE_DAYS = 7;
/** The renewal invoice is made and announced this long before the period ends. */
export const RENEWAL_NOTICE_DAYS = 7;
/** A trial's end is announced this long before. */
export const TRIAL_NOTICE_DAYS = 3;
/** An invoice for a plan chosen now can be paid for this long. */
export const UPGRADE_INVOICE_HOURS = 24;
/** A renewal invoice Xendit refused is asked for again after this long (the hourly job retries it). */
export const FAILED_RETRY_HOURS = 6;
/** The smallest amount Xendit takes for an invoice in rupiah; a credit never brings an invoice below it. */
export const MIN_INVOICE_AMOUNT = 10_000;
export const FREE_PLAN = "starter";
export const TRIAL_PLAN = "growth";
/** Usage warnings, as a share of the monthly quota, each sent once a month. */
export const USAGE_WARNINGS = [80, 100] as const;
export type UsageWarning = (typeof USAGE_WARNINGS)[number];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const addDays = (at: Date, days: number): Date => new Date(at.getTime() + days * DAY_MS);

/** The same time of day a month later; the last day of that month when it is shorter (31 Jan → 28 Feb). */
export function addMonth(at: Date): Date {
  const d = new Date(at.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** Whole days from `now` to `at`, rounded up: "berakhir dalam 3 hari" on the morning three days before. */
export function daysUntil(at: Date, now: Date): number {
  // `|| 0` turns the -0 of a time earlier today into 0
  return Math.ceil((at.getTime() - now.getTime()) / DAY_MS) || 0;
}

/** "YYYY-MM" of a local calendar date: the month a usage counter belongs to. */
export const usagePeriodOf = (localDate: string): string => localDate.slice(0, 7);

/** "2610" of "2026-10-07": the invoice numbers' period (INV-2610-0001). */
export const invoicePeriodOf = (localDate: string): string => localDate.slice(2, 4) + localDate.slice(5, 7);

export const invoiceNumber = (period: string, n: number): string => `INV-${period}-${String(n).padStart(4, "0")}`;

/** The warning that is due now, if any: the highest threshold reached that was not announced yet. */
export function usageWarning(value: number, limit: number | null | undefined, warnedPct: number): UsageWarning | null {
  if (!limit || limit <= 0) return null;
  const pct = (value / limit) * 100;
  for (const w of [...USAGE_WARNINGS].sort((a, b) => b - a)) {
    if (pct >= w && warnedPct < w) return w;
  }
  return null;
}

// ---- choosing a plan ----

export interface PlanFacts {
  id: string;
  priceMonthly: number;
}

export interface LiveFacts {
  status: SubscriptionStatus;
  plan: PlanFacts;
  currentPeriodEnd: Date | null;
  nextPlanId: string | null;
}

export type PlanChoice =
  /** Nothing to do: the plan in force, or the change already scheduled. */
  | { kind: "same" }
  /** The plan in force after all: the scheduled change is called off. */
  | { kind: "stay" }
  /** The trial's plan: an invoice for the month after the trial, payable now, starting when the trial ends. */
  | { kind: "keep_after_trial" }
  /** The plan in force, past due, with nothing left to pay: a new invoice for the overdue period. */
  | { kind: "renew_now" }
  /** A paid plan from the moment it is paid (from a trial, Starter, an unpaid period, or a move up). */
  | { kind: "now" }
  /** A cheaper plan, Starter included, from the end of the paid period. */
  | { kind: "at_period_end" }
  /** The free plan from now: there is no paid period to wait for. */
  | { kind: "free_now" };

/** A paid period is running: what the business paid for keeps working until it ends. */
export function hasPaidPeriod(s: LiveFacts): boolean {
  return s.status === "active" && s.currentPeriodEnd !== null && s.plan.priceMonthly > 0;
}

/** What choosing `target` means for the subscription as it stands (backend doc 8.32, L45). */
export function planChoice(s: LiveFacts, target: PlanFacts): PlanChoice {
  if (target.id === s.plan.id) {
    if (s.status === "trialing") return { kind: "keep_after_trial" };
    if (s.status === "past_due") return { kind: "renew_now" };
    return s.nextPlanId ? { kind: "stay" } : { kind: "same" };
  }
  if (hasPaidPeriod(s) && target.priceMonthly < s.plan.priceMonthly) {
    return s.nextPlanId === target.id ? { kind: "same" } : { kind: "at_period_end" };
  }
  return target.priceMonthly === 0 ? { kind: "free_now" } : { kind: "now" };
}

/**
 * What is left of a paid period, taken off a move up's invoice: what was paid for the period times the
 * share of it still ahead, in whole rupiah, never leaving less than Xendit's smallest amount to pay.
 */
export function upgradeCredit(input: {
  paid: number;
  periodStart: Date;
  periodEnd: Date;
  now: Date;
  newPrice: number;
}): number {
  const total = input.periodEnd.getTime() - input.periodStart.getTime();
  const left = input.periodEnd.getTime() - input.now.getTime();
  if (input.paid <= 0 || total <= 0 || left <= 0) return 0;
  const credit = Math.floor(input.paid * Math.min(1, left / total));
  return Math.max(0, Math.min(credit, input.newPrice - MIN_INVOICE_AMOUNT));
}

/**
 * What was paid for a period, at list price: the paid invoice covering exactly that period, its amount
 * plus any credit it carried (the credit was value already paid). Zero when no paid invoice covers it.
 */
export function paidForPeriod(
  invoices: { status: InvoiceStatus; periodStart: Date; periodEnd: Date; amount: number; creditAmount: number }[],
  period: { start: Date; end: Date | null },
): number {
  const inv = invoices.find(
    (i) =>
      i.status === "paid" &&
      i.periodStart.getTime() === period.start.getTime() &&
      i.periodEnd.getTime() === period.end?.getTime(),
  );
  return inv ? inv.amount + inv.creditAmount : 0;
}

/** When a move up starts: when it was paid by Xendit's word, never before the invoice nor after now. */
export function upgradeStart(paidAt: Date | null, invoiceCreatedAt: Date, now: Date): Date {
  const at = paidAt && paidAt.getTime() > invoiceCreatedAt.getTime() ? paidAt : invoiceCreatedAt;
  return at.getTime() > now.getTime() ? now : at;
}

// ---- the renewal job ----

/** The invoice for the period after the current one, as far as the renewal job needs to know. */
export type NextInvoiceFacts = { status: "pending" | "paid" } | { status: "failed"; failedAt: Date } | null;

export interface SubscriptionFacts {
  status: SubscriptionStatus;
  /** Null for the free plan. */
  currentPeriodEnd: Date | null;
  /** The plan the business moves to at the period's end; null: the plan in force renews. */
  nextPlan: { priceMonthly: number } | null;
  remindedStage: "ending" | "due" | "past_due" | null;
  nextInvoice: NextInvoiceFacts;
}

export type SubscriptionStep =
  /** Say the trial ends in a few days. */
  | { kind: "trial_ending" }
  /** Make and announce the invoice for the next period (the next plan, else the plan in force). */
  | { kind: "renewal_invoice" }
  /** Ask Xendit again for the next period's invoice it refused a while ago. */
  | { kind: "retry_invoice" }
  /** The next period is paid and has begun: move into it, on the plan it was paid for. */
  | { kind: "roll" }
  /** The period ended unpaid: the plan keeps working through the grace days. */
  | { kind: "past_due" }
  /** The trial or the grace days are over: Starter from now on. */
  | { kind: "expire" }
  /** The business chose Starter for after this period, and the period ended. */
  | { kind: "downgrade" }
  | { kind: "none" };

/**
 * What the renewal job does for a live subscription at `now` (one step; the job repeats until none).
 * Free plans have no period and nothing to do.
 */
export function subscriptionStep(s: SubscriptionFacts, now: Date): SubscriptionStep {
  const end = s.currentPeriodEnd;
  if (!end) return { kind: "none" };
  const ended = now.getTime() >= end.getTime();
  const next = s.nextInvoice;
  const retryDue = next?.status === "failed" && now.getTime() - next.failedAt.getTime() >= FAILED_RETRY_HOURS * HOUR_MS;
  switch (s.status) {
    case "trialing":
      if (ended) {
        if (next?.status === "paid") return { kind: "roll" };
        // the business chose to keep the plan and has a week to pay, like a renewal
        return next ? { kind: "past_due" } : { kind: "expire" };
      }
      if (retryDue) return { kind: "retry_invoice" };
      if (next?.status !== "paid" && s.remindedStage !== "ending" && daysUntil(end, now) <= TRIAL_NOTICE_DAYS) {
        return { kind: "trial_ending" };
      }
      return { kind: "none" };
    case "active":
      if (s.nextPlan?.priceMonthly === 0) return ended ? { kind: "downgrade" } : { kind: "none" };
      if (ended) return next?.status === "paid" ? { kind: "roll" } : { kind: "past_due" };
      if (retryDue) return { kind: "retry_invoice" };
      if (!next && daysUntil(end, now) <= RENEWAL_NOTICE_DAYS) return { kind: "renewal_invoice" };
      return { kind: "none" };
    case "past_due":
      // a renewal paid during the grace days moves the subscription on at once; this is the safety net
      if (next?.status === "paid") return { kind: "roll" };
      if (now.getTime() >= addDays(end, GRACE_DAYS).getTime()) return { kind: "expire" };
      return retryDue ? { kind: "retry_invoice" } : { kind: "none" };
    default:
      return { kind: "none" };
  }
}

/** The day the plan stops unless it is paid: the trial's end, or the end of the grace days. */
export function lapsesAt(s: Pick<SubscriptionFacts, "status" | "currentPeriodEnd">): Date | null {
  if (!s.currentPeriodEnd) return null;
  if (s.status === "trialing") return s.currentPeriodEnd;
  if (s.status === "past_due") return addDays(s.currentPeriodEnd, GRACE_DAYS);
  return null;
}

export interface BillingTask {
  kind: "billing_due";
  severity: "critical" | "warning";
  count: number;
  title: string;
}

/**
 * "Perlu tindakan" for whoever keeps the money (settings:billing): a plan about to lapse, a trial about to
 * end, or an invoice to pay soon.
 */
export function billingTask(
  s: Pick<SubscriptionFacts, "status" | "currentPeriodEnd"> & { planName: string; nextPaid: boolean },
  pending: { number: string; dueAt: Date } | null,
  now: Date,
  formatDate: (at: Date) => string,
): BillingTask | null {
  const end = s.currentPeriodEnd;
  if (s.status === "past_due" && end) {
    const left = Math.max(0, daysUntil(addDays(end, GRACE_DAYS), now));
    return {
      kind: "billing_due",
      severity: "critical",
      count: 1,
      title:
        left > 0
          ? `Tagihan ${s.planName} belum dibayar; paket turun ke Starter dalam ${left} hari`
          : `Tagihan ${s.planName} belum dibayar; paket turun ke Starter hari ini`,
    };
  }
  if (s.status === "trialing" && end && !s.nextPaid) {
    const left = daysUntil(end, now);
    if (left <= TRIAL_NOTICE_DAYS) {
      return {
        kind: "billing_due",
        severity: "warning",
        count: 1,
        title:
          left <= 0
            ? `Uji coba ${s.planName} berakhir hari ini; pilih paket agar fiturnya tetap aktif`
            : `Uji coba ${s.planName} berakhir dalam ${left} hari; pilih paket agar fiturnya tetap aktif`,
      };
    }
  }
  if (pending && daysUntil(pending.dueAt, now) <= RENEWAL_NOTICE_DAYS) {
    return {
      kind: "billing_due",
      severity: "warning",
      count: 1,
      title: `Tagihan ${pending.number} jatuh tempo ${formatDate(pending.dueAt)}`,
    };
  }
  return null;
}

/** Xendit's invoice statuses as this module reads them (PAID and SETTLED both mean the money came). */
export function invoiceStatusOf(xenditStatus: string): Extract<InvoiceStatus, "paid" | "expired"> | null {
  const s = xenditStatus.toUpperCase();
  if (s === "PAID" || s === "SETTLED") return "paid";
  if (s === "EXPIRED") return "expired";
  return null;
}
