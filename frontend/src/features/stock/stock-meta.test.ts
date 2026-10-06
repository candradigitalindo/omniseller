import { describe, expect, it } from "vitest";
import {
  adjustedOnHand,
  criticalStockHref,
  historyHref,
  type LocationDraft,
  locationDrafts,
  locationPatch,
  locationProblems,
  stockFilterOf,
  type Warehouse,
  warehouseColumns,
} from "./stock-meta";

const warehouse = (id: string, active = true): Warehouse => ({
  id,
  code: id.toUpperCase(),
  name: `Gudang ${id}`,
  isDefault: id === "a",
  active,
  address: {},
  createdAt: "2026-09-01T00:00:00.000Z",
});

describe("stock helpers", () => {
  it("computes the stock on hand after a count or a difference", () => {
    expect(adjustedOnHand(10, "set", 7)).toBe(7);
    expect(adjustedOnHand(10, "delta", -3)).toBe(7);
    expect(adjustedOnHand(2, "delta", -5)).toBe(-3);
  });

  it("accepts only the api's stock filters from the URL", () => {
    expect(stockFilterOf("low")).toBe("low");
    expect(stockFilterOf("negative")).toBe("negative");
    expect(stockFilterOf("LOW")).toBeNull();
    expect(stockFilterOf(null)).toBeNull();
  });

  it("shows the filtered warehouse, else the active ones", () => {
    const all = [warehouse("a"), warehouse("b", false), warehouse("c")];
    expect(warehouseColumns(all, null).map((w) => w.id)).toEqual(["a", "c"]);
    expect(warehouseColumns(all, "b").map((w) => w.id)).toEqual(["b"]);
  });

  it("leads a stock alert to its one SKU, else to the whole list", () => {
    expect(criticalStockHref([{ sku: "KAOS HTM/L" }])).toBe("/stok?q=KAOS%20HTM%2FL");
    // the same SKU short in two warehouses is still one SKU
    expect(criticalStockHref([{ sku: "TMB-500" }, { sku: "TMB-500" }])).toBe("/stok?q=TMB-500");
    expect(criticalStockHref([{ sku: "A" }, { sku: "B" }])).toBe("/stok");
    expect(criticalStockHref([])).toBe("/stok");
  });
});

describe("minimum and bin location", () => {
  const cell = (warehouseId: string, minStock: number | null, binLocation: string | null) => ({
    warehouseId,
    onHand: 5,
    reserved: 0,
    buffer: 0,
    damaged: 0,
    available: 5,
    minStock,
    binLocation,
    stockSetAt: null,
  });
  const draft = (over: Partial<LocationDraft>): LocationDraft => ({
    warehouseId: "a",
    minStock: "",
    binLocation: "",
    ...over,
  });

  it("starts from the variant's stock in every active warehouse", () => {
    const row = { warehouses: [cell("a", 5, "A-01"), cell("b", null, null), cell("c", 0, null)] };
    expect(locationDrafts(row, [warehouse("a"), warehouse("b", false), warehouse("c"), warehouse("d")])).toEqual([
      { warehouseId: "a", minStock: "5", binLocation: "A-01" },
      { warehouseId: "c", minStock: "0", binLocation: "" },
      { warehouseId: "d", minStock: "", binLocation: "" },
    ]);
  });

  it("takes a whole minimum from 0 to 10 million, or none, and a bin of at most 50 characters", () => {
    expect(locationProblems(draft({ minStock: "" }))).toEqual({});
    expect(locationProblems(draft({ minStock: " 12 ", binLocation: "A".repeat(50) }))).toEqual({});
    expect(locationProblems(draft({ minStock: "10000000" }))).toEqual({});
    expect(locationProblems(draft({ minStock: "10000001" }))).toEqual({ minStock: "tooLarge" });
    expect(locationProblems(draft({ minStock: "1.5" }))).toEqual({ minStock: "wholeNumber" });
    expect(locationProblems(draft({ minStock: "-1" }))).toEqual({ minStock: "wholeNumber" });
    expect(locationProblems(draft({ binLocation: ` ${"A".repeat(51)}` }))).toEqual({ binLocation: "tooLong" });
    expect(locationProblems(draft({ minStock: "x", binLocation: "A".repeat(51) }))).toEqual({
      minStock: "wholeNumber",
      binLocation: "tooLong",
    });
  });

  it("sends only what changed, empty as none", () => {
    const before = draft({ minStock: "5", binLocation: "A-01" });
    expect(locationPatch(before, draft({ minStock: " 5 ", binLocation: "A-01 " }))).toBeNull();
    expect(locationPatch(before, draft({ minStock: "8", binLocation: "A-01" }))).toEqual({ minStock: 8 });
    expect(locationPatch(before, draft({ minStock: "5", binLocation: "B-02" }))).toEqual({ binLocation: "B-02" });
    expect(locationPatch(before, draft({ minStock: "", binLocation: " " }))).toEqual({
      minStock: null,
      binLocation: null,
    });
    expect(locationPatch(draft({}), draft({ minStock: "0" }))).toEqual({ minStock: 0 });
  });

  it("opens the stock card of a row in the filtered warehouse", () => {
    expect(historyHref({ id: "01JV", sku: "KAOS HTM/L" }, null)).toBe("/stok/riwayat?variant=01JV&sku=KAOS+HTM%2FL");
    expect(historyHref({ id: "01JV", sku: "TMB-500" }, "01JW")).toBe(
      "/stok/riwayat?variant=01JV&sku=TMB-500&warehouse=01JW",
    );
  });
});
