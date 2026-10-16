import { describe, expect, it } from "vitest";
import { cheapestWith, hasFeature, planFeatureUnavailable } from "./plan-features";

const plans = [
  { name: "Business", features: ["auto_process", "public_api"], priceMonthly: 2_499_000, active: true },
  { name: "Starter", features: [], priceMonthly: 0, active: true },
  { name: "Growth", features: ["auto_process"], priceMonthly: 899_000, active: true },
  { name: "Growth Lama", features: ["auto_process"], priceMonthly: 499_000, active: false },
];

describe("plan features (backend doc 8.32)", () => {
  it("knows what a plan has, and the cheapest plan still offered that has it", () => {
    expect(hasFeature(plans[2]!, "auto_process")).toBe(true);
    expect(hasFeature(plans[1]!, "auto_process")).toBe(false);
    expect(cheapestWith("auto_process", plans)?.name).toBe("Growth");
    expect(cheapestWith("auto_process", [plans[1]!])).toBeNull();
  });

  it("refuses with the plan in force and where the feature starts", () => {
    const e = planFeatureUnavailable("auto_process", { name: "Starter" }, plans[2]!);
    expect(e.code).toBe("billing.feature_unavailable");
    expect(e.detail).toBe(
      "Aturan proses otomatis tidak termasuk paket Starter. Tersedia mulai paket Growth; naik paket di Langganan & Tagihan.",
    );
    expect(e.extensions).toEqual({ feature: "auto_process", plan: "Starter", requiredPlan: "Growth" });
    expect(planFeatureUnavailable("auto_process", { name: "Starter" }, null).detail).toBe(
      "Aturan proses otomatis tidak termasuk paket Starter.",
    );
  });
});
