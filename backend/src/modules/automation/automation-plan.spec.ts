import { describe, expect, it } from "vitest";
import type { WeekSchedule } from "../../db/schema";
import { factsOf } from "./auto-process.service";
import {
  AUTO_PRINT_VALID_MS,
  actionPermissions,
  actionsProblem,
  type BusinessHours,
  conditionsProblem,
  firstMatch,
  needsHours,
  normalizeActions,
  normalizeConditions,
  type OrderFacts,
  openAt,
  printIntent,
  ruleMatches,
  type ScheduleInput,
  scheduledArrange,
} from "./automation-plan";

const order = (o: Partial<OrderFacts> = {}): OrderFacts => ({
  storeId: "S1",
  warehouseId: "W1",
  courier: "J&T Express",
  skus: ["KAOS-M"],
  units: 1,
  total: 100_000,
  ...o,
});

describe("ruleMatches (FR-ORD-19)", () => {
  it("matches any order when no condition is set", () => {
    expect(ruleMatches({}, order(), false)).toBe(true);
    expect(ruleMatches(normalizeConditions({}), order({ warehouseId: null, courier: null }), false)).toBe(true);
  });

  it("needs the order's store and warehouse among those named", () => {
    expect(ruleMatches({ storeIds: ["S1", "S2"] }, order(), true)).toBe(true);
    expect(ruleMatches({ storeIds: ["S2"] }, order(), true)).toBe(false);
    expect(ruleMatches({ warehouseIds: ["W1"] }, order(), true)).toBe(true);
    expect(ruleMatches({ warehouseIds: ["W2"] }, order(), true)).toBe(false);
    // an order whose warehouse is not known yet is in none of them
    expect(ruleMatches({ warehouseIds: ["W1"] }, order({ warehouseId: null }), true)).toBe(false);
  });

  it("compares couriers as cut-offs do: one name starts the other", () => {
    expect(ruleMatches({ couriers: ["J&T"] }, order({ courier: "J&T Express" }), true)).toBe(true);
    expect(ruleMatches({ couriers: ["jnt express"] }, order({ courier: "J&T Express" }), true)).toBe(false);
    expect(ruleMatches({ couriers: ["SiCepat", "JNE"] }, order({ courier: "JNE REG" }), true)).toBe(true);
    expect(ruleMatches({ couriers: ["JNE"] }, order({ courier: null }), true)).toBe(false);
  });

  it("needs one of the SKUs, without case or surrounding spaces", () => {
    expect(ruleMatches({ skus: [" kaos-m "] }, order({ skus: ["TAS-1", "KAOS-M"] }), true)).toBe(true);
    expect(ruleMatches({ skus: ["KAOS"] }, order({ skus: ["KAOS-M"] }), true)).toBe(false);
  });

  it("tells one item from several by units", () => {
    expect(ruleMatches({ items: "single" }, order({ units: 1 }), true)).toBe(true);
    expect(ruleMatches({ items: "single" }, order({ units: 2 }), true)).toBe(false);
    expect(ruleMatches({ items: "multiple" }, order({ units: 2 }), true)).toBe(true);
    expect(ruleMatches({ items: "multiple" }, order({ units: 1 }), true)).toBe(false);
    expect(ruleMatches({ items: "any" }, order({ units: 7 }), true)).toBe(true);
  });

  it("keeps the total inside its range, both ends included", () => {
    expect(ruleMatches({ minTotal: 100_000 }, order({ total: 100_000 }), true)).toBe(true);
    expect(ruleMatches({ minTotal: 100_001 }, order({ total: 100_000 }), true)).toBe(false);
    expect(ruleMatches({ maxTotal: 100_000 }, order({ total: 100_000 }), true)).toBe(true);
    expect(ruleMatches({ maxTotal: 99_999 }, order({ total: 100_000 }), true)).toBe(false);
    expect(ruleMatches({ minTotal: 0, maxTotal: null }, order({ total: 0 }), true)).toBe(true);
  });

  it("acts within operating hours only when asked to", () => {
    expect(ruleMatches({ withinOperatingHours: true }, order(), false)).toBe(false);
    expect(ruleMatches({ withinOperatingHours: true }, order(), true)).toBe(true);
    expect(ruleMatches({ withinOperatingHours: false }, order(), false)).toBe(true);
  });
});

describe("firstMatch", () => {
  const rule = (id: string, priority: number, conditions = {}, active = true) => ({ id, priority, active, conditions });

  it("takes the first active rule by priority whose conditions hold", () => {
    const rules = [
      rule("R3", 3, {}),
      rule("R1", 1, { storeIds: ["S9"] }),
      rule("R2", 2, { skus: ["KAOS-M"] }),
      rule("R0", 0, {}, false),
    ];
    expect(firstMatch(rules, order(), true)?.id).toBe("R2");
    expect(firstMatch(rules, order({ skus: ["TAS"] }), true)?.id).toBe("R3");
  });

  it("breaks a tie by age (the older id) and finds nothing when nothing holds", () => {
    expect(firstMatch([rule("B", 1), rule("A", 1)], order(), true)?.id).toBe("A");
    expect(firstMatch([rule("A", 1, { storeIds: ["S9"] })], order(), true)).toBeNull();
    expect(firstMatch([], order(), true)).toBeNull();
  });
});

describe("openAt (operating hours, L43)", () => {
  const nineToFive = { open: "09:00", close: "17:00" };
  // Sunday closed, Monday to Saturday 09.00 to 17.00
  const week: WeekSchedule = [null, nineToFive, nineToFive, nineToFive, nineToFive, nineToFive, nineToFive];
  const hours = (h: Partial<BusinessHours> = {}): BusinessHours => ({
    timezone: "Asia/Jakarta",
    week,
    periods: [],
    ...h,
  });

  it("is open whenever the business set no hours", () => {
    expect(openAt(null, new Date("2026-10-11T20:00:00Z"))).toBe(true);
    expect(openAt(hours({ week: null }), new Date("2026-10-11T20:00:00Z"))).toBe(true);
  });

  it("opens at the opening minute and closes at the closing minute, in the business's time zone", () => {
    // Monday 12 October 2026: 09.00 WIB is 02.00 UTC
    expect(openAt(hours(), new Date("2026-10-12T01:59:59Z"))).toBe(false);
    expect(openAt(hours(), new Date("2026-10-12T02:00:00Z"))).toBe(true);
    expect(openAt(hours(), new Date("2026-10-12T09:59:59Z"))).toBe(true);
    expect(openAt(hours(), new Date("2026-10-12T10:00:00Z"))).toBe(false);
    // the same moment in Makassar (WITA) is an hour later
    expect(openAt(hours({ timezone: "Asia/Makassar" }), new Date("2026-10-12T09:30:00Z"))).toBe(false);
  });

  it("is closed on a closed day, and a special period replaces the week on its dates", () => {
    // Sunday 11 October 2026, noon WIB
    expect(openAt(hours(), new Date("2026-10-11T05:00:00Z"))).toBe(false);
    const ramadan = {
      from: "2026-10-11",
      to: "2026-10-12",
      schedule: Array(7).fill({ open: "07:00", close: "12:00" }),
    };
    expect(openAt(hours({ periods: [ramadan] }), new Date("2026-10-11T01:00:00Z"))).toBe(true);
    expect(openAt(hours({ periods: [ramadan] }), new Date("2026-10-12T06:00:00Z"))).toBe(false);
    // after the period the week is back
    expect(openAt(hours({ periods: [ramadan] }), new Date("2026-10-13T06:00:00Z"))).toBe(true);
  });
});

describe("saving a rule", () => {
  it("reads the hours only for an active rule that asks for them", () => {
    const at = (active: boolean, withinOperatingHours: boolean) => ({ active, conditions: { withinOperatingHours } });
    expect(needsHours([at(true, false), at(false, true)])).toBe(false);
    expect(needsHours([at(true, false), at(true, true)])).toBe(true);
  });

  it("stores conditions without repeats, couriers and SKUs tidied, any spelled out", () => {
    expect(
      normalizeConditions({
        storeIds: ["S1", "S1"],
        couriers: [" J&T  Express", "j&t express", ""],
        skus: ["kaos-m", "KAOS-M ", "TAS"],
      }),
    ).toEqual({
      storeIds: ["S1"],
      couriers: ["J&T Express"],
      warehouseIds: [],
      skus: ["kaos-m", "TAS"],
      items: "any",
      minTotal: null,
      maxTotal: null,
      withinOperatingHours: false,
    });
  });

  it("makes arranging accept as well, and fills the print instruction", () => {
    expect(normalizeActions({ arrange: "pickup" })).toEqual({
      warehouseId: null,
      tagIds: [],
      accept: true,
      arrange: "pickup",
      arrangeAt: null,
      print: null,
    });
    expect(normalizeActions({ tagIds: ["T1", "T1"], accept: false })).toEqual({
      warehouseId: null,
      tagIds: ["T1"],
      accept: false,
      arrange: null,
      arrangeAt: null,
      print: null,
    });
    expect(normalizeActions({ arrange: "dropoff", arrangeAt: "13:00", print: { deviceId: "D1" } })).toMatchObject({
      arrangeAt: "13:00",
      print: { deviceId: "D1", format: "thermal", template: "standard", packingList: false },
    });
  });

  it("must do something, and a total range must run upwards", () => {
    expect(actionsProblem({})).toEqual({ path: "actions", message: "Pilih paling sedikit satu tindakan." });
    expect(actionsProblem({ tagIds: [], accept: false, arrange: null, warehouseId: null })).not.toBeNull();
    expect(actionsProblem({ warehouseId: "W2" })).toBeNull();
    expect(actionsProblem({ tagIds: ["T1"] })).toBeNull();
    expect(actionsProblem({ accept: true })).toBeNull();
    expect(actionsProblem({ arrange: "dropoff" })).toBeNull();
    expect(conditionsProblem({ minTotal: 200_000, maxTotal: 100_000 })).not.toBeNull();
    expect(conditionsProblem({ minTotal: 100_000, maxTotal: 100_000 })).toBeNull();
    expect(conditionsProblem({ minTotal: 200_000 })).toBeNull();
  });

  it("keeps a time and a print only with an arrange, and the time well formed", () => {
    expect(actionsProblem({ arrange: "pickup", arrangeAt: "13:00" })).toBeNull();
    expect(actionsProblem({ accept: true, arrangeAt: "13:00" })).toEqual({
      path: "actions.arrangeAt",
      message: "Jam hanya untuk Atur pengiriman.",
    });
    expect(actionsProblem({ arrange: "pickup", arrangeAt: "25:00" })?.path).toBe("actions.arrangeAt");
    expect(actionsProblem({ arrange: "pickup", arrangeAt: "9:00" })?.path).toBe("actions.arrangeAt");
    expect(actionsProblem({ arrange: "pickup", print: { deviceId: "D1" } })).toBeNull();
    expect(actionsProblem({ accept: true, print: { deviceId: "D1" } })?.path).toBe("actions.print");
  });

  it("needs the permissions of the buttons the rule presses", () => {
    expect(actionPermissions({ accept: true })).toEqual(["order:accept"]);
    expect(actionPermissions({ warehouseId: "W1" })).toEqual(["order:accept"]);
    expect(actionPermissions({ tagIds: ["T1"], arrange: "pickup" }).sort()).toEqual([
      "order:accept",
      "order:tag",
      "shipment:arrange",
    ]);
    expect(actionPermissions({ arrange: "pickup", print: { deviceId: "D1" } }).sort()).toEqual([
      "order:accept",
      "shipment:arrange",
      "shipment:print",
    ]);
  });
});

describe("scheduledArrange (a rule with a time of day)", () => {
  const nine = { open: "09:00", close: "17:00" };
  const hours = { week: [null, nine, nine, nine, nine, nine, nine], periods: [] };
  const at = (iso: string) => ({ at: new Date(iso) });
  const plan = (over: Partial<ScheduleInput>) =>
    scheduledArrange({
      time: "13:00",
      timezone: "Asia/Jakarta",
      hours: null,
      now: new Date("2026-10-12T02:00:00Z"),
      deadline: null,
      ...over,
    });

  it("takes the time today when it is still ahead, else tomorrow, in the business's zone", () => {
    // Monday 12 October 2026, 09.00 WIB -> 13.00 WIB today
    expect(plan({})).toEqual(at("2026-10-12T06:00:00Z"));
    // 14.00 WIB -> tomorrow
    expect(plan({ now: new Date("2026-10-12T07:00:00Z") })).toEqual(at("2026-10-13T06:00:00Z"));
    // Makassar is an hour ahead: 13.00 WITA is 05.00 UTC
    expect(plan({ timezone: "Asia/Makassar" })).toEqual(at("2026-10-12T05:00:00Z"));
  });

  it("lets an order a minute late join today's batch, but not an order later than that", () => {
    expect(plan({ now: new Date("2026-10-12T06:00:40Z") })).toEqual(at("2026-10-12T06:00:00Z"));
    expect(plan({ now: new Date("2026-10-12T06:01:01Z") })).toEqual(at("2026-10-13T06:00:00Z"));
  });

  it("skips days the business is closed or already shut at that time", () => {
    // Saturday 17 October 2026, 20.00 WIB: Sunday is closed, so Monday
    expect(plan({ hours, now: new Date("2026-10-17T13:00:00Z") })).toEqual(at("2026-10-19T06:00:00Z"));
    // a 18.00 rule falls after closing every day: nothing within the search, arrange now
    expect(plan({ hours, time: "18:00" })).toEqual({ now: "no_slot" });
    // no hours set: any day, any time
    expect(plan({ time: "18:00" })).toEqual(at("2026-10-12T11:00:00Z"));
  });

  it("arranges at once when waiting would run into the order's deadline", () => {
    // cut-off 15.00 WIB: 13.00 is 2 hours before, enough
    expect(plan({ deadline: new Date("2026-10-12T08:00:00Z") })).toEqual(at("2026-10-12T06:00:00Z"));
    // cut-off 14.00 WIB: less than 90 minutes after 13.00
    expect(plan({ deadline: new Date("2026-10-12T07:00:00Z") })).toEqual({ now: "deadline" });
    expect(plan({ time: "x" })).toEqual({ now: "no_slot" });
  });

  it("gives a shipment its print instruction, valid for a while after the arrange", () => {
    const now = new Date("2026-10-12T02:00:00Z");
    expect(printIntent({ deviceId: "D1", format: "a4", template: "custom", packingList: true }, "R1", now)).toEqual({
      deviceId: "D1",
      format: "a4",
      template: "custom",
      packingList: true,
      ruleId: "R1",
      until: new Date(now.getTime() + AUTO_PRINT_VALID_MS).toISOString(),
    });
  });
});

describe("factsOf", () => {
  it("reads both the product's SKU and the marketplace's, and counts open units", () => {
    const facts = factsOf({ storeId: "S1", warehouseId: null, shippingProvider: "SPX Standard", total: 90_000 }, [
      { skuSnapshot: "kaos m", sku: "KAOS-M", units: 2 },
      { skuSnapshot: "TAS-1", sku: null, units: 1 },
    ]);
    expect(facts).toEqual({
      storeId: "S1",
      warehouseId: null,
      courier: "SPX Standard",
      skus: ["KAOS-M", "kaos m", "TAS-1"],
      units: 3,
      total: 90_000,
    });
  });
});
