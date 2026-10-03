import { describe, expect, it } from "vitest";
import {
  type AllocationRule,
  alertWorsened,
  allocate,
  type PlanChannelWarehouse,
  type PlanListing,
  type PlannedPush,
  type PlanStore,
  planStockPush,
  resolveRule,
  stockAlertOf,
  stockKey,
} from "./stock-plan";

const rule = (r: Partial<AllocationRule>): AllocationRule => ({
  id: "r",
  storeId: "S1",
  channelWarehouseId: null,
  variantId: null,
  mode: "all",
  value: 0,
  buffer: 0,
  priority: 100,
  active: true,
  ...r,
});

describe("allocate (FR-STK-02, 04)", () => {
  it("never shows negative stock and pushes everything without a rule", () => {
    expect(allocate(-3, null)).toBe(0);
    expect(allocate(12, null)).toBe(12);
  });

  it("takes the buffer off first, rounds percentages down, caps fixed amounts", () => {
    expect(allocate(10, rule({ buffer: 3 }))).toBe(7);
    expect(allocate(2, rule({ buffer: 3 }))).toBe(0);
    expect(allocate(10, rule({ mode: "percent", value: 50, buffer: 1 }))).toBe(4); // (10 - 1) * 50% = 4.5
    expect(allocate(10, rule({ mode: "fixed", value: 5 }))).toBe(5);
    expect(allocate(3, rule({ mode: "fixed", value: 5 }))).toBe(3);
  });

  it("respects the marketplace maximum", () => {
    expect(allocate(150_000, null, 99_999)).toBe(99_999);
  });
});

describe("resolveRule", () => {
  const rules = [
    rule({ id: "store" }),
    rule({ id: "cw", channelWarehouseId: "CW1" }),
    rule({ id: "variant", variantId: "V1" }),
    rule({ id: "both", channelWarehouseId: "CW1", variantId: "V1" }),
    rule({ id: "other-store", storeId: "S2", variantId: "V2" }),
    rule({ id: "off", variantId: "V3", active: false }),
  ];

  it("picks the most specific active rule of the store", () => {
    expect(resolveRule(rules, "S1", "CW1", "V1")?.id).toBe("both");
    expect(resolveRule(rules, "S1", "CW2", "V1")?.id).toBe("variant");
    expect(resolveRule(rules, "S1", "CW1", "V2")?.id).toBe("cw");
    expect(resolveRule(rules, "S1", "CW2", "V3")?.id).toBe("store");
    expect(resolveRule(rules, "S2", "CW9", "V9")).toBeNull();
  });

  it("breaks ties between equally specific rules by priority, then in favour of the variant rule", () => {
    const tie = [rule({ id: "a", channelWarehouseId: "CW1" }), rule({ id: "b", variantId: "V1" })];
    expect(resolveRule(tie, "S1", "CW1", "V1")?.id).toBe("b");
    const prio = [rule({ id: "a", channelWarehouseId: "CW1", priority: 10 }), rule({ id: "b", variantId: "V1" })];
    expect(resolveRule(prio, "S1", "CW1", "V1")?.id).toBe("a");
  });
});

const cw = (c: Partial<PlanChannelWarehouse> & { id: string }): PlanChannelWarehouse => ({
  externalId: c.id.toLowerCase(),
  kind: "seller",
  warehouseId: "W1",
  active: true,
  isDefault: false,
  ...c,
});

const store = (s: Partial<PlanStore> = {}): PlanStore => ({
  id: "S1",
  usable: true,
  live: true,
  maxStockQuantity: null,
  warehouses: [cw({ id: "CW1", externalId: "default", isDefault: true })],
  ...s,
});

const listing = (l: Partial<PlanListing> = {}): PlanListing => ({
  id: "L1",
  storeId: "S1",
  variantId: "V1",
  externalItemId: "100",
  externalVariantId: "11",
  status: "active",
  stockKeys: ["IDZ"],
  ...l,
});

function plan(input: {
  listings?: PlanListing[];
  stores?: PlanStore[];
  stock?: Record<string, { available: number; established?: boolean }>;
  rules?: AllocationRule[];
  states?: { listingId: string; channelWarehouseId: string; lastPushedQty: number | null; lastError?: string }[];
}) {
  return planStockPush({
    listings: input.listings ?? [listing()],
    stores: new Map((input.stores ?? [store()]).map((s) => [s.id, s])),
    stock: new Map(
      Object.entries(input.stock ?? { [stockKey("V1", "W1")]: { available: 7 } }).map(([k, v]) => [
        k,
        { available: v.available, established: v.established ?? true },
      ]),
    ),
    rules: input.rules ?? [],
    states: (input.states ?? []).map((s) => ({ ...s, lastError: s.lastError ?? null })),
  });
}

describe("planStockPush (backend doc 9.4)", () => {
  it("pushes to the listing's own stock location through the shop's single seller warehouse", () => {
    const [out] = plan({});
    expect(out).toEqual({
      kind: "push",
      listing: listing(),
      update: {
        externalItemId: "100",
        externalVariantId: "11",
        warehouses: [{ externalWarehouseId: "IDZ", quantity: 7 }],
      },
      targets: [{ channelWarehouseId: "CW1", quantity: 7 }],
    });
  });

  it("pauses read-only, disconnected, and partly unmapped stores (FR-MIG-05, FR-WHS-04)", () => {
    for (const s of [
      store({ live: false }),
      store({ usable: false }),
      store({ warehouses: [cw({ id: "CW1", externalId: "default" }), cw({ id: "CW2", warehouseId: null })] }),
    ]) {
      expect(plan({ stores: [s] })[0]).toMatchObject({ kind: "skip", reason: "store_paused" });
    }
  });

  it("skips banned and deleted listings and stock that was never established", () => {
    expect(plan({ listings: [listing({ status: "banned" })] })[0]).toMatchObject({ reason: "not_pushable" });
    expect(plan({ listings: [listing({ status: "deleted" })] })[0]).toMatchObject({ reason: "not_pushable" });
    expect(plan({ stock: { [stockKey("V1", "W1")]: { available: 7, established: false } } })[0]).toMatchObject({
      reason: "stock_not_set",
    });
    expect(plan({ stock: {} })[0]).toMatchObject({ reason: "stock_not_set" });
  });

  it("never pushes marketplace-managed stock (FR-MFS-02)", () => {
    const fbs = cw({ id: "CWF", externalId: "shopee_fbs", kind: "fulfillment", warehouseId: null });
    const s = store({ warehouses: [cw({ id: "CW1", externalId: "default" }), fbs] });
    expect(plan({ stores: [s], listings: [listing({ stockKeys: ["shopee_fbs"] })] })[0]).toMatchObject({
      reason: "marketplace_managed",
    });
    const mixed = plan({ stores: [s], listings: [listing({ stockKeys: ["IDZ", "shopee_fbs"] })] })[0] as PlannedPush;
    expect(mixed.update.warehouses).toEqual([{ externalWarehouseId: "IDZ", quantity: 7 }]);
  });

  it("refuses to guess a location in a multi-warehouse shop, and falls back to every seller warehouse when the listing reported none", () => {
    const s = store({
      warehouses: [cw({ id: "CW1", externalId: "LOC1" }), cw({ id: "CW2", externalId: "LOC2", warehouseId: "W2" })],
    });
    const stock = { [stockKey("V1", "W1")]: { available: 4 }, [stockKey("V1", "W2")]: { available: 9 } };
    expect(plan({ stores: [s], stock, listings: [listing({ stockKeys: ["LOC9"] })] })[0]).toMatchObject({
      reason: "unknown_warehouse",
    });
    const all = plan({ stores: [s], stock, listings: [listing({ stockKeys: [] })] })[0] as PlannedPush;
    expect(all.update.warehouses).toEqual([
      { externalWarehouseId: "LOC1", quantity: 4 },
      { externalWarehouseId: "LOC2", quantity: 9 },
    ]);
  });

  it("shows one physical warehouse once per listing: the default location gets it, the others 0", () => {
    const s = store({
      warehouses: [cw({ id: "CW1", externalId: "LOC1" }), cw({ id: "CW2", externalId: "LOC2", isDefault: true })],
    });
    const out = plan({ stores: [s], listings: [listing({ stockKeys: ["LOC1", "LOC2"] })] })[0] as PlannedPush;
    expect(out.update.warehouses).toEqual([
      { externalWarehouseId: "LOC1", quantity: 0 },
      { externalWarehouseId: "LOC2", quantity: 7 },
    ]);
    expect(out.targets).toEqual([
      { channelWarehouseId: "CW1", quantity: 0 },
      { channelWarehouseId: "CW2", quantity: 7 },
    ]);
  });

  it("applies the store's rules and the marketplace maximum", () => {
    const rules = [rule({ id: "half", mode: "percent", value: 50 }), rule({ id: "v", variantId: "V1", buffer: 2 })];
    expect((plan({ rules })[0] as PlannedPush).targets).toEqual([{ channelWarehouseId: "CW1", quantity: 5 }]);
    const capped = plan({ stores: [store({ maxStockQuantity: 5 })] })[0] as PlannedPush;
    expect(capped.targets[0]!.quantity).toBe(5);
  });

  it("leaves listings alone when the marketplace already has the value, and retries failed ones", () => {
    expect(plan({ states: [{ listingId: "L1", channelWarehouseId: "CW1", lastPushedQty: 7 }] })[0]).toMatchObject({
      kind: "unchanged",
    });
    expect(
      plan({ states: [{ listingId: "L1", channelWarehouseId: "CW1", lastPushedQty: 7, lastError: "busy" }] })[0],
    ).toMatchObject({ kind: "push" });
    expect(plan({ states: [{ listingId: "L1", channelWarehouseId: "CW1", lastPushedQty: null }] })[0]).toMatchObject({
      kind: "push",
    });
  });

  it("pushes 0 for oversold stock instead of a negative number", () => {
    const out = plan({ stock: { [stockKey("V1", "W1")]: { available: -2 } } })[0] as PlannedPush;
    expect(out.update.warehouses[0]!.quantity).toBe(0);
  });
});

describe("stock alerts (FR-NTF-01)", () => {
  it("is out when nothing is sellable and low at or under the minimum", () => {
    expect(stockAlertOf({ available: 0, minStock: 5, established: true })).toBe("out");
    expect(stockAlertOf({ available: -2, minStock: null, established: true })).toBe("out");
    expect(stockAlertOf({ available: 5, minStock: 5, established: true })).toBe("low");
    expect(stockAlertOf({ available: 6, minStock: 5, established: true })).toBeNull();
    expect(stockAlertOf({ available: 3, minStock: null, established: true })).toBeNull();
  });

  it("says nothing about stock nobody established (ADR-036)", () => {
    expect(stockAlertOf({ available: 0, minStock: 5, established: false })).toBeNull();
  });

  it("alerts only when the level gets worse than the one already sent", () => {
    expect(alertWorsened(null, "low")).toBe(true);
    expect(alertWorsened(null, "out")).toBe(true);
    expect(alertWorsened("low", "out")).toBe(true);
    expect(alertWorsened("low", "low")).toBe(false);
    expect(alertWorsened("out", "low")).toBe(false);
    expect(alertWorsened("out", null)).toBe(false);
    expect(alertWorsened(null, null)).toBe(false);
  });
});
