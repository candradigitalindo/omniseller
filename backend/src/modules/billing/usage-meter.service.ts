import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { LimitMetric } from "../../common/plan-limits";
import { localDate } from "../../common/time-zone";
import type { Tx } from "../../db/client";
import { type PlanView, TenantsService } from "../identity/tenants.service";
import { NotificationInboxService } from "../notification/inbox.service";
import { BillingRepository } from "./billing.repository";
import { usagePeriodOf, usageWarning } from "./billing-plan";

/** What is metered, and the plan quota each metric is held against. */
export const USAGE_METRICS = { orders: "orders_per_month" } as const satisfies Record<string, LimitMetric>;
export type UsageMetric = keyof typeof USAGE_METRICS;

export interface UsageView {
  metric: UsageMetric;
  period: string;
  value: number;
  limit: number | null;
}

/**
 * Monthly usage against the plan's quota (PRD 15.1, backend doc 8.32): orders are counted as they come
 * in, in the month of the business's time zone, and whoever keeps the money hears once at 80% and once at
 * 100%. Nothing is ever refused for being over quota: an order that came in is an order to ship.
 */
@Injectable()
export class UsageMeterService {
  /** The business's time zone and plan, read once per transaction (a page of orders counts many). */
  private readonly context = new WeakMap<Tx, Promise<{ timezone: string; plan: PlanView }>>();

  constructor(
    @Inject(BillingRepository) private readonly repo: BillingRepository,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(NotificationInboxService) private readonly inbox: NotificationInboxService,
  ) {}

  /** Counts `by` towards the month of `at`, in the caller's transaction. */
  async countIn(tx: Tx, ctx: RequestContext, metric: UsageMetric, at: Date, by = 1): Promise<void> {
    const { timezone, plan } = await this.contextIn(tx, ctx);
    const period = usagePeriodOf(localDate(timezone, at));
    const row = await this.repo.bumpUsage(tx, ctx.tenantId, newId(), metric, period, by);
    const limit = plan.limits[USAGE_METRICS[metric]] ?? null;
    const warning = usageWarning(row.value, limit, row.warnedPct);
    if (!warning || !limit) return;
    await this.repo.markWarned(tx, row.id, warning);
    const n = new Intl.NumberFormat("id-ID");
    await this.inbox.notifyScopedIn(
      tx,
      ctx,
      "settings:billing",
      [{}],
      () => ({
        kind: "billing.reminder",
        severity: warning >= 100 ? "warning" : "info",
        title:
          warning >= 100
            ? `Pesanan bulan ini melewati kuota paket ${plan.name}`
            : `Pesanan bulan ini mencapai ${warning}% kuota paket ${plan.name}`,
        body: `${n.format(row.value)} dari ${n.format(limit)} pesanan per bulan. Pesanan tetap diproses; naik paket di Langganan & Tagihan agar kuotanya cukup.`,
        data: { reason: "usage", metric, value: row.value, limit, period },
      }),
      { email: true },
    );
  }

  /** This month's usage of a metric and the quota it is held against. */
  async usageIn(tx: Tx, ctx: RequestContext, metric: UsageMetric, now = new Date()): Promise<UsageView> {
    const { timezone, plan } = await this.contextIn(tx, ctx);
    const period = usagePeriodOf(localDate(timezone, now));
    const row = await this.repo.usage(tx, metric, period);
    return { metric, period, value: row?.value ?? 0, limit: plan.limits[USAGE_METRICS[metric]] ?? null };
  }

  private contextIn(tx: Tx, ctx: RequestContext): Promise<{ timezone: string; plan: PlanView }> {
    let found = this.context.get(tx);
    if (!found) {
      found = (async () => ({
        timezone: (await this.tenants.profileIn(tx, ctx)).timezone,
        plan: await this.tenants.planIn(tx, ctx),
      }))();
      this.context.set(tx, found);
    }
    return found;
  }
}
