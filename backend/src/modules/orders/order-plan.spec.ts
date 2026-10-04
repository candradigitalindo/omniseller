import type { OrderStatus } from "@omniseller/shared";
import { describe, expect, it } from "vitest";
import {
  detectProblems,
  initialStatus,
  itemStockPlan,
  manualOrderNumber,
  manualTotals,
  type ProblemInput,
  pathTo,
  problemStep,
  SLA_WARNING_MS,
  slaAlertDue,
  slaOf,
  statusSteps,
  warehouseFixed,
} from "./order-plan";

const seller = (state: Parameters<typeof initialStatus>[0]["state"]) => ({ state, fulfillment: "seller" as const });

describe("initialStatus (backend doc 7.9)", () => {
  it("maps first sightings of seller-fulfilled orders", () => {
    expect(initialStatus(seller("unpaid"))).toBe("unpaid");
    expect(initialStatus(seller("to_ship"))).toBe("new");
    expect(initialStatus(seller("seller_processing"))).toBe("new");
    expect(initialStatus(seller("shipped"))).toBe("shipped");
    expect(initialStatus(seller("completed"))).toBe("completed");
    expect(initialStatus(seller("cancelled"))).toBe("cancelled");
    expect(initialStatus(seller("returning"))).toBe("return_in_progress");
  });

  it("keeps marketplace-fulfilled orders out of the seller flow", () => {
    expect(initialStatus({ state: "to_ship", fulfillment: "marketplace" })).toBe("marketplace_fulfilled");
    expect(initialStatus({ state: "shipped", fulfillment: "marketplace" })).toBe("marketplace_fulfilled");
    expect(initialStatus({ state: "completed", fulfillment: "marketplace" })).toBe("completed");
  });
});

describe("statusSteps", () => {
  const steps = (from: OrderStatus, state: Parameters<typeof initialStatus>[0]["state"]) =>
    statusSteps(from, seller(state)).map((s) => `${s.to}:${s.via}`);

  it("moves forward on marketplace facts, skipping seller steps where the marketplace says so", () => {
    expect(steps("unpaid", "to_ship")).toEqual(["new:any"]);
    expect(steps("new", "shipped")).toEqual(["shipped:marketplace"]);
    expect(steps("packed", "completed")).toEqual(["completed:marketplace"]);
    expect(steps("ready_to_ship", "shipped")).toEqual(["shipped:any"]);
    expect(steps("shipped", "delivered")).toEqual(["delivered:any"]);
    expect(steps("shipped", "completed")).toEqual(["completed:marketplace"]);
    expect(steps("delivered", "completed")).toEqual(["completed:any"]);
    expect(steps("unpaid", "shipped")).toEqual(["new:any", "shipped:marketplace"]);
    expect(steps("new", "returning")).toEqual(["shipped:marketplace", "return_in_progress:any"]);
  });

  it("never moves backwards or out of a final status", () => {
    expect(steps("shipped", "to_ship")).toEqual([]);
    expect(steps("completed", "shipped")).toEqual([]);
    expect(steps("new", "unpaid")).toEqual([]);
    expect(steps("cancelled", "to_ship")).toEqual([]);
    expect(steps("delivered", "cancelled")).toEqual([]);
  });

  it("ignores seller-side progress at the marketplace", () => {
    expect(steps("new", "seller_processing")).toEqual([]);
    expect(steps("ready_to_pack", "to_ship")).toEqual([]);
  });

  it("cancels from any status before delivery", () => {
    for (const from of ["unpaid", "new", "problem", "packed", "ready_to_ship", "shipped"] as OrderStatus[]) {
      expect(steps(from, "cancelled")).toEqual(["cancelled:any"]);
    }
  });
});

describe("itemStockPlan", () => {
  const item = { qty: 3, cancelledQty: 0, reservedQty: 0, shippedQty: 0, variantId: "V", warehouseId: "W" };

  it("reserves open units while the order is held, including unpaid orders", () => {
    expect(itemStockPlan("unpaid", "seller", item)).toEqual({
      moves: [{ type: "order_reserve", qty: 3 }],
      reservedQty: 3,
      shippedQty: 0,
    });
    expect(itemStockPlan("new", "seller", { ...item, reservedQty: 3 }).moves).toEqual([]);
  });

  it("releases what a partial cancellation took off", () => {
    expect(itemStockPlan("new", "seller", { ...item, reservedQty: 3, cancelledQty: 1 })).toEqual({
      moves: [{ type: "order_release", qty: 1 }],
      reservedQty: 2,
      shippedQty: 0,
    });
  });

  it("ships only reserved units", () => {
    expect(itemStockPlan("shipped", "seller", { ...item, reservedQty: 3 })).toEqual({
      moves: [{ type: "order_ship", qty: 3 }],
      reservedQty: 0,
      shippedQty: 3,
    });
    // first seen already completed (90-day import): the sale is part of counted stock
    expect(itemStockPlan("completed", "seller", item)).toEqual({ moves: [], reservedQty: 0, shippedQty: 3 });
  });

  it("releases the reservation on cancellation", () => {
    expect(itemStockPlan("cancelled", "seller", { ...item, reservedQty: 2 }).moves).toEqual([
      { type: "order_release", qty: 2 },
    ]);
  });

  it("leaves stock alone for unmapped items and marketplace fulfillment", () => {
    expect(itemStockPlan("new", "seller", { ...item, variantId: null }).moves).toEqual([]);
    expect(itemStockPlan("new", "seller", { ...item, warehouseId: null }).moves).toEqual([]);
    expect(itemStockPlan("new", "marketplace", item).moves).toEqual([]);
  });
});

describe("detectProblems (FR-ORD-06, FR-WHS-10)", () => {
  const base: ProblemInput = {
    status: "new",
    fulfillment: "seller",
    recipientAvailable: true,
    recipient: { name: "Dewi", phone: "0812", fullAddress: "Jl. Mawar 1" },
    items: [{ sku: "A", title: "Kaos", open: 1, variantId: "V", warehouseId: "W", externalWarehouseId: null }],
    stock: new Map([["V|W", { available: 3, established: true }]]),
  };

  it("finds nothing on a healthy order", () => {
    expect([...detectProblems(base).keys()]).toEqual([]);
  });

  it("flags unmapped SKUs, unmapped warehouses, overselling, and incomplete addresses", () => {
    const found = detectProblems({
      ...base,
      recipient: { name: "Dewi", phone: null, fullAddress: "Jl. Mawar 1" },
      items: [
        { sku: "A", title: "Kaos", open: 1, variantId: "V", warehouseId: "W", externalWarehouseId: null },
        { sku: "B", title: "Topi", open: 1, variantId: null, warehouseId: "W", externalWarehouseId: null },
        { sku: "C", title: "Tas", open: 1, variantId: "V2", warehouseId: null, externalWarehouseId: "LOC9" },
      ],
      stock: new Map([["V|W", { available: -1, established: true }]]),
    });
    expect([...found.keys()].sort()).toEqual([
      "address_incomplete",
      "insufficient_stock",
      "unmapped_sku",
      "unmapped_warehouse",
    ]);
    expect(found.get("unmapped_warehouse")).toEqual({ externalWarehouseIds: ["LOC9"] });
    expect(found.get("address_incomplete")).toEqual({ missing: ["phone"] });
  });

  it("does not call stock short when it was never counted, nor addresses the marketplace hides", () => {
    const found = detectProblems({
      ...base,
      recipientAvailable: false,
      recipient: null,
      stock: new Map([["V|W", { available: -2, established: false }]]),
    });
    expect([...found.keys()]).toEqual([]);
  });

  it("has nothing to say about finished or marketplace-fulfilled orders", () => {
    expect(detectProblems({ ...base, status: "completed", recipient: null }).size).toBe(0);
    expect(detectProblems({ ...base, fulfillment: "marketplace", recipient: null }).size).toBe(0);
  });
});

describe("problemStep and slaOf", () => {
  it("moves new orders with problems to problem and back", () => {
    expect(problemStep("new", 1)).toEqual({ to: "problem", via: "any" });
    expect(problemStep("problem", 0)).toEqual({ to: "new", via: "any" });
    expect(problemStep("ready_to_pack", 2)).toBeNull();
  });

  it("colours the ship-by deadline for orders still to ship (FR-ORD-07)", () => {
    const now = new Date("2026-10-03T08:00:00Z");
    const later = (ms: number) => new Date(now.getTime() + ms);
    expect(slaOf(later(SLA_WARNING_MS + 60_000), "new", now)?.state).toBe("ok");
    expect(slaOf(later(3600_000), "packed", now)?.state).toBe("warning");
    expect(slaOf(later(-1), "ready_to_ship", now)?.state).toBe("overdue");
    expect(slaOf(later(-1), "shipped", now)).toBeNull();
    expect(slaOf(null, "new", now)).toBeNull();
  });
});

describe("slaAlertDue (FR-SHP-10)", () => {
  const now = new Date("2026-10-03T08:00:00Z");
  const later = (ms: number) => new Date(now.getTime() + ms);

  it("warns once at 6 hours or less, and once more when the deadline passes", () => {
    expect(slaAlertDue(later(SLA_WARNING_MS + 60_000), "new", null, now)).toBeNull();
    expect(slaAlertDue(later(3600_000), "ready_to_pack", null, now)).toBe("warning");
    expect(slaAlertDue(later(3600_000), "ready_to_pack", "warning", now)).toBeNull();
    expect(slaAlertDue(later(-60_000), "packed", "warning", now)).toBe("overdue");
    expect(slaAlertDue(later(-60_000), "packed", null, now)).toBe("overdue");
    expect(slaAlertDue(later(-60_000), "packed", "overdue", now)).toBeNull();
  });

  it("says nothing about orders already shipped or without a deadline", () => {
    expect(slaAlertDue(later(-60_000), "shipped", null, now)).toBeNull();
    expect(slaAlertDue(null, "new", null, now)).toBeNull();
  });
});

describe("manual orders (FR-ORD-09, 12)", () => {
  it("adds up the lines, takes the discount off, and adds the shipping fee", () => {
    expect(
      manualTotals(
        [
          { unitPrice: 50_000, qty: 2 },
          { unitPrice: 15_000, qty: 1 },
        ],
        10_000,
        9_000,
      ),
    ).toEqual({ subtotal: 115_000, total: 114_000 });
  });

  it("numbers orders per local month", () => {
    expect(manualOrderNumber("2610", 7)).toBe("MN-2610-0007");
    expect(manualOrderNumber("2610", 12345)).toBe("MN-2610-12345");
  });

  it("walks every seller step to the target and refuses to go back", () => {
    expect(pathTo("new", "shipped")?.map((s) => s.to)).toEqual(["ready_to_pack", "packed", "ready_to_ship", "shipped"]);
    expect(pathTo("packed", "completed")?.map((s) => s.to)).toEqual([
      "ready_to_ship",
      "shipped",
      "delivered",
      "completed",
    ]);
    expect(pathTo("shipped", "shipped")).toBeNull();
    expect(pathTo("delivered", "shipped")).toBeNull();
    expect(pathTo("problem", "shipped")).toBeNull();
    expect(pathTo("unpaid", "shipped")).toBeNull();
    expect(pathTo("new", "shipped")!.every((s) => s.via === "any")).toBe(true);
  });

  it("keeps the marketplace's warehouse for multi-warehouse stores only", () => {
    expect(warehouseFixed("shopee", 2)).toBe(true);
    expect(warehouseFixed("shopee", 1)).toBe(false);
    expect(warehouseFixed("tiktokshop", 0)).toBe(false);
    expect(warehouseFixed("manual", 3)).toBe(false);
  });
});
