import { describe, expect, it } from "vitest";
import { cheapestWith, hasFeature, planFeatureUnavailable } from "./plan-features";

const plans = [
  { name: "Business", features: ["custom_roles", "public_api"], priceMonthly: 2_499_000, active: true },
  { name: "Starter", features: [], priceMonthly: 0, active: true },
  { name: "Growth", features: ["custom_roles"], priceMonthly: 899_000, active: true },
  { name: "Growth Lama", features: ["custom_roles"], priceMonthly: 499_000, active: false },
];

describe("plan features (backend doc 8.32)", () => {
  it("knows what a plan has, and the cheapest plan still offered that has it", () => {
    expect(hasFeature(plans[2]!, "custom_roles")).toBe(true);
    expect(hasFeature(plans[1]!, "custom_roles")).toBe(false);
    expect(cheapestWith("custom_roles", plans)?.name).toBe("Growth");
    expect(cheapestWith("custom_roles", [plans[1]!])).toBeNull();
  });

  it("refuses with the plan in force and where the feature starts", () => {
    const e = planFeatureUnavailable("custom_roles", { name: "Starter" }, plans[2]!);
    expect(e.code).toBe("billing.feature_unavailable");
    expect(e.detail).toBe(
      "Peran kustom tidak termasuk paket Starter. Tersedia mulai paket Growth; naik paket di Langganan & Tagihan.",
    );
    expect(e.extensions).toEqual({ feature: "custom_roles", plan: "Starter", requiredPlan: "Growth" });
    expect(planFeatureUnavailable("custom_roles", { name: "Starter" }, null).detail).toBe(
      "Peran kustom tidak termasuk paket Starter.",
    );
  });
});
