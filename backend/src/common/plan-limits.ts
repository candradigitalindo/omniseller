import type { PlanLimits } from "../db/schema";
import { UnprocessableError } from "./errors/domain-errors";

/**
 * The quotas of a plan (PRD 15.1; backend doc 8.32): how many marketplace stores, warehouses, and
 * people a business may have, and how many orders a month it is meant for. `null` is unlimited. The
 * module that owns a table checks its own count against the plan in force (`TenantsService.planIn`).
 */
export type LimitMetric = keyof PlanLimits;

export const LIMIT_LABELS: Record<LimitMetric, string> = {
  stores: "toko marketplace",
  warehouses: "gudang",
  users: "pengguna",
  orders_per_month: "pesanan per bulan",
};

/** True when one more would go past the plan's quota. */
export function limitReached(limits: PlanLimits, metric: LimitMetric, current: number): boolean {
  const limit = limits[metric];
  return limit !== null && limit !== undefined && current >= limit;
}

export const planLimitReached = (planName: string, metric: LimitMetric, limit: number) =>
  new UnprocessableError(
    "billing.limit_reached",
    `Paket ${planName} membatasi ${limit} ${LIMIT_LABELS[metric]}. Naik paket di Langganan & Tagihan untuk menambah.`,
    undefined,
    { metric, limit, plan: planName },
  );
