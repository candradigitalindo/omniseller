import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { nextDocumentNumber } from "../../common/document-number";
import type { ExportSheet } from "../../common/export-sheet";
import { singlePage } from "../../common/export-sheet";
import { localDate } from "../../common/time-zone";
import type { DbHandle, Tx } from "../../db/client";
import type { InvoiceKind } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { BusinessProfileService } from "../business/business-profile.service";
import { type PlanView, TenantsService } from "../identity/tenants.service";
import { NotificationInboxService } from "../notification/inbox.service";
import {
  invoiceNotFound,
  invoiceNotPending,
  nextPeriodPaid,
  paymentsUnavailable,
  planNotFound,
  renewalInvoice,
  samePlan,
} from "./billing.errors";
import { billingInvoiceRequested, billingInvoiceVoided } from "./billing.events";
import { BillingRepository, type InvoiceRow, type SubscriptionRow } from "./billing.repository";
import {
  addDays,
  addMonth,
  type BillingTask,
  billingTask,
  daysUntil,
  FREE_PLAN,
  GRACE_DAYS,
  hasPaidPeriod,
  invoiceNumber,
  invoicePeriodOf,
  invoiceStatusOf,
  lapsesAt,
  type NextInvoiceFacts,
  paidForPeriod,
  planChoice,
  RENEWAL_NOTICE_DAYS,
  subscriptionStep,
  TRIAL_DAYS,
  TRIAL_PLAN,
  UPGRADE_INVOICE_HOURS,
  upgradeCredit,
  upgradeStart,
} from "./billing-plan";

export interface SubscriptionView {
  id: string | null;
  plan: PlanView;
  status: SubscriptionRow["status"];
  currentPeriodStart: Date;
  currentPeriodEnd: Date | null;
  /** The plan the business moves to when this period ends; null: the plan in force renews. */
  nextPlan: PlanView | null;
  /** When the trial ends, or the grace days run out: the plan stops unless it is paid by then. */
  lapsesAt: Date | null;
}

export interface BillingState {
  subscription: SubscriptionView;
  plans: PlanView[];
  pendingInvoice: InvoiceRow | null;
  /** The period after the current one, paid early: it starts when the current one ends. */
  prepaidInvoice: InvoiceRow | null;
  /** Xendit is set up for this environment, so a paid plan can be chosen. */
  paymentsAvailable: boolean;
}

export interface InvoicePaid {
  invoiceId: string;
  xenditInvoiceId: string;
  status: string;
  paidAt?: string | undefined;
  paidAmount?: number | undefined;
  paymentMethod?: string | undefined;
  paymentChannel?: string | undefined;
}

/** "12 Nov 2026" in the business's time zone, for notifications and tasks. */
export function dateInZone(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone }).format(at);
}

/**
 * The invoice for the period after the current one: a renewal starting where the current period ends;
 * a paid one first, then one waiting, then one Xendit refused.
 */
export function nextInvoiceOf(
  open: InvoiceRow[],
  live: Pick<SubscriptionRow, "currentPeriodEnd">,
): InvoiceRow | undefined {
  const end = live.currentPeriodEnd?.getTime();
  if (end === undefined) return undefined;
  const ofNext = open.filter((i) => i.kind === "renewal" && i.periodStart.getTime() === end);
  return (
    ofNext.find((i) => i.status === "paid") ??
    ofNext.find((i) => i.status === "pending") ??
    ofNext.find((i) => i.status === "failed")
  );
}

function nextFacts(inv: InvoiceRow | undefined): NextInvoiceFacts {
  if (!inv) return null;
  if (inv.status === "failed") return { status: "failed", failedAt: inv.statusChangedAt };
  return inv.status === "paid" || inv.status === "pending" ? { status: inv.status } : null;
}

const rupiah = (n: number) => `Rp ${new Intl.NumberFormat("id-ID").format(n)}`;
const MAX_STEPS = 4;

/**
 * Subscriptions and their invoices (PRD 15.1 and 15.4; technology doc ADR-020; UI L45; backend doc
 * 8.32). A business starts on a 14-day trial of Growth, pays a month at a time through Xendit, and falls
 * back to Starter when a period stays unpaid. Moving up starts when paid, less what is left of a paid
 * period; moving down waits for the end of the paid period. `tenant.plan_id` is the plan in force; this
 * service keeps it in step with the live subscription row. Xendit itself is called by
 * `BillingWorkerService`.
 */
@Injectable()
export class BillingService {
  private readonly log = logger.forModule("billing");

  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(BillingRepository) private readonly repo: BillingRepository,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
    @Inject(BusinessProfileService) private readonly business: BusinessProfileService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  // ---- reading ----

  async stateIn(tx: Tx, ctx: RequestContext, paymentsAvailable: boolean): Promise<BillingState> {
    const plan = await this.tenants.planIn(tx, ctx);
    const plans = await this.tenants.listPlansIn(tx);
    const live = await this.repo.live(tx);
    const profile = await this.tenants.profileIn(tx, ctx);
    if (!live) {
      // no row yet: a new business whose trial row the worker is about to write, or an old one on Starter
      const trial = plan.code !== FREE_PLAN;
      const trialEnd = addDays(profile.createdAt, TRIAL_DAYS);
      return {
        subscription: {
          id: null,
          plan,
          status: trial ? "trialing" : "active",
          currentPeriodStart: profile.createdAt,
          currentPeriodEnd: trial ? trialEnd : null,
          nextPlan: null,
          lapsesAt: trial ? trialEnd : null,
        },
        plans,
        pendingInvoice: null,
        prepaidInvoice: null,
        paymentsAvailable,
      };
    }
    const open = await this.repo.openInvoices(tx, live.id);
    const next = nextInvoiceOf(open, live);
    return {
      subscription: {
        id: live.id,
        plan: plans.find((p) => p.id === live.planId) ?? plan,
        status: live.status,
        currentPeriodStart: live.currentPeriodStart,
        currentPeriodEnd: live.currentPeriodEnd,
        nextPlan: live.nextPlanId ? (plans.find((p) => p.id === live.nextPlanId) ?? null) : null,
        lapsesAt: lapsesAt(live),
      },
      plans,
      pendingInvoice: open.filter((i) => i.status === "pending").at(-1) ?? null,
      prepaidInvoice: next?.status === "paid" ? next : null,
      paymentsAvailable,
    };
  }

  invoicesIn(tx: Tx): Promise<InvoiceRow[]> {
    return this.repo.invoices(tx);
  }

  async invoice(ctx: RequestContext, id: string): Promise<InvoiceRow> {
    const row = await withTenantTx(this.db, ctx, (tx) => this.repo.invoice(tx, id));
    if (!row) throw invoiceNotFound();
    return row;
  }

  /** "Perlu tindakan" for settings:billing, in the caller's transaction (dashboard, 8.16). */
  async taskIn(tx: Tx, ctx: RequestContext, now = new Date()): Promise<BillingTask | null> {
    const live = await this.repo.live(tx);
    if (!live) return null;
    const plans = await this.tenants.listPlansIn(tx);
    const planName = plans.find((p) => p.id === live.planId)?.name ?? "";
    const open = await this.repo.openInvoices(tx, live.id);
    const pending = open.filter((i) => i.status === "pending").at(-1);
    const { timezone } = await this.tenants.profileIn(tx, ctx);
    return billingTask(
      { ...live, planName, nextPaid: nextInvoiceOf(open, live)?.status === "paid" },
      pending ? { number: pending.number, dueAt: pending.dueAt } : null,
      now,
      (at) => dateInZone(timezone, at),
    );
  }

  // ---- the trial (job `billing.trial_start`, from `tenant.created`) ----

  /** The trial row of a new business; an older business without a row gets a Starter row instead. */
  async startTrial(ctx: RequestContext, now = new Date()): Promise<"started" | "skipped"> {
    return withTenantTx(this.db, ctx, async (tx) => {
      if (await this.repo.live(tx, true)) return "skipped";
      await this.startTrialIn(tx, ctx, now);
      return "started";
    });
  }

  private async startTrialIn(tx: Tx, ctx: RequestContext, now: Date): Promise<SubscriptionRow> {
    const { createdAt } = await this.tenants.profileIn(tx, ctx);
    const trialEnd = addDays(createdAt, TRIAL_DAYS);
    if (trialEnd <= now) {
      // a business from before this module, or whose trial already ran out: Starter, quietly
      const starter = await this.planByCode(tx, FREE_PLAN);
      await this.repo.insertSubscription(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        planId: starter.id,
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: null,
      });
      await this.tenants.setPlanIn(tx, ctx, starter.id);
    } else {
      const growth = await this.planByCode(tx, TRIAL_PLAN);
      await this.repo.insertSubscription(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        planId: growth.id,
        status: "trialing",
        currentPeriodStart: createdAt,
        currentPeriodEnd: trialEnd,
      });
      await this.tenants.setPlanIn(tx, ctx, growth.id);
    }
    return (await this.repo.live(tx, true))!;
  }

  // ---- choosing a plan (L45) ----

  /**
   * A plan chosen on L45 (`planChoice`): Starter at once from a trial or an unpaid period; a cheaper plan
   * at the end of the paid period; a pricier one from when its invoice is paid, less what is left of a
   * paid period; the trial's plan for the month after the trial. Returns nothing: the caller reads the
   * state again.
   */
  async changePlan(ctx: RequestContext, planCode: string, paymentsAvailable: boolean, now = new Date()): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const plans = await this.tenants.listPlansIn(tx);
      const target = plans.find((p) => p.code === planCode && p.active);
      if (!target) throw planNotFound();
      const live = (await this.repo.live(tx, true)) ?? (await this.startTrialIn(tx, ctx, now));
      const current = plans.find((p) => p.id === live.planId);
      if (!current) throw new Error(`subscription ${live.id} has an unknown plan`);
      const open = await this.repo.openInvoices(tx, live.id);
      const next = nextInvoiceOf(open, live);
      if (next?.status === "paid") {
        const { timezone } = await this.tenants.profileIn(tx, ctx);
        throw nextPeriodPaid(dateInZone(timezone, live.currentPeriodEnd!));
      }
      const facts = {
        status: live.status,
        plan: current,
        currentPeriodEnd: live.currentPeriodEnd,
        nextPlanId: live.nextPlanId,
      };
      const choice = planChoice(facts, target);
      const charges =
        ["keep_after_trial", "renew_now", "now"].includes(choice.kind) ||
        (choice.kind === "at_period_end" && target.priceMonthly > 0);
      if (charges && !paymentsAvailable) throw paymentsUnavailable();

      switch (choice.kind) {
        case "same":
          throw samePlan();
        case "free_now":
          await this.endAndStartFreeIn(tx, ctx, live, "cancelled", now);
          return;
        case "at_period_end":
          await this.voidPendingIn(tx, ctx, live.id, "Paket lain dipilih.");
          await this.repo.updateSubscription(tx, live.id, { nextPlanId: target.id, remindedStage: null });
          // inside the renewal window the next plan's invoice comes at once; else the renewal job makes it
          if (target.priceMonthly > 0 && daysUntil(live.currentPeriodEnd!, now) <= RENEWAL_NOTICE_DAYS) {
            await this.createRenewalIn(tx, ctx, live, target, now);
          }
          return;
        case "stay":
          await this.voidPendingIn(tx, ctx, live.id, "Paket tetap.");
          await this.repo.updateSubscription(tx, live.id, { nextPlanId: null, remindedStage: null });
          if (daysUntil(live.currentPeriodEnd!, now) <= RENEWAL_NOTICE_DAYS) {
            await this.createRenewalIn(tx, ctx, live, current, now);
          }
          return;
        case "keep_after_trial":
        case "renew_now":
          if (next?.status === "pending" && next.planId === target.id) return;
          await this.voidPendingIn(tx, ctx, live.id, "Paket lain dipilih.");
          if (live.nextPlanId) await this.repo.updateSubscription(tx, live.id, { nextPlanId: null });
          if (next?.status === "failed" && next.planId === target.id) await this.retryIn(tx, ctx, next, now);
          else await this.createRenewalIn(tx, ctx, live, target, now);
          return;
        case "now": {
          if (open.some((i) => i.status === "pending" && i.kind === "upgrade" && i.planId === target.id)) return;
          await this.voidPendingIn(tx, ctx, live.id, "Paket lain dipilih.");
          const credit = hasPaidPeriod(facts)
            ? upgradeCredit({
                paid: paidForPeriod(open, { start: live.currentPeriodStart, end: live.currentPeriodEnd }),
                periodStart: live.currentPeriodStart,
                periodEnd: live.currentPeriodEnd!,
                now,
                newPrice: target.priceMonthly,
              })
            : 0;
          const dueAt = new Date(now.getTime() + UPGRADE_INVOICE_HOURS * 3600_000);
          await this.createInvoiceIn(tx, ctx, {
            subscription: live,
            plan: target,
            kind: "upgrade",
            credit,
            periodStart: now,
            periodEnd: addMonth(now),
            dueAt,
            expiresAt: dueAt,
            now,
          });
          return;
        }
      }
    });
  }

  /**
   * A waiting invoice the business does not want after all: a move up, or the month after the trial. A
   * renewal of a paid plan goes away with another plan, never by hand.
   */
  async voidInvoice(ctx: RequestContext, id: string, now = new Date()): Promise<InvoiceRow> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const inv = await this.repo.invoice(tx, id, true);
      if (!inv) throw invoiceNotFound();
      if (inv.status !== "pending") throw invoiceNotPending();
      const live = await this.repo.live(tx);
      if (inv.kind === "renewal" && live?.status !== "trialing") throw renewalInvoice();
      await this.voidIn(tx, ctx, inv, "Dibatalkan penjual.", now);
      return (await this.repo.invoice(tx, id))!;
    });
  }

  // ---- what the worker writes ----

  async markInvoiceCreated(
    ctx: RequestContext,
    id: string,
    xendit: { id: string; invoiceUrl: string; expiryDate: Date | null },
  ): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const inv = await this.repo.invoice(tx, id, true);
      if (!inv) return;
      await this.repo.updateInvoice(tx, id, {
        externalInvoiceId: xendit.id,
        invoiceUrl: xendit.invoiceUrl,
        invoiceExpiresAt: xendit.expiryDate,
        error: null,
      });
      // withdrawn while Xendit was making its page: close that page again
      if (inv.status !== "pending") await this.outbox.enqueue(tx, ctx, billingInvoiceVoided, { invoiceId: id }, id);
    });
  }

  async markInvoiceFailed(ctx: RequestContext, id: string, error: string, now = new Date()): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const inv = await this.repo.invoice(tx, id, true);
      if (inv?.status !== "pending") return;
      await this.repo.updateInvoice(tx, id, { status: "failed", statusChangedAt: now, error });
    });
  }

  /**
   * Xendit's callback (job `billing.invoice_callback`). A move up switches the plan from when it was paid;
   * the next period paid early starts when the current one ends (the renewal job moves into it), paid late
   * it starts at once. Money for an invoice no longer in force is recorded and announced, never applied.
   * Idempotent: the same callback twice changes nothing more.
   */
  async applyCallback(ctx: RequestContext, p: InvoicePaid, now = new Date()): Promise<"paid" | "expired" | "ignored"> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const inv = await this.repo.invoice(tx, p.invoiceId, true);
      const status = invoiceStatusOf(p.status);
      if (!inv || !status) return "ignored";
      if (status === "expired") {
        if (inv.status !== "pending") return "ignored";
        await this.repo.updateInvoice(tx, inv.id, { status: "expired", statusChangedAt: now });
        return "expired";
      }
      if (inv.status === "paid") return "ignored";
      const paidAt = p.paidAt && !Number.isNaN(Date.parse(p.paidAt)) ? new Date(p.paidAt) : now;
      const paid = {
        status: "paid" as const,
        statusChangedAt: now,
        paidAt,
        paidAmount: p.paidAmount ?? inv.amount,
        paymentMethod: p.paymentMethod ?? null,
        paymentChannel: p.paymentChannel ?? null,
        externalInvoiceId: inv.externalInvoiceId ?? p.xenditInvoiceId,
        error: null,
        // the PDF of a paid invoice prints who it was billed to then, whatever the profile says later
        billTo: await this.business.billToIn(tx, ctx),
      };
      const live = await this.repo.live(tx, true);
      const plan = (await this.tenants.listPlansIn(tx)).find((x) => x.id === inv.planId);
      const { timezone } = await this.tenants.profileIn(tx, ctx);
      const date = (at: Date) => dateInZone(timezone, at);

      if (inv.status !== "pending" || !live || live.id !== inv.subscriptionId) {
        // withdrawn or expired a moment before the money came (a transfer in flight): kept, not applied
        await this.repo.updateInvoice(tx, inv.id, paid);
        await this.notify(tx, ctx, {
          severity: "warning",
          reason: "late_payment",
          title: `Pembayaran ${inv.number} diterima untuk tagihan yang sudah tidak berlaku`,
          body: "Paket tidak berubah. Hubungi dukungan OmniSeller untuk memakai dana ini atau mengembalikannya.",
        });
        this.log.warn({ tenant_id: ctx.tenantId, invoice_id: inv.id }, "payment for an invoice no longer in force");
        return "paid";
      }

      if (inv.kind === "upgrade") {
        const start = upgradeStart(paidAt, inv.createdAt, now);
        const end = addMonth(start);
        await this.repo.updateInvoice(tx, inv.id, { ...paid, periodStart: start, periodEnd: end });
        await this.switchIn(tx, ctx, live, inv.id, inv.planId, start, end, now);
        await this.notify(tx, ctx, {
          severity: "info",
          reason: "paid",
          title: `Pembayaran ${inv.number} diterima`,
          body: `Paket ${plan?.name ?? ""} aktif sampai ${date(end)}. Terima kasih.`,
        });
        this.log.info({ tenant_id: ctx.tenantId, invoice_id: inv.id }, "upgrade paid");
        return "paid";
      }

      await this.repo.updateInvoice(tx, inv.id, paid);
      const early = now.getTime() < inv.periodStart.getTime();
      if (!early) await this.rollIn(tx, ctx, live, inv, now);
      await this.notify(tx, ctx, {
        severity: "info",
        reason: "paid",
        title: `Pembayaran ${inv.number} diterima`,
        body: early
          ? `Paket ${plan?.name ?? ""} berlanjut ${date(inv.periodStart)} sampai ${date(inv.periodEnd)}. Terima kasih.`
          : `Paket ${plan?.name ?? ""} aktif sampai ${date(inv.periodEnd)}. Terima kasih.`,
      });
      this.log.info({ tenant_id: ctx.tenantId, invoice_id: inv.id, early }, "renewal paid");
      return "paid";
    });
  }

  // ---- the renewal job (`billing.renew`, hourly scan) ----

  /** Everything that fell due for the live subscription: reminders, invoices, moving on, lapsing. */
  async renew(ctx: RequestContext, now = new Date()): Promise<string[]> {
    const done: string[] = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      const step = await withTenantTx(this.db, ctx, async (tx) => {
        const live = await this.repo.live(tx, true);
        if (!live) return "none";
        const plans = await this.tenants.listPlansIn(tx);
        const plan = plans.find((p) => p.id === live.planId);
        const nextPlan = live.nextPlanId ? plans.find((p) => p.id === live.nextPlanId) : undefined;
        const { timezone } = await this.tenants.profileIn(tx, ctx);
        const date = (at: Date) => dateInZone(timezone, at);
        const open = await this.repo.openInvoices(tx, live.id);
        const next = nextInvoiceOf(open, live);
        const step = subscriptionStep(
          {
            status: live.status,
            currentPeriodEnd: live.currentPeriodEnd,
            nextPlan: nextPlan ? { priceMonthly: nextPlan.priceMonthly } : null,
            remindedStage: live.remindedStage,
            nextInvoice: nextFacts(next),
          },
          now,
        );
        const end = live.currentPeriodEnd;
        switch (step.kind) {
          case "trial_ending":
            await this.repo.updateSubscription(tx, live.id, { remindedStage: "ending" });
            await this.notify(tx, ctx, {
              severity: "warning",
              reason: "trial_ending",
              title: `Uji coba ${plan?.name ?? ""} berakhir ${date(end!)}`,
              body: "Pilih paket di Langganan & Tagihan agar fitur yang dipakai tetap aktif. Tanpa itu bisnis kembali ke paket Starter.",
            });
            break;
          case "renewal_invoice": {
            const target = nextPlan ?? plan;
            if (!target) break;
            const inv = await this.createRenewalIn(tx, ctx, live, target, now);
            await this.repo.updateSubscription(tx, live.id, { remindedStage: "due" });
            await this.notify(tx, ctx, {
              severity: "info",
              reason: "invoice_due",
              title: `Tagihan ${inv.number} untuk ${target.name} jatuh tempo ${date(end!)}`,
              body: `${rupiah(inv.amount)} untuk periode ${date(inv.periodStart)} sampai ${date(inv.periodEnd)}. Bayar di Langganan & Tagihan.`,
            });
            break;
          }
          case "retry_invoice":
            await this.retryIn(tx, ctx, next!, now);
            break;
          case "roll":
            await this.rollIn(tx, ctx, live, next!, now);
            if (next!.planId !== live.planId) {
              const to = plans.find((p) => p.id === next!.planId);
              await this.notify(tx, ctx, {
                severity: "info",
                reason: "plan_changed",
                title: `Bisnis kini memakai paket ${to?.name ?? ""}`,
                body: `Paket ${plan?.name ?? ""} berakhir ${date(end!)} seperti diminta.`,
              });
            }
            break;
          case "past_due": {
            await this.repo.updateSubscription(tx, live.id, {
              status: "past_due",
              statusChangedAt: now,
              remindedStage: "past_due",
            });
            const target = nextPlan ?? plan;
            if (!next && target && target.priceMonthly > 0) await this.createRenewalIn(tx, ctx, live, target, now);
            await this.notify(tx, ctx, {
              severity: "critical",
              reason: "past_due",
              title: `Tagihan ${target?.name ?? ""} belum dibayar`,
              body: `Paket ${plan?.name ?? ""} tetap aktif sampai ${date(addDays(end!, GRACE_DAYS))}. Setelah itu bisnis kembali ke Starter.`,
            });
            break;
          }
          case "expire":
            await this.endAndStartFreeIn(tx, ctx, live, "expired", now);
            await this.notify(tx, ctx, {
              severity: live.status === "trialing" ? "warning" : "critical",
              reason: live.status === "trialing" ? "trial_ended" : "expired",
              title:
                live.status === "trialing"
                  ? `Uji coba ${plan?.name ?? ""} berakhir; bisnis memakai paket Starter`
                  : `Paket ${plan?.name ?? ""} berakhir karena tagihan tidak dibayar`,
              body: "Fitur dan kuota mengikuti paket Starter mulai sekarang. Pilih paket di Langganan & Tagihan untuk kembali.",
            });
            break;
          case "downgrade":
            await this.endAndStartFreeIn(tx, ctx, live, "cancelled", now);
            await this.notify(tx, ctx, {
              severity: "info",
              reason: "downgraded",
              title: "Bisnis kini memakai paket Starter",
              body: `Paket ${plan?.name ?? ""} berakhir ${date(end!)} seperti diminta.`,
            });
            break;
          default:
            break;
        }
        return step.kind;
      });
      if (step === "none") break;
      done.push(step);
    }
    return done;
  }

  // ---- export (8.18) ----

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "langganan.csv",
        description: "Riwayat paket langganan: paket, status, periode, paket berikutnya, dan kapan berakhir.",
        columns: ["id", "paket", "status", "mulai", "sampai", "paket_berikutnya", "berakhir_pada", "dibuat_pada"],
        pages: (tx) =>
          singlePage(async () => {
            const names = await this.tenants.planNamesIn(tx);
            return (await this.repo.subscriptions(tx)).map((s) => [
              s.id,
              names.get(s.planId) ?? s.planId,
              s.status,
              s.currentPeriodStart,
              s.currentPeriodEnd,
              s.nextPlanId ? (names.get(s.nextPlanId) ?? s.nextPlanId) : null,
              s.endedAt,
              s.createdAt,
            ]);
          }),
      },
      {
        file: "tagihan.csv",
        description:
          "Tagihan langganan: nomor, jenis, paket, jumlah, potongan, periode, jatuh tempo, dan pembayarannya.",
        columns: [
          "nomor",
          "jenis",
          "paket",
          "status",
          "jumlah",
          "potongan",
          "periode_mulai",
          "periode_sampai",
          "jatuh_tempo",
          "dibayar_pada",
          "jumlah_dibayar",
          "metode",
          "kanal",
          "dibuat_pada",
        ],
        pages: (tx) =>
          singlePage(async () => {
            const names = await this.tenants.planNamesIn(tx);
            return (await this.repo.invoices(tx, 10_000)).map((i) => [
              i.number,
              i.kind === "upgrade" ? "naik paket" : "perpanjangan",
              names.get(i.planId) ?? i.planId,
              i.status,
              i.amount,
              i.creditAmount,
              i.periodStart,
              i.periodEnd,
              i.dueAt,
              i.paidAt,
              i.paidAmount,
              i.paymentMethod,
              i.paymentChannel,
              i.createdAt,
            ]);
          }),
      },
    ];
  }

  // ---- helpers ----

  private async planByCode(tx: Tx, code: string): Promise<PlanView> {
    const plan = (await this.tenants.listPlansIn(tx)).find((p) => p.code === code);
    if (!plan) throw new Error(`plan ${code} missing; run db:migrate`);
    return plan;
  }

  /** The invoice for the period after the current one: due when it starts, payable through the grace days. */
  private createRenewalIn(tx: Tx, ctx: RequestContext, live: SubscriptionRow, plan: PlanView, now: Date) {
    const start = live.currentPeriodEnd!;
    return this.createInvoiceIn(tx, ctx, {
      subscription: live,
      plan,
      kind: "renewal",
      credit: 0,
      periodStart: start,
      periodEnd: addMonth(start),
      dueAt: start,
      expiresAt: addDays(start, GRACE_DAYS),
      now,
    });
  }

  private async createInvoiceIn(
    tx: Tx,
    ctx: RequestContext,
    input: {
      subscription: SubscriptionRow;
      plan: PlanView;
      kind: InvoiceKind;
      credit: number;
      periodStart: Date;
      periodEnd: Date;
      dueAt: Date;
      expiresAt: Date;
      now: Date;
    },
  ): Promise<InvoiceRow> {
    const { timezone } = await this.tenants.profileIn(tx, ctx);
    const period = invoicePeriodOf(localDate(timezone, input.now));
    const n = await nextDocumentNumber(tx, ctx.tenantId, "invoice", period);
    const id = newId();
    await this.repo.insertInvoice(tx, {
      id,
      tenantId: ctx.tenantId,
      subscriptionId: input.subscription.id,
      planId: input.plan.id,
      number: invoiceNumber(period, n),
      kind: input.kind,
      status: "pending",
      amount: input.plan.priceMonthly - input.credit,
      creditAmount: input.credit,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      dueAt: input.dueAt,
      invoiceExpiresAt: input.expiresAt,
      requestedBy: ctx.actor.type === "user" ? ctx.actor.id : null,
    });
    await this.outbox.enqueue(tx, ctx, billingInvoiceRequested, { invoiceId: id }, id);
    return (await this.repo.invoice(tx, id))!;
  }

  /** A failed invoice asked from Xendit again, under the same number. */
  private async retryIn(tx: Tx, ctx: RequestContext, inv: InvoiceRow, now: Date): Promise<void> {
    await this.repo.updateInvoice(tx, inv.id, { status: "pending", statusChangedAt: now, error: null });
    await this.outbox.enqueue(tx, ctx, billingInvoiceRequested, { invoiceId: inv.id }, inv.id);
  }

  private async voidIn(tx: Tx, ctx: RequestContext, inv: InvoiceRow, reason: string, now: Date): Promise<void> {
    await this.repo.updateInvoice(tx, inv.id, { status: "void", statusChangedAt: now, error: reason });
    // its Xendit page must stop taking money; one still being made is closed when it arrives
    if (inv.externalInvoiceId) await this.outbox.enqueue(tx, ctx, billingInvoiceVoided, { invoiceId: inv.id }, inv.id);
  }

  private async voidPendingIn(
    tx: Tx,
    ctx: RequestContext,
    subscriptionId: string,
    reason: string,
    exceptId?: string,
  ): Promise<void> {
    for (const i of await this.repo.pendingInvoices(tx, subscriptionId)) {
      if (i.id !== exceptId) await this.voidIn(tx, ctx, i, reason, new Date());
    }
  }

  /** The next period, paid, has begun: the same plan carries on, another one takes over in a new row. */
  private async rollIn(tx: Tx, ctx: RequestContext, live: SubscriptionRow, inv: InvoiceRow, now: Date): Promise<void> {
    if (inv.planId !== live.planId) {
      await this.switchIn(tx, ctx, live, inv.id, inv.planId, inv.periodStart, inv.periodEnd, now);
      return;
    }
    await this.repo.updateSubscription(tx, live.id, {
      ...(live.status !== "active" ? { status: "active" as const, statusChangedAt: now } : {}),
      currentPeriodStart: inv.periodStart,
      currentPeriodEnd: inv.periodEnd,
      nextPlanId: null,
      remindedStage: null,
    });
  }

  /** Ends the live row and starts the paid plan's own, which the paying invoice now belongs to. */
  private async switchIn(
    tx: Tx,
    ctx: RequestContext,
    live: SubscriptionRow,
    invoiceId: string,
    planId: string,
    start: Date,
    end: Date,
    now: Date,
  ): Promise<void> {
    await this.repo.updateSubscription(tx, live.id, { status: "cancelled", statusChangedAt: now, endedAt: now });
    await this.voidPendingIn(tx, ctx, live.id, "Paket lain sudah dibayar.", invoiceId);
    const id = newId();
    await this.repo.insertSubscription(tx, {
      id,
      tenantId: ctx.tenantId,
      planId,
      status: "active",
      currentPeriodStart: start,
      currentPeriodEnd: end,
    });
    await this.repo.updateInvoice(tx, invoiceId, { subscriptionId: id });
    await this.tenants.setPlanIn(tx, ctx, planId);
  }

  /** Ends the live row and puts the business on Starter from now. */
  private async endAndStartFreeIn(
    tx: Tx,
    ctx: RequestContext,
    live: SubscriptionRow,
    endStatus: "expired" | "cancelled",
    now: Date,
  ): Promise<void> {
    const starter = await this.planByCode(tx, FREE_PLAN);
    await this.repo.updateSubscription(tx, live.id, { status: endStatus, statusChangedAt: now, endedAt: now });
    await this.voidPendingIn(
      tx,
      ctx,
      live.id,
      endStatus === "expired" ? "Paket berakhir." : "Paket diturunkan ke Starter.",
    );
    await this.repo.insertSubscription(tx, {
      id: newId(),
      tenantId: ctx.tenantId,
      planId: starter.id,
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: null,
    });
    await this.tenants.setPlanIn(tx, ctx, starter.id);
  }

  private async notify(
    tx: Tx,
    ctx: RequestContext,
    n: { severity: "info" | "warning" | "critical"; reason: string; title: string; body: string },
  ): Promise<void> {
    await this.inbox.notifyScopedIn(
      tx,
      ctx,
      "settings:billing",
      [{}],
      () => ({
        kind: "billing.reminder",
        severity: n.severity,
        title: n.title,
        body: n.body,
        data: { reason: n.reason },
      }),
      { email: true },
    );
  }
}
