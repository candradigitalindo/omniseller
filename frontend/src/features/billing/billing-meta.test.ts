import { describe, expect, it } from "vitest";
import {
  actionNeedsPayments,
  asksFirst,
  canVoid,
  daysLeft,
  paymentMethodOf,
  periodNote,
  planAction,
  usagePct,
  usageTone,
} from "./billing-meta";
import { ACTIVE, BUSINESS, GROWTH, invoice, ON_BUSINESS, STARTER, TRIAL } from "./fixtures";

const now = new Date("2026-10-07T10:00:00Z");

describe("billing meta", () => {
  it("measures usage against the quota, and knows the warning thresholds", () => {
    expect(usagePct(3_200, 10_000)).toBe(32);
    expect(usagePct(8_000, 10_000)).toBe(80);
    expect(usagePct(10_500, 10_000)).toBe(105);
    expect(usagePct(7, null)).toBeNull();
    expect(usagePct(1, 0)).toBe(100);
    expect(usageTone(32)).toBe("ok");
    expect(usageTone(80)).toBe("warning");
    expect(usageTone(100)).toBe("danger");
    expect(usageTone(null)).toBe("ok");
  });

  it("counts the days a trial has left, never below zero", () => {
    expect(daysLeft("2026-10-15T03:00:00.000Z", now)).toBe(8);
    expect(daysLeft("2026-10-07T12:00:00.000Z", now)).toBe(1);
    expect(daysLeft("2026-10-07T09:00:00.000Z", now)).toBe(0);
  });

  it("lets a move up, or the month after a trial, be withdrawn by hand, never a paid plan's renewal", () => {
    expect(canVoid(invoice({ kind: "upgrade" }), ACTIVE)).toBe(true);
    expect(canVoid(invoice({ kind: "renewal" }), ACTIVE)).toBe(false);
    expect(canVoid(invoice({ kind: "renewal" }), TRIAL)).toBe(true);
    expect(canVoid(invoice({ kind: "upgrade", status: "paid" }), ACTIVE)).toBe(false);
  });

  it("names Xendit's payment methods it knows", () => {
    expect(paymentMethodOf("BANK_TRANSFER")).toBe("BANK_TRANSFER");
    expect(paymentMethodOf("QR_CODE")).toBe("QR_CODE");
    expect(paymentMethodOf("CRYPTO")).toBeNull();
    expect(paymentMethodOf(null)).toBeNull();
  });

  it("on a trial: keep the trial's plan for after it, move to another now, or down to Starter at once", () => {
    expect(planAction(TRIAL, GROWTH)).toEqual({ kind: "keep" });
    expect(planAction(TRIAL, BUSINESS)).toEqual({ kind: "upgrade" });
    expect(planAction(TRIAL, STARTER)).toEqual({ kind: "free_now" });
    const keep = invoice({ kind: "renewal", planCode: "growth" });
    expect(planAction({ ...TRIAL, pendingInvoice: keep }, GROWTH)).toEqual({ kind: "pending", invoice: keep });
  });

  it("on a paid month: up at once, down at its end, with a scheduled change shown and undoable", () => {
    const paid = { ...ACTIVE, pendingInvoice: null };
    expect(planAction(paid, GROWTH)).toEqual({ kind: "current" });
    expect(planAction(paid, BUSINESS)).toEqual({ kind: "upgrade" });
    expect(planAction(paid, STARTER)).toEqual({ kind: "at_end" });
    expect(planAction(ON_BUSINESS, GROWTH)).toEqual({ kind: "at_end" });
    const leaving = { ...ON_BUSINESS, nextPlan: GROWTH };
    expect(planAction(leaving, GROWTH)).toEqual({ kind: "scheduled", at: "2026-10-12T04:00:00.000Z" });
    expect(planAction(leaving, BUSINESS)).toEqual({ kind: "stay" });
    expect(planAction(leaving, STARTER)).toEqual({ kind: "at_end" });
  });

  it("past due: pay the plan in force again, or move; free plan: any paid plan from now", () => {
    const late = { ...ACTIVE, status: "past_due" as const, pendingInvoice: null };
    expect(planAction(late, GROWTH)).toEqual({ kind: "renew" });
    expect(planAction(late, STARTER)).toEqual({ kind: "free_now" });
    expect(planAction({ ...late, plan: BUSINESS }, GROWTH)).toEqual({ kind: "switch" });
    const free = { ...ACTIVE, plan: STARTER, currentPeriodEnd: null, pendingInvoice: null };
    expect(planAction(free, STARTER)).toEqual({ kind: "current" });
    expect(planAction(free, GROWTH)).toEqual({ kind: "upgrade" });
  });

  it("locks the other plans once the next period is paid, and shows the paid one as scheduled", () => {
    const prepaid = invoice({
      kind: "renewal",
      planCode: "growth",
      planName: "Growth",
      status: "paid",
      periodStart: "2026-10-12T04:00:00.000Z",
    });
    const moving = { ...ON_BUSINESS, nextPlan: GROWTH, prepaidInvoice: prepaid };
    expect(planAction(moving, GROWTH)).toEqual({ kind: "scheduled", at: "2026-10-12T04:00:00.000Z" });
    expect(planAction(moving, BUSINESS)).toEqual({ kind: "current" });
    expect(planAction(moving, STARTER)).toEqual({ kind: "locked", from: "2026-10-12T04:00:00.000Z" });
  });

  it("knows which choices need Xendit and which ask first", () => {
    expect(actionNeedsPayments({ kind: "upgrade" }, BUSINESS)).toBe(true);
    expect(actionNeedsPayments({ kind: "keep" }, GROWTH)).toBe(true);
    expect(actionNeedsPayments({ kind: "renew" }, GROWTH)).toBe(true);
    expect(actionNeedsPayments({ kind: "at_end" }, GROWTH)).toBe(true);
    expect(actionNeedsPayments({ kind: "at_end" }, STARTER)).toBe(false);
    expect(actionNeedsPayments({ kind: "free_now" }, STARTER)).toBe(false);
    expect(actionNeedsPayments({ kind: "stay" }, BUSINESS)).toBe(false);
    expect(asksFirst({ kind: "at_end" })).toBe(true);
    expect(asksFirst({ kind: "free_now" })).toBe(true);
    expect(asksFirst({ kind: "upgrade" })).toBe(false);
  });

  it("says where the plan stands in one line", () => {
    expect(periodNote(TRIAL, now)).toEqual({ key: "trialEnds", date: "2026-10-15T03:00:00.000Z", days: 8 });
    const keep = invoice({ kind: "renewal", planCode: "growth", status: "paid" });
    expect(periodNote({ ...TRIAL, prepaidInvoice: keep }, now)).toEqual({
      key: "trialPaid",
      date: "2026-10-15T03:00:00.000Z",
    });
    expect(periodNote(ACTIVE, now)).toEqual({ key: "renewsOn", date: "2026-10-12T04:00:00.000Z" });
    expect(periodNote({ ...ACTIVE, nextPlan: STARTER }, now)).toEqual({
      key: "endsOn",
      date: "2026-10-12T04:00:00.000Z",
      next: "Starter",
    });
    expect(
      periodNote({ ...ACTIVE, prepaidInvoice: invoice({ kind: "renewal", planName: "Growth", status: "paid" }) }, now),
    ).toEqual({ key: "prepaid", plan: "Growth", date: "2026-10-07T04:00:00.000Z", until: "2026-11-07T04:00:00.000Z" });
    expect(periodNote({ ...ACTIVE, status: "past_due", lapsesAt: "2026-10-19T04:00:00.000Z" }, now)).toEqual({
      key: "pastDue",
      date: "2026-10-19T04:00:00.000Z",
    });
    expect(periodNote({ ...ACTIVE, plan: STARTER, currentPeriodEnd: null }, now)).toEqual({ key: "freePlan" });
  });
});
