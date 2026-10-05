import { describe, expect, it } from "vitest";
import {
  columnLabel,
  columnLetter,
  importStep,
  mappingBody,
  missingRequired,
  openChecks,
  readyStores,
  type StoreState,
  sharedColumns,
  undoLeft,
} from "./migration-meta";

const fields = [
  { key: "product_name", label: "Nama produk", required: true, unit: null },
  { key: "sku", label: "SKU varian", required: true, unit: null },
  { key: "price", label: "Harga jual", required: true, unit: null },
  { key: "weight", label: "Berat", required: true, unit: "weight" as const },
  { key: "cost", label: "HPP", required: false, unit: null },
];

function store(over: Partial<StoreState>): StoreState {
  return {
    id: "S1",
    name: "Toko Rina Shopee",
    channel: "shopee",
    displayName: "Shopee",
    syncMode: "read_only",
    parallelSince: "2026-10-01T00:00:00.000Z",
    parallelDays: 5,
    orders: {},
    stock: { counts: {}, unverified: 0, pulledAt: null, blocked: null },
    unmappedListings: 0,
    unmappedWarehouses: 0,
    checklist: [],
    ready: false,
    lastCutover: null,
    ...over,
  };
}

describe("columns", () => {
  it("names columns as the spreadsheet does", () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
  });

  it("labels a column by letter and header, or by letter when it has no header", () => {
    const columns = ["Nama Produk", "Kolom B", "Harga"];
    expect(columnLabel(columns, 0)).toBe("A · Nama Produk");
    expect(columnLabel(columns, 1)).toBe("B");
    expect(columnLabel(columns, 7)).toBe("H");
  });
});

describe("the mapping", () => {
  it("lists required fields without a column, and columns read twice", () => {
    expect(missingRequired(fields, { product_name: 0, sku: 1 }).map((f) => f.key)).toEqual(["price", "weight"]);
    expect(missingRequired(fields, { product_name: 0, sku: 1, price: 2, weight: 3 })).toEqual([]);
    expect(sharedColumns({ product_name: 0, sku: 1, price: 1, cost: 1, weight: 3 })).toEqual([1]);
  });

  it("saves a preset only when it has a name", () => {
    const m = { headerRow: 2, fields: { sku: 1 }, weightUnit: "kg" as const, dimensionUnit: "cm" as const };
    expect(mappingBody(m, "  ")).toEqual(m);
    expect(mappingBody(m, " BigSeller ")).toEqual({ ...m, savePresetAs: "BigSeller" });
  });

  it("places a job on the four steps", () => {
    expect(importStep("uploaded")).toBe(2);
    expect(importStep("validating")).toBe(3);
    expect(importStep("invalid")).toBe(3);
    expect(importStep("validated")).toBe(3);
    expect(importStep("importing")).toBe(4);
    expect(importStep("imported")).toBe(4);
  });
});

describe("parallel mode and cutover", () => {
  it("moves only read-only stores whose checklist passes", () => {
    const stores = [
      store({ id: "A", ready: true }),
      store({ id: "B", ready: false }),
      store({ id: "C", ready: true, syncMode: "live" }),
    ];
    expect(readyStores(stores).map((s) => s.id)).toEqual(["A"]);
  });

  it("counts the blocking checks still open, leaving the old-app confirmation to the cutover form", () => {
    const s = store({
      checklist: [
        { key: "store_connected", ok: true, blocking: true, detail: null },
        { key: "stock_match", ok: false, blocking: true, detail: "2 listing stoknya berbeda." },
        { key: "old_app_revoked", ok: false, blocking: true, detail: "Cabut otorisasi." },
        { key: "parallel_days", ok: false, blocking: false, detail: "Baru 1 hari." },
      ],
    });
    expect(openChecks(s).map((c) => c.key)).toEqual(["stock_match"]);
  });

  it("can undo for 24 hours and only once", () => {
    const now = new Date("2026-10-06T10:00:00Z");
    expect(undoLeft({ canUndo: true, undoUntil: "2026-10-06T12:00:00Z" }, now)).toBe(2 * 3_600_000);
    expect(undoLeft({ canUndo: true, undoUntil: "2026-10-06T09:00:00Z" }, now)).toBe(0);
    expect(undoLeft({ canUndo: false, undoUntil: "2026-10-06T12:00:00Z" }, now)).toBe(0);
  });
});
