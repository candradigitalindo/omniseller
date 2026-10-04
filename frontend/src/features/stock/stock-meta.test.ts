import { describe, expect, it } from "vitest";
import { adjustedOnHand, criticalStockHref, stockFilterOf, type Warehouse, warehouseColumns } from "./stock-meta";

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
