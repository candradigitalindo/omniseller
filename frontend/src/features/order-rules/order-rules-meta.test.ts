import { describe, expect, it } from "vitest";
import {
  actionParts,
  conditionParts,
  draftOf,
  draftProblems,
  emptyDraft,
  fieldOfPath,
  KEEP_WAREHOUSE,
  moved,
  type Names,
  type OrderRule,
  ruleBody,
  rupiahValue,
  splitList,
} from "./order-rules-meta";

const RULE: OrderRule = {
  id: "01JRULE0000000000000000001",
  name: "SPX satuan",
  priority: 1,
  active: true,
  conditions: {
    storeIds: ["S1"],
    couriers: ["SPX", "J&T"],
    warehouseIds: [],
    skus: ["KAOS-M"],
    items: "single",
    minTotal: 50_000,
    maxTotal: null,
    withinOperatingHours: true,
  },
  actions: { warehouseId: "W2", tagIds: ["T1", "T9"], accept: true, arrange: "pickup", arrangeAt: null, print: null },
  pending: 0,
  createdAt: "2026-10-10T01:00:00.000Z",
  updatedAt: "2026-10-10T01:00:00.000Z",
  rowVersion: 1,
};

const names: Names = {
  store: (id) => ({ S1: "Toko Shopee" })[id],
  warehouse: (id) => ({ W2: "Gudang Surabaya" })[id],
  tag: (id) => ({ T1: "Kilat" })[id],
  agent: (id) => ({ D1: "PC Packing" })[id],
};

describe("the rule editor's draft (L55)", () => {
  it("reads a rule back into the form and sends the same rule", () => {
    const d = draftOf(RULE);
    expect(d).toMatchObject({
      couriers: "SPX, J&T",
      skus: "KAOS-M",
      minTotal: "50000",
      maxTotal: "",
      process: "pickup",
    });
    expect(ruleBody(d)).toEqual({
      name: "SPX satuan",
      active: true,
      conditions: RULE.conditions,
      actions: RULE.actions,
    });
  });

  it("sends nothing to do as no warehouse, no tags, and no processing", () => {
    const d = { ...emptyDraft(), name: "  Cek besar ", tagIds: ["T1"], maxTotal: "Rp 1.000.000" };
    expect(ruleBody(d)).toEqual({
      name: "Cek besar",
      active: true,
      conditions: {
        storeIds: [],
        couriers: [],
        warehouseIds: [],
        skus: [],
        items: "any",
        minTotal: null,
        maxTotal: 1_000_000,
        withinOperatingHours: false,
      },
      actions: { warehouseId: null, tagIds: ["T1"], accept: false, arrange: null, arrangeAt: null, print: null },
    });
    expect(ruleBody({ ...d, process: "accept" }).actions).toMatchObject({ accept: true, arrange: null });
    expect(ruleBody({ ...d, process: "dropoff" }).actions).toMatchObject({ accept: true, arrange: "dropoff" });
  });

  it("splits lists on commas and lines, and reads rupiah as written", () => {
    expect(splitList(" J&T , SiCepat\nJNE,, ")).toEqual(["J&T", "SiCepat", "JNE"]);
    expect(rupiahValue("")).toBeNull();
    expect(rupiahValue("Rp 150.000")).toBe(150_000);
    expect(rupiahValue("rp.75000")).toBe(75_000);
    expect(rupiahValue("150,5")).toBeNaN();
    expect(rupiahValue("-5")).toBeNaN();
  });

  it("asks for a name, rupiah amounts that run upwards, and something to do", () => {
    expect(draftProblems(emptyDraft())).toEqual({ name: "name", actions: "nothing" });
    const named = { ...emptyDraft(), name: "A", process: "accept" as const };
    expect(draftProblems(named)).toEqual({});
    expect(draftProblems({ ...named, minTotal: "abc" })).toEqual({ minTotal: "money" });
    expect(draftProblems({ ...named, minTotal: "200000", maxTotal: "100000" })).toEqual({ maxTotal: "range" });
    expect(draftProblems({ ...named, minTotal: "100000", maxTotal: "100000" })).toEqual({});
    expect(draftProblems({ ...emptyDraft(), name: "A", warehouseId: "W2" })).toEqual({});
    expect(draftProblems({ ...emptyDraft(), name: "A", warehouseId: KEEP_WAREHOUSE, tagIds: ["T1"] })).toEqual({});
  });

  it("puts the api's errors under their fields", () => {
    expect(fieldOfPath("conditions.storeIds.0")).toBe("storeIds");
    expect(fieldOfPath("conditions.maxTotal")).toBe("maxTotal");
    expect(fieldOfPath("actions.tagIds.1")).toBe("tagIds");
    expect(fieldOfPath("actions")).toBe("actions");
    expect(fieldOfPath("name")).toBe("name");
  });
});

describe("a rule's sentence", () => {
  it("says the conditions with names, leaving out what was deleted", () => {
    expect(conditionParts(RULE.conditions, names)).toEqual([
      { key: "when_stores", values: { names: "Toko Shopee" } },
      { key: "when_couriers", values: { names: "SPX, J&T" } },
      { key: "when_skus", values: { skus: "KAOS-M" } },
      { key: "when_items_single", values: {} },
      { key: "when_min", values: { min: 50_000 } },
      { key: "when_hours", values: {} },
    ]);
    expect(conditionParts({ ...RULE.conditions, storeIds: ["gone"], minTotal: 1, maxTotal: 9 }, names)).toEqual(
      expect.arrayContaining([
        { key: "when_stores", values: { names: "—" } },
        { key: "when_between", values: { min: 1, max: 9 } },
      ]),
    );
    expect(
      conditionParts(
        {
          storeIds: [],
          couriers: [],
          warehouseIds: [],
          skus: [],
          items: "any",
          minTotal: null,
          maxTotal: null,
          withinOperatingHours: false,
        },
        names,
      ),
    ).toEqual([]);
  });

  it("says the actions in the order they run", () => {
    expect(actionParts(RULE.actions, names)).toEqual([
      { key: "do_warehouse", values: { name: "Gudang Surabaya" } },
      { key: "do_tags", values: { names: "Kilat" } },
      { key: "do_pickup", values: {} },
    ]);
    expect(
      actionParts({ warehouseId: null, tagIds: [], accept: true, arrange: null, arrangeAt: null, print: null }, names),
    ).toEqual([{ key: "do_accept", values: {} }]);
    // a time of day and an automatic print, naming the agent (or not, when it is gone)
    const timed = {
      ...RULE.actions,
      warehouseId: null,
      tagIds: [],
      arrangeAt: "13:00",
      print: { deviceId: "D1", format: "thermal" as const, template: "standard" as const, packingList: true },
    };
    expect(actionParts(timed, names)).toEqual([
      { key: "do_pickup_at", values: { time: "13.00" } },
      { key: "do_print", values: { agent: "PC Packing" } },
    ]);
    expect(actionParts({ ...timed, print: { ...timed.print, deviceId: "gone" } }, names)[1]).toEqual({
      key: "do_print",
      values: { agent: "—" },
    });
  });

  it("reads and sends a time of day and an automatic print only with an arrange", () => {
    const rule: OrderRule = {
      ...RULE,
      actions: {
        ...RULE.actions,
        arrangeAt: "13:00",
        print: { deviceId: "D1", format: "a4", template: "custom", packingList: true },
      },
    };
    const d = draftOf(rule);
    expect(d).toMatchObject({
      process: "pickup",
      arrangeAt: "13:00",
      printDeviceId: "D1",
      printFormat: "a4",
      printTemplate: "custom",
      printPackingList: true,
    });
    expect(ruleBody(d).actions).toEqual(rule.actions);
    // switched to a plain accept: the time and the print are dropped, not refused by the api
    expect(ruleBody({ ...d, process: "accept" }).actions).toMatchObject({
      arrange: null,
      arrangeAt: null,
      print: null,
    });
    expect(draftProblems({ ...d, arrangeAt: "1pm" })).toEqual({ arrangeAt: "time" });
    expect(draftProblems({ ...d, arrangeAt: "" })).toEqual({});
    expect(draftProblems({ ...d, process: "accept", arrangeAt: "1pm" })).toEqual({});
  });

  it("moves one rule up or down, never past the ends", () => {
    expect(moved(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moved(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moved(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });
});
