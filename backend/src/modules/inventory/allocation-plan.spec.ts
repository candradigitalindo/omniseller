import { describe, expect, it } from "vitest";
import { type AllocationWarehouse, chooseWarehouse } from "./allocation-plan";

const JKT: AllocationWarehouse = { id: "JKT", name: "Gudang Jakarta", province: "DKI Jakarta", isDefault: true };
const SBY: AllocationWarehouse = { id: "SBY", name: "Gudang Surabaya", province: "Jawa Timur", isDefault: false };
const MDN: AllocationWarehouse = { id: "MDN", name: "Gudang Medan", province: "Sumatera Utara", isDefault: false };

const stock = (rows: [string, string, number, boolean?][]) =>
  new Map(rows.map(([v, w, available, established]) => [`${v}|${w}`, { available, established: established ?? true }]));

describe("automatic warehouse allocation (FR-ORD-12)", () => {
  it("sends the order to the warehouse nearest the buyer that has every item", () => {
    const r = chooseWarehouse({
      warehouses: [JKT, SBY, MDN],
      lines: [
        { variantId: "A", qty: 2 },
        { variantId: "B", qty: 1 },
      ],
      stock: stock([
        ["A", "JKT", 10],
        ["B", "JKT", 10],
        ["A", "SBY", 5],
        ["B", "SBY", 1],
      ]),
      buyerProvince: "JAWA TIMUR",
      home: "JKT",
    });
    expect(r).toEqual({ warehouseId: "SBY", reason: "nearest" });
  });

  it("prefers the same island group when no warehouse is in the buyer's province", () => {
    const r = chooseWarehouse({
      warehouses: [MDN, SBY],
      lines: [{ variantId: "A", qty: 1 }],
      stock: stock([
        ["A", "MDN", 50],
        ["A", "SBY", 2],
      ]),
      buyerProvince: "Jawa Tengah",
      home: "MDN",
    });
    expect(r).toEqual({ warehouseId: "SBY", reason: "nearest" });
  });

  it("does not split an order: a warehouse short of one item does not take it", () => {
    const r = chooseWarehouse({
      warehouses: [JKT, SBY],
      lines: [
        { variantId: "A", qty: 2 },
        { variantId: "B", qty: 3 },
      ],
      stock: stock([
        ["A", "SBY", 9],
        ["B", "SBY", 2],
        ["A", "JKT", 2],
        ["B", "JKT", 3],
      ]),
      buyerProvince: "Jawa Timur",
      home: "SBY",
    });
    // Surabaya is in the buyer's province but short of B; Jakarta, on the same island, has both
    expect(r).toEqual({ warehouseId: "JKT", reason: "nearest" });
  });

  it("adds up lines of the same variant before checking stock", () => {
    const r = chooseWarehouse({
      warehouses: [JKT, SBY],
      lines: [
        { variantId: "A", qty: 2 },
        { variantId: "A", qty: 2 },
      ],
      stock: stock([
        ["A", "SBY", 3],
        ["A", "JKT", 4],
      ]),
      buyerProvince: "Jawa Timur",
      home: null,
    });
    expect(r.warehouseId).toBe("JKT");
  });

  it("ignores stock nobody established and falls back to the preferred warehouse when none has everything", () => {
    const r = chooseWarehouse({
      warehouses: [JKT, SBY],
      lines: [{ variantId: "A", qty: 1 }],
      stock: stock([
        ["A", "SBY", 100, false],
        ["A", "JKT", 0],
      ]),
      buyerProvince: "Jawa Timur",
      home: "SBY",
    });
    expect(r).toEqual({ warehouseId: "SBY", reason: "home" });
    expect(
      chooseWarehouse({ warehouses: [SBY, JKT], lines: [], stock: new Map(), buyerProvince: null, home: null }),
    ).toEqual({ warehouseId: "JKT", reason: "home" });
  });

  it("breaks ties with the preferred warehouse, then the default, then the most units", () => {
    const base = {
      lines: [{ variantId: "A", qty: 1 }],
      stock: stock([
        ["A", "JKT", 5],
        ["A", "SBY", 8],
        ["A", "MDN", 9],
      ]),
      buyerProvince: null,
    };
    expect(chooseWarehouse({ ...base, warehouses: [JKT, SBY, MDN], home: "SBY" }).warehouseId).toBe("SBY");
    expect(chooseWarehouse({ ...base, warehouses: [JKT, SBY, MDN], home: null }).warehouseId).toBe("JKT");
    expect(chooseWarehouse({ ...base, warehouses: [SBY, MDN], home: null })).toEqual({
      warehouseId: "MDN",
      reason: "stock",
    });
    expect(chooseWarehouse({ ...base, warehouses: [], home: null })).toEqual({ warehouseId: null, reason: "none" });
  });
});
