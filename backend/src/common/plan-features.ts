import { UnprocessableError } from "./errors/domain-errors";

/**
 * What a plan unlocks beyond its quotas (PRD 14; backend doc 8.32 and 8.33): `plan.features`. The module
 * that owns a feature checks the plan in force (`TenantsService.planIn`) in the transaction that writes,
 * as quotas are checked. What a business made while its plan had a feature stays usable after it moves
 * down; it only cannot be made, changed, or handed to someone new.
 */
export const PLAN_FEATURES = { custom_roles: "Peran kustom" } as const;
export type PlanFeature = keyof typeof PLAN_FEATURES;

interface PlanLike {
  name: string;
  features: readonly string[];
}

export function hasFeature(plan: Pick<PlanLike, "features">, feature: PlanFeature): boolean {
  return plan.features.includes(feature);
}

/** The cheapest plan on offer that has the feature, for "tersedia mulai paket ...". */
export function cheapestWith(
  feature: PlanFeature,
  plans: readonly (PlanLike & { priceMonthly: number; active: boolean })[],
): PlanLike | null {
  return (
    plans.filter((p) => p.active && hasFeature(p, feature)).sort((a, b) => a.priceMonthly - b.priceMonthly)[0] ?? null
  );
}

export const planFeatureUnavailable = (feature: PlanFeature, plan: Pick<PlanLike, "name">, from: PlanLike | null) =>
  new UnprocessableError(
    "billing.feature_unavailable",
    `${PLAN_FEATURES[feature]} tidak termasuk paket ${plan.name}.${
      from ? ` Tersedia mulai paket ${from.name}; naik paket di Langganan & Tagihan.` : ""
    }`,
    undefined,
    { feature, plan: plan.name, requiredPlan: from?.name ?? null },
  );
