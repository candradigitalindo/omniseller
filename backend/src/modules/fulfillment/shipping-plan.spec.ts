import { describe, expect, it } from "vitest";
import {
  A4_PAGE,
  type ArrangeCheck,
  a4Cells,
  arrangeRefusal,
  compareBins,
  fitInto,
  labelSequence,
  pickLines,
  shipmentStepFor,
} from "./shipping-plan";

describe("arrangeRefusal (FR-SHP-06)", () => {
  const ok: ArrangeCheck = {
    status: "ready_to_pack",
    statusLabel: "Siap Dikemas",
    fulfillmentMode: "seller",
    channel: "shopee",
    externalStatus: "READY_TO_SHIP",
    cancelRequested: false,
    warehouseId: "W",
    store: { live: true, usable: true },
    shipment: null,
  };
  const code = (patch: Partial<ArrangeCheck>) => arrangeRefusal({ ...ok, ...patch })?.code ?? null;

  it("lets accepted, new, and packed orders through when the marketplace is ready", () => {
    expect(code({})).toBeNull();
    expect(code({ status: "new" })).toBeNull();
    expect(code({ status: "packed" })).toBeNull();
    // arranged in Seller Center already: adopted
    expect(code({ externalStatus: "PROCESSED" })).toBeNull();
    expect(code({ channel: "tiktokshop", externalStatus: "AWAITING_SHIPMENT" })).toBeNull();
    // a failed attempt may be tried again
    expect(code({ shipment: { status: "pending", lastError: "Alamat tidak valid" } })).toBeNull();
  });

  it("refuses with the reason the seller can act on", () => {
    expect(code({ store: { live: false, usable: true } })).toBe("store.read_only");
    expect(code({ store: { live: true, usable: false } })).toBe("store.unusable");
    expect(code({ fulfillmentMode: "marketplace" })).toBe("order.marketplace_fulfilled");
    expect(code({ status: "problem" })).toBe("order.has_problems");
    expect(code({ status: "shipped" })).toBe("order.status_invalid");
    expect(code({ warehouseId: null })).toBe("order.no_warehouse");
    expect(code({ cancelRequested: true })).toBe("order.cancel_requested");
    expect(code({ externalStatus: "UNPAID" })).toBe("order.not_ready_at_marketplace");
    expect(code({ channel: "tiktokshop", externalStatus: "ON_HOLD" })).toBe("order.not_ready_at_marketplace");
    expect(code({ shipment: { status: "label_ready", lastError: null } })).toBe("shipment.already_arranged");
    expect(code({ shipment: { status: "pending", lastError: null } })).toBe("shipment.in_progress");
  });
});

describe("shipmentStepFor (doc 7.9)", () => {
  it("cancels shipments that have not left, and only those", () => {
    expect(shipmentStepFor("cancelled", "label_ready")).toEqual({ to: "cancelled", via: "any" });
    expect(shipmentStepFor("cancelled", "in_transit")).toBeNull();
  });

  it("follows the marketplace's pickup and delivery, skipping seller steps", () => {
    expect(shipmentStepFor("shipped", "label_ready")).toEqual({ to: "in_transit", via: "marketplace" });
    expect(shipmentStepFor("shipped", "pending")).toEqual({ to: "in_transit", via: "marketplace" });
    expect(shipmentStepFor("shipped", "handed_over")).toEqual({ to: "in_transit", via: "any" });
    expect(shipmentStepFor("delivered", "in_transit")).toEqual({ to: "delivered", via: "any" });
    expect(shipmentStepFor("completed", "arranged")).toEqual({ to: "delivered", via: "marketplace" });
    expect(shipmentStepFor("completed", "delivered")).toBeNull();
  });

  it("packs a shipment when its order is packed and the label is ready", () => {
    expect(shipmentStepFor("packed", "label_ready")).toEqual({ to: "packed", via: "any" });
    expect(shipmentStepFor("packed", "arranged")).toBeNull();
    expect(shipmentStepFor("ready_to_pack", "label_ready")).toBeNull();
  });
});

describe("pick list and label order (FR-SHP-01, 02)", () => {
  it("compares rack codes by their numbers, empty racks last", () => {
    expect(["A-10-1", "A-2-3", null, "A-2-10", "B-1"].sort(compareBins)).toEqual([
      "A-2-3",
      "A-2-10",
      "A-10-1",
      "B-1",
      null,
    ]);
  });

  it("sums units per SKU and warehouse, counts orders, and sorts by rack", () => {
    const lines = pickLines([
      {
        orderId: "O1",
        warehouseId: "W",
        variantId: "V1",
        sku: "KAOS-M",
        name: "Kaos",
        variantName: "M",
        bin: "A-10",
        qty: 2,
      },
      {
        orderId: "O2",
        warehouseId: "W",
        variantId: "V1",
        sku: "KAOS-M",
        name: "Kaos",
        variantName: "M",
        bin: "A-10",
        qty: 1,
      },
      {
        orderId: "O2",
        warehouseId: "W",
        variantId: "V2",
        sku: "TOPI",
        name: "Topi",
        variantName: null,
        bin: "A-2",
        qty: 1,
      },
      {
        orderId: "O3",
        warehouseId: "W",
        variantId: null,
        sku: "X-9",
        name: "Gelang",
        variantName: null,
        bin: null,
        qty: 4,
      },
      {
        orderId: "O3",
        warehouseId: "W",
        variantId: "V3",
        sku: "TAS",
        name: "Tas",
        variantName: null,
        bin: "B-1",
        qty: 0,
      },
    ]);
    expect(lines.map((l) => [l.sku, l.bin, l.qty, l.orders])).toEqual([
      ["TOPI", "A-2", 1, 1],
      ["KAOS-M", "A-10", 3, 2],
      ["X-9", null, 4, 1],
    ]);
  });

  it("prints labels per warehouse in the order of the first rack each order needs", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 3, h));
    expect(
      labelSequence([
        { orderId: "C", warehouse: "Jakarta", shipByAt: at(9), lines: [{ bin: "B-1", sku: "TAS" }] },
        { orderId: "A", warehouse: "Jakarta", shipByAt: at(12), lines: [{ bin: "A-2", sku: "TOPI" }] },
        { orderId: "B", warehouse: "Jakarta", shipByAt: at(8), lines: [{ bin: "A-2", sku: "TOPI" }] },
        {
          orderId: "D",
          warehouse: "Jakarta",
          shipByAt: null,
          lines: [
            { bin: null, sku: "X" },
            { bin: "A-1", sku: "KAOS" },
          ],
        },
        { orderId: "E", warehouse: "Bandung", shipByAt: at(23), lines: [{ bin: "Z-9", sku: "Z" }] },
      ]),
    ).toEqual(["E", "D", "B", "A", "C"]);
  });
});

describe("label layout", () => {
  it("fits a label into a box keeping its proportions, centred", () => {
    // A6 (105 x 148 mm) into a 100 x 150 mm thermal page
    const a6 = { width: 297.64, height: 419.53 };
    const f = fitInto(a6, { x: 0, y: 0, width: 283.46, height: 425.2 });
    expect(f.scale).toBeCloseTo(283.46 / 297.64, 5);
    expect(f.x).toBeCloseTo(0, 5);
    expect(f.y).toBeGreaterThan(0);
  });

  it("splits an A4 sheet into four quarters in reading order", () => {
    const cells = a4Cells();
    expect(cells).toHaveLength(4);
    expect(cells[0]).toMatchObject({ x: 0, y: A4_PAGE.height / 2 });
    expect(cells[3]).toMatchObject({ x: A4_PAGE.width / 2, y: 0 });
  });
});
