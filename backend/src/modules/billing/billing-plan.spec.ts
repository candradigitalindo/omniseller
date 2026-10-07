import { describe, expect, it } from "vitest";
import { limitReached } from "../../common/plan-limits";
import {
  addMonth,
  billingTask,
  daysUntil,
  hasPaidPeriod,
  invoiceNumber,
  invoicePeriodOf,
  invoiceStatusOf,
  type LiveFacts,
  lapsesAt,
  paidForPeriod,
  planChoice,
  type SubscriptionFacts,
  subscriptionStep,
  upgradeCredit,
  upgradeStart,
  usagePeriodOf,
  usageWarning,
} from "./billing-plan";

const at = (iso: string) => new Date(iso);
const facts = (over: Partial<SubscriptionFacts> = {}): SubscriptionFacts => ({
  status: "active",
  currentPeriodEnd: at("2026-11-07T03:00:00Z"),
  nextPlan: null,
  remindedStage: null,
  nextInvoice: null,
  ...over,
});

const STARTER = { id: "starter", priceMonthly: 0 };
const GROWTH = { id: "growth", priceMonthly: 899_000 };
const BUSINESS = { id: "business", priceMonthly: 2_499_000 };
const live = (over: Partial<LiveFacts> = {}): LiveFacts => ({
  status: "active",
  plan: GROWTH,
  currentPeriodEnd: at("2026-11-07T03:00:00Z"),
  nextPlanId: null,
  ...over,
});

describe("periods and numbers", () => {
  it("adds a month keeping the time, and clamps to the shorter month", () => {
    expect(addMonth(at("2026-10-07T03:00:00Z")).toISOString()).toBe("2026-11-07T03:00:00.000Z");
    expect(addMonth(at("2026-01-31T10:00:00Z")).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addMonth(at("2028-01-31T10:00:00Z")).toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(addMonth(at("2026-12-15T00:00:00Z")).toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });

  it("counts days up, names months and invoices", () => {
    expect(daysUntil(at("2026-10-10T00:00:00Z"), at("2026-10-07T08:00:00Z"))).toBe(3);
    expect(daysUntil(at("2026-10-07T00:00:00Z"), at("2026-10-07T08:00:00Z"))).toBe(0);
    expect(daysUntil(at("2026-10-05T00:00:00Z"), at("2026-10-07T08:00:00Z"))).toBe(-2);
    expect(usagePeriodOf("2026-10-07")).toBe("2026-10");
    expect(invoicePeriodOf("2026-10-07")).toBe("2610");
    expect(invoiceNumber("2610", 7)).toBe("INV-2610-0007");
  });
});

describe("quotas", () => {
  const limits = { stores: 2, warehouses: 1, orders_per_month: 1000, users: 2 };
  it("is reached at the quota and never for an unlimited one", () => {
    expect(limitReached(limits, "stores", 1)).toBe(false);
    expect(limitReached(limits, "stores", 2)).toBe(true);
    expect(limitReached({ ...limits, stores: null }, "stores", 500)).toBe(false);
  });

  it("warns at 80 and 100 percent, each once, the higher one first", () => {
    expect(usageWarning(799, 1000, 0)).toBeNull();
    expect(usageWarning(800, 1000, 0)).toBe(80);
    expect(usageWarning(900, 1000, 80)).toBeNull();
    expect(usageWarning(1000, 1000, 80)).toBe(100);
    expect(usageWarning(1200, 1000, 0)).toBe(100);
    expect(usageWarning(1200, 1000, 100)).toBeNull();
    expect(usageWarning(5000, null, 0)).toBeNull();
  });
});

describe("choosing a plan", () => {
  it("moves up from when it is paid, and down at the end of the paid period", () => {
    expect(planChoice(live(), BUSINESS)).toEqual({ kind: "now" });
    expect(planChoice(live({ plan: BUSINESS }), GROWTH)).toEqual({ kind: "at_period_end" });
    expect(planChoice(live(), STARTER)).toEqual({ kind: "at_period_end" });
    expect(planChoice(live(), GROWTH)).toEqual({ kind: "same" });
    // the change already scheduled is nothing new; the plan in force calls it off; another replaces it
    expect(planChoice(live({ plan: BUSINESS, nextPlanId: "growth" }), GROWTH)).toEqual({ kind: "same" });
    expect(planChoice(live({ plan: BUSINESS, nextPlanId: "growth" }), BUSINESS)).toEqual({ kind: "stay" });
    expect(planChoice(live({ plan: BUSINESS, nextPlanId: "growth" }), STARTER)).toEqual({ kind: "at_period_end" });
  });

  it("has no paid period to wait for in a trial, an unpaid period, or the free plan", () => {
    const trial = live({ status: "trialing" });
    expect(planChoice(trial, GROWTH)).toEqual({ kind: "keep_after_trial" });
    expect(planChoice(trial, BUSINESS)).toEqual({ kind: "now" });
    expect(planChoice(trial, STARTER)).toEqual({ kind: "free_now" });
    const late = live({ status: "past_due" });
    expect(planChoice(late, GROWTH)).toEqual({ kind: "renew_now" });
    expect(planChoice(late, STARTER)).toEqual({ kind: "free_now" });
    expect(planChoice(live({ status: "past_due", plan: BUSINESS }), GROWTH)).toEqual({ kind: "now" });
    const free = live({ plan: STARTER, currentPeriodEnd: null });
    expect(planChoice(free, GROWTH)).toEqual({ kind: "now" });
    expect(planChoice(free, STARTER)).toEqual({ kind: "same" });
    expect(hasPaidPeriod(live())).toBe(true);
    expect(hasPaidPeriod(free)).toBe(false);
    expect(hasPaidPeriod(trial)).toBe(false);
  });

  it("takes what is left of a paid period off a move up, never below Xendit's smallest amount", () => {
    const period = { periodStart: at("2026-10-01T00:00:00Z"), periodEnd: at("2026-10-31T00:00:00Z") };
    // a third of the month used: two thirds of 899,000 back
    expect(upgradeCredit({ ...period, paid: 899_000, now: at("2026-10-11T00:00:00Z"), newPrice: 2_499_000 })).toBe(
      599_333,
    );
    expect(upgradeCredit({ ...period, paid: 899_000, now: at("2026-09-20T00:00:00Z"), newPrice: 2_499_000 })).toBe(
      899_000,
    );
    expect(upgradeCredit({ ...period, paid: 899_000, now: at("2026-10-31T00:00:00Z"), newPrice: 2_499_000 })).toBe(0);
    expect(upgradeCredit({ ...period, paid: 0, now: at("2026-10-11T00:00:00Z"), newPrice: 2_499_000 })).toBe(0);
    // a whole month left against a price barely above it: the invoice keeps Xendit's smallest amount
    expect(upgradeCredit({ ...period, paid: 899_000, now: at("2026-10-01T00:00:00Z"), newPrice: 900_000 })).toBe(
      890_000,
    );
  });

  it("values a period by what was paid for it, credit included, and nothing without a paid invoice", () => {
    const period = { start: at("2026-10-01T00:00:00Z"), end: at("2026-11-01T00:00:00Z") };
    const inv = (over: object) => ({
      status: "paid" as const,
      periodStart: period.start,
      periodEnd: period.end,
      amount: 1_658_000,
      creditAmount: 841_000,
      ...over,
    });
    expect(paidForPeriod([inv({})], period)).toBe(2_499_000);
    expect(paidForPeriod([inv({ status: "void" })], period)).toBe(0);
    expect(paidForPeriod([inv({ periodStart: at("2026-09-01T00:00:00Z") })], period)).toBe(0);
    expect(paidForPeriod([inv({ periodEnd: at("2026-12-01T00:00:00Z") })], period)).toBe(0);
    expect(paidForPeriod([inv({})], { start: period.start, end: null })).toBe(0);
  });

  it("starts a move up when it was paid, but never before the invoice nor after now", () => {
    const created = at("2026-10-07T03:00:00Z");
    const now = at("2026-10-07T05:00:00Z");
    expect(upgradeStart(at("2026-10-07T04:00:00Z"), created, now)).toEqual(at("2026-10-07T04:00:00Z"));
    expect(upgradeStart(at("2026-10-06T04:00:00Z"), created, now)).toEqual(created);
    expect(upgradeStart(at("2026-10-07T09:00:00Z"), created, now)).toEqual(now);
    expect(upgradeStart(null, created, now)).toEqual(created);
  });
});

describe("what the renewal job does", () => {
  it("announces a trial's end three days before, once, then ends it", () => {
    const trial = facts({ status: "trialing", currentPeriodEnd: at("2026-10-21T03:00:00Z") });
    expect(subscriptionStep(trial, at("2026-10-17T04:00:00Z"))).toEqual({ kind: "none" });
    expect(subscriptionStep(trial, at("2026-10-18T04:00:00Z"))).toEqual({ kind: "trial_ending" });
    expect(subscriptionStep({ ...trial, remindedStage: "ending" }, at("2026-10-20T04:00:00Z"))).toEqual({
      kind: "none",
    });
    expect(subscriptionStep(trial, at("2026-10-21T03:00:00Z"))).toEqual({ kind: "expire" });
  });

  it("keeps a trial whose next month is chosen: paid it rolls on, unpaid it gets the grace days", () => {
    const trial = facts({ status: "trialing", currentPeriodEnd: at("2026-10-21T03:00:00Z") });
    const paid = { ...trial, nextInvoice: { status: "paid" as const } };
    expect(subscriptionStep(paid, at("2026-10-18T04:00:00Z"))).toEqual({ kind: "none" });
    expect(subscriptionStep(paid, at("2026-10-21T03:00:00Z"))).toEqual({ kind: "roll" });
    const chosen = { ...trial, nextInvoice: { status: "pending" as const } };
    expect(subscriptionStep(chosen, at("2026-10-18T04:00:00Z"))).toEqual({ kind: "trial_ending" });
    expect(subscriptionStep(chosen, at("2026-10-21T03:00:00Z"))).toEqual({ kind: "past_due" });
  });

  it("makes the renewal invoice a week before the period ends, then past due, then expires after grace", () => {
    const paid = facts();
    expect(subscriptionStep(paid, at("2026-10-30T04:00:00Z"))).toEqual({ kind: "none" });
    expect(subscriptionStep(paid, at("2026-10-31T04:00:00Z"))).toEqual({ kind: "renewal_invoice" });
    const billed = facts({ nextInvoice: { status: "pending" } });
    expect(subscriptionStep(billed, at("2026-11-05T04:00:00Z"))).toEqual({ kind: "none" });
    expect(subscriptionStep(billed, at("2026-11-07T03:00:00Z"))).toEqual({ kind: "past_due" });
    const late = facts({ status: "past_due", nextInvoice: { status: "pending" } });
    expect(subscriptionStep(late, at("2026-11-13T04:00:00Z"))).toEqual({ kind: "none" });
    expect(subscriptionStep(late, at("2026-11-14T03:00:00Z"))).toEqual({ kind: "expire" });
    expect(subscriptionStep({ ...late, nextInvoice: { status: "paid" } }, at("2026-11-08T03:00:00Z"))).toEqual({
      kind: "roll",
    });
    expect(lapsesAt(late)?.toISOString()).toBe("2026-11-14T03:00:00.000Z");
    expect(lapsesAt(paid)).toBeNull();
  });

  it("rolls into a period paid early only when it begins", () => {
    const early = facts({ nextInvoice: { status: "paid" } });
    expect(subscriptionStep(early, at("2026-11-07T02:59:00Z"))).toEqual({ kind: "none" });
    expect(subscriptionStep(early, at("2026-11-07T03:00:00Z"))).toEqual({ kind: "roll" });
    // a scheduled cheaper paid plan is billed and rolled the same way
    const moving = facts({ nextPlan: { priceMonthly: 899_000 } });
    expect(subscriptionStep(moving, at("2026-10-31T04:00:00Z"))).toEqual({ kind: "renewal_invoice" });
    expect(subscriptionStep({ ...moving, nextInvoice: { status: "paid" } }, at("2026-11-07T03:00:00Z"))).toEqual({
      kind: "roll",
    });
  });

  it("asks Xendit again for a refused invoice after six hours, not before", () => {
    const failed = (hoursAgo: number) =>
      facts({
        nextInvoice: {
          status: "failed",
          failedAt: new Date(at("2026-11-01T12:00:00Z").getTime() - hoursAgo * 3600_000),
        },
      });
    expect(subscriptionStep(failed(5), at("2026-11-01T12:00:00Z"))).toEqual({ kind: "none" });
    expect(subscriptionStep(failed(6), at("2026-11-01T12:00:00Z"))).toEqual({ kind: "retry_invoice" });
    expect(subscriptionStep({ ...failed(6), status: "past_due" }, at("2026-11-08T12:00:00Z"))).toEqual({
      kind: "retry_invoice",
    });
    // a refused invoice is still an invoice: the period ends past due, not with a second one
    expect(subscriptionStep(failed(1), at("2026-11-07T03:00:00Z"))).toEqual({ kind: "past_due" });
  });

  it("stops at the period's end when the business chose Starter, and leaves the free plan alone", () => {
    const leaving = facts({ nextPlan: { priceMonthly: 0 } });
    expect(subscriptionStep(leaving, at("2026-11-01T04:00:00Z"))).toEqual({ kind: "none" });
    expect(subscriptionStep(leaving, at("2026-11-07T03:00:00Z"))).toEqual({ kind: "downgrade" });
    expect(subscriptionStep(facts({ currentPeriodEnd: null }), at("2030-01-01T00:00:00Z"))).toEqual({ kind: "none" });
  });
});

describe("the dashboard task", () => {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const task = (s: Parameters<typeof billingTask>[0], pending: Parameters<typeof billingTask>[1] = null) =>
    billingTask(s, pending, at("2026-11-09T04:00:00Z"), fmt);

  it("asks for an overdue plan first, then a trial about to end, then an invoice due", () => {
    const growth = { planName: "Growth", nextPaid: false };
    expect(task({ ...growth, status: "past_due", currentPeriodEnd: at("2026-11-07T03:00:00Z") })).toMatchObject({
      severity: "critical",
      title: "Tagihan Growth belum dibayar; paket turun ke Starter dalam 5 hari",
    });
    expect(task({ ...growth, status: "trialing", currentPeriodEnd: at("2026-11-11T03:00:00Z") })).toMatchObject({
      severity: "warning",
      title: /Uji coba Growth berakhir dalam 2 hari/,
    });
    // a trial whose next month is paid needs nothing
    expect(
      task({ ...growth, nextPaid: true, status: "trialing", currentPeriodEnd: at("2026-11-11T03:00:00Z") }),
    ).toBeNull();
    expect(
      task(
        { ...growth, status: "active", currentPeriodEnd: at("2026-11-12T03:00:00Z") },
        { number: "INV-2611-0002", dueAt: at("2026-11-12T03:00:00Z") },
      ),
    ).toMatchObject({ severity: "warning", title: "Tagihan INV-2611-0002 jatuh tempo 2026-11-12" });
    expect(task({ ...growth, status: "active", currentPeriodEnd: at("2026-12-01T03:00:00Z") })).toBeNull();
  });
});

describe("Xendit statuses", () => {
  it("reads PAID and SETTLED as paid, EXPIRED as expired, and ignores the rest", () => {
    expect(invoiceStatusOf("PAID")).toBe("paid");
    expect(invoiceStatusOf("settled")).toBe("paid");
    expect(invoiceStatusOf("EXPIRED")).toBe("expired");
    expect(invoiceStatusOf("PENDING")).toBeNull();
  });
});
