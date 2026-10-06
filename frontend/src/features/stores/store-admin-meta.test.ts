import { describe, expect, it } from "vitest";
import {
  allocatePreview,
  callsOf,
  durationText,
  logFilterOf,
  partialFailures,
  type Rule,
  ruleBody,
  ruleDraftOf,
  rulePatch,
  ruleProblems,
  ruleScope,
  storeTabOf,
  syncKindKey,
} from "./store-admin-meta";

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: "01JRULE0000000000000000001",
    storeId: "01JSTORE000000000000000001",
    channelWarehouseId: null,
    variantId: null,
    mode: "percent",
    value: 50,
    buffer: 1,
    priority: 100,
    active: true,
    variant: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    ...over,
  };
}

describe("a store's page", () => {
  it("opens the tab from the URL, and a manual sales channel on its settings", () => {
    expect(storeTabOf("log", false)).toBe("log");
    expect(storeTabOf("gudang", false)).toBe("gudang");
    expect(storeTabOf("lain", false)).toBe("koneksi");
    expect(storeTabOf(null, false)).toBe("koneksi");
    expect(storeTabOf("log", true)).toBe("pengaturan");
  });

  it("filters the log by the outcomes it offers", () => {
    expect(logFilterOf("failed")).toBe("failed");
    expect(logFilterOf("skipped")).toBe("skipped");
    expect(logFilterOf("succeeded")).toBeNull();
    expect(logFilterOf(null)).toBeNull();
  });

  it("names known sync work in words and leaves the rest as written", () => {
    expect(syncKindKey("orders.pull")).toBe("orders_pull");
    expect(syncKindKey("listings.status_push")).toBe("listings_status_push");
    expect(syncKindKey("products.image_upload")).toBe("products_image_upload");
    expect(syncKindKey("orders.unknown")).toBeNull();
  });

  it("says how long a job took", () => {
    expect(durationText(null)).toBeNull();
    expect(durationText(0)).toBe("<0,1 dtk");
    expect(durationText(99)).toBe("<0,1 dtk");
    expect(durationText(100)).toBe("0,1 dtk");
    expect(durationText(420)).toBe("0,4 dtk");
    expect(durationText(999)).toBe("1,0 dtk");
    expect(durationText(1_000)).toBe("1 dtk");
    expect(durationText(12_400)).toBe("12 dtk");
    expect(durationText(59_999)).toBe("60 dtk");
    expect(durationText(60_000)).toBe("1 mnt 0 dtk");
    expect(durationText(125_000)).toBe("2 mnt 5 dtk");
  });

  it("reads the calls of a job whatever the record holds", () => {
    expect(
      callsOf({
        calls: [
          {
            method: "GET",
            path: "/api/v2/shop/get_shop_info?access_token=[redacted]",
            httpStatus: 200,
            durationMs: 120,
          },
          { method: "POST", path: "/x", httpStatus: null, errorCode: "timeout" },
          { path: 42 },
        ],
      }),
    ).toEqual([
      { method: "GET", path: "/api/v2/shop/get_shop_info?access_token=[redacted]", status: 200, ms: 120, error: null },
      { method: "POST", path: "/x", status: null, ms: null, error: "timeout" },
      { method: "?", path: "?", status: null, ms: null, error: null },
    ]);
  });
});

describe("work refused in part", () => {
  it("counts the refused listings and gives the first reason", () => {
    expect(partialFailures({ result: null })).toBeNull();
    expect(partialFailures({ result: { ok: 3, failed: [] } })).toBeNull();
    expect(partialFailures({ result: { ok: 1, failed: "x" } })).toBeNull();
    expect(
      partialFailures({
        result: {
          ok: 1,
          failed: [
            { item: "1", error: "Stok di bawah cadangan promo." },
            { item: "2", error: "lain" },
          ],
        },
      }),
    ).toEqual({ count: 2, reason: "Stok di bawah cadangan promo." });
    expect(partialFailures({ result: { failed: [{ item: "1" }] } })).toEqual({ count: 1, reason: null });
    expect(partialFailures({ result: { failed: [null] } })).toEqual({ count: 1, reason: null });
  });
});

describe("stock allocation rules", () => {
  it("says what a rule covers", () => {
    expect(ruleScope({ channelWarehouseId: null, variantId: null })).toBe("store");
    expect(ruleScope({ channelWarehouseId: "W", variantId: null })).toBe("warehouse");
    expect(ruleScope({ channelWarehouseId: null, variantId: "V" })).toBe("variant");
    expect(ruleScope({ channelWarehouseId: "W", variantId: "V" })).toBe("both");
  });

  it("shows what a marketplace gets, as the api counts it", () => {
    expect(allocatePreview(20, null)).toBe(20);
    expect(allocatePreview(-3, null)).toBe(0);
    // (20 - 1) at 50%, rounded down
    expect(allocatePreview(20, { mode: "percent", value: 50, buffer: 1 })).toBe(9);
    expect(allocatePreview(20, { mode: "fixed", value: 5, buffer: 0 })).toBe(5);
    expect(allocatePreview(3, { mode: "fixed", value: 5, buffer: 0 })).toBe(3);
    expect(allocatePreview(20, { mode: "all", value: 0, buffer: 4 })).toBe(16);
    expect(allocatePreview(2, { mode: "all", value: 0, buffer: 5 })).toBe(0);
    expect(allocatePreview(-2, { mode: "fixed", value: 5, buffer: 0 })).toBe(0);
  });

  it("starts a new rule as a percentage, and an existing one as it is", () => {
    expect(ruleDraftOf(null)).toEqual({
      channelWarehouseId: null,
      variantId: null,
      mode: "percent",
      value: "",
      buffer: "0",
      priority: "100",
      active: true,
    });
    expect(ruleDraftOf(rule({ mode: "all", value: 0, buffer: 2, priority: 5, active: false }))).toMatchObject({
      mode: "all",
      value: "",
      buffer: "2",
      priority: "5",
      active: false,
    });
    expect(ruleDraftOf(rule({ channelWarehouseId: "W", variantId: "V" }))).toMatchObject({
      channelWarehouseId: "W",
      variantId: "V",
      value: "50",
    });
  });

  it("checks the numbers of a rule", () => {
    const d = ruleDraftOf(null);
    expect(ruleProblems({ ...d, value: "" })).toEqual({ value: "required" });
    expect(ruleProblems({ ...d, mode: "all", value: "" })).toEqual({});
    expect(ruleProblems({ ...d, value: "12.5" })).toEqual({ value: "wholeNumber" });
    expect(ruleProblems({ ...d, value: "100" })).toEqual({});
    expect(ruleProblems({ ...d, value: "101" })).toEqual({ value: "percentMax" });
    expect(ruleProblems({ ...d, mode: "fixed", value: "101" })).toEqual({});
    expect(ruleProblems({ ...d, mode: "fixed", value: "10000001" })).toEqual({ value: "tooLarge" });
    expect(ruleProblems({ ...d, value: "50", buffer: "-1" })).toEqual({ buffer: "wholeNumber" });
    expect(ruleProblems({ ...d, value: "50", buffer: "10000001" })).toEqual({ buffer: "tooLarge" });
    expect(ruleProblems({ ...d, value: "50", buffer: "" })).toEqual({});
    expect(ruleProblems({ ...d, value: "50", priority: "1000" })).toEqual({});
    expect(ruleProblems({ ...d, value: "50", priority: "1001" })).toEqual({ priority: "priorityRange" });
    expect(ruleProblems({ ...d, value: "50", priority: "x" })).toEqual({ priority: "priorityRange" });
    expect(ruleProblems({ ...d, value: "50", priority: "" })).toEqual({});
  });

  it("sends a new rule with its defaults and without a value for all stock", () => {
    const d = { ...ruleDraftOf(null), value: " 40 ", buffer: "", priority: "", channelWarehouseId: "W" };
    expect(ruleBody("S", d)).toEqual({
      storeId: "S",
      channelWarehouseId: "W",
      variantId: null,
      mode: "percent",
      value: 40,
      buffer: 0,
      priority: 100,
      active: true,
    });
    expect(ruleBody("S", { ...d, mode: "all" })).not.toHaveProperty("value");
  });

  it("sends only what changed of a rule", () => {
    const r = rule();
    expect(rulePatch(r, ruleDraftOf(r))).toBeNull();
    expect(rulePatch(r, { ...ruleDraftOf(r), value: "60" })).toEqual({ value: 60 });
    expect(rulePatch(r, { ...ruleDraftOf(r), mode: "fixed" })).toEqual({ mode: "fixed", value: 50 });
    expect(rulePatch(r, { ...ruleDraftOf(r), mode: "all", value: "" })).toEqual({ mode: "all" });
    expect(rulePatch(r, { ...ruleDraftOf(r), buffer: "", priority: "7", active: false })).toEqual({
      buffer: 0,
      priority: 7,
      active: false,
    });
  });
});
