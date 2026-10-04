import { describe, expect, it } from "vitest";
import {
  A4_PAGE,
  type ArrangeCheck,
  a4Cells,
  arrangeRefusal,
  barcodeLabelLayout,
  combineParcels,
  compareBins,
  DEFAULT_LABEL_TEMPLATE,
  fitInto,
  labelPlacement,
  labelSequence,
  MM,
  manualTrackingStage,
  moduleWidth,
  PRINTER_DOT,
  pickLines,
  STRIP_HEIGHT,
  shipmentStepFor,
  THERMAL_PAGE,
  templateStrip,
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

  it("puts the template strip under the label and never over it (FR-SHP-16)", () => {
    const a6 = { width: 105 * MM, height: 148 * MM };
    const page = { x: 0, y: 0, ...THERMAL_PAGE };
    const at = labelPlacement(a6, page, true);
    expect(at.strip).toEqual({ x: 0, y: 0, width: THERMAL_PAGE.width, height: STRIP_HEIGHT });
    // the label is scaled down into the room above the strip, against the page's top edge
    const bottom = at.label.y;
    const top = at.label.y + a6.height * at.label.scale;
    expect(bottom).toBeGreaterThanOrEqual(STRIP_HEIGHT - 1e-6);
    expect(top).toBeCloseTo(THERMAL_PAGE.height, 5);
    expect(at.label.scale).toBeCloseTo((THERMAL_PAGE.height - STRIP_HEIGHT) / a6.height, 5);
    expect(at.label.x).toBeGreaterThanOrEqual(0);
    expect(at.label.x + a6.width * at.label.scale).toBeLessThanOrEqual(THERMAL_PAGE.width + 1e-6);
    // without a strip the label is centred as before
    expect(labelPlacement(a6, page, false)).toEqual({ label: fitInto(a6, page), strip: null });
  });

  it("gives the strip at most 30% of a small box", () => {
    const box = { x: 10, y: 20, width: 200, height: 150 };
    const at = labelPlacement({ width: 100, height: 100 }, box, true);
    expect(at.strip).toEqual({ x: 10, y: 20, width: 200, height: 45 });
    expect(at.label.y).toBeCloseTo(65, 5);
    expect(at.label.y + 100 * at.label.scale).toBeCloseTo(170, 5);
  });

  it("sizes barcode modules in whole printer dots and flags bars thinner than two (FR-PRD-12)", () => {
    // an EAN-13 with its quiet zones (113 modules) in 47 mm: three dots a module
    expect(moduleWidth(113, 47 * MM)).toEqual({ module: 3 * PRINTER_DOT, dense: false });
    // a 16-character SKU in Code 128 (231 modules): one dot, readable by good scanners only
    expect(moduleWidth(231, 47 * MM)).toEqual({ module: PRINTER_DOT, dense: true });
    // longer still: squeezed into the space, under one dot
    const squeezed = moduleWidth(500, 47 * MM);
    expect(squeezed.dense).toBe(true);
    expect(squeezed.module * 500).toBeCloseTo(47 * MM, 6);
    expect(barcodeLabelLayout("a4_3x10").cells).toHaveLength(30);
    expect(barcodeLabelLayout("label_40x30").page).toEqual({ width: 40 * MM, height: 30 * MM });
  });

  it("splits an A4 sheet into four quarters in reading order", () => {
    const cells = a4Cells();
    expect(cells).toHaveLength(4);
    expect(cells[0]).toMatchObject({ x: 0, y: A4_PAGE.height / 2 });
    expect(cells[3]).toMatchObject({ x: A4_PAGE.width / 2, y: 0 });
  });
});

describe("tracking (FR-SHP-07)", () => {
  const ev = (iso: string, stage: string | null, description = stage ?? "?") => ({
    at: new Date(iso),
    description,
    code: stage ? stage.toUpperCase() : null,
    stage: stage as never,
  });

  it("keeps one parcel's journey newest first and its stage", () => {
    const r = combineParcels([
      {
        externalPackageId: "",
        stage: "in_transit",
        events: [ev("2026-10-04T01:00:00Z", "waiting_pickup"), ev("2026-10-04T05:00:00Z", "in_transit")],
      },
    ]);
    expect(r.stage).toBe("in_transit");
    expect(r.eventAt).toEqual(new Date("2026-10-04T05:00:00Z"));
    expect(r.events.map((e) => e.stage)).toEqual(["in_transit", "waiting_pickup"]);
    expect(r.events[0]).not.toHaveProperty("packageId");
  });

  it("shows a split order's most serious problem, else the parcel furthest behind", () => {
    const parcels = (a: string | null, b: string | null) => [
      { externalPackageId: "P1", stage: a as never, events: [ev("2026-10-04T05:00:00Z", a)] },
      { externalPackageId: "P2", stage: b as never, events: [ev("2026-10-04T06:00:00Z", b)] },
    ];
    expect(combineParcels(parcels("delivered", "in_transit")).stage).toBe("in_transit");
    expect(combineParcels(parcels("delivered", "returning")).stage).toBe("returning");
    expect(combineParcels(parcels("failed", "lost")).stage).toBe("lost");
    expect(combineParcels(parcels(null, null)).stage).toBeNull();
    const merged = combineParcels(parcels("delivered", "in_transit")).events;
    expect(merged.map((e) => e.packageId)).toEqual(["P2", "P1"]);
  });

  it("keeps the newest 100 events", () => {
    const many = Array.from({ length: 130 }, (_, i) =>
      ev(new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), "in_transit"),
    );
    const r = combineParcels([{ externalPackageId: "", stage: "in_transit", events: many }]);
    expect(r.events).toHaveLength(100);
    expect(r.events[0]!.at).toBe(new Date(Date.UTC(2026, 9, 1, 0, 129)).toISOString());
  });

  it("derives a manual order's stage from its status", () => {
    expect(manualTrackingStage("shipped")).toBe("in_transit");
    expect(manualTrackingStage("completed")).toBe("delivered");
    expect(manualTrackingStage("packed")).toBeNull();
  });
});

describe("custom label template (FR-SHP-16)", () => {
  const order = {
    number: "2410040ABC",
    note: "  Bungkus kado  ",
    tags: ["Prioritas"],
    lines: [{ qty: 2, sku: "KAOS-HTM-L", name: "Kaos Polos", variant: "Hitam, L", bin: "A-01" }],
  };

  it("adds SKU, variant, rack, and the buyer's note by default, tags only when asked", () => {
    expect(templateStrip(DEFAULT_LABEL_TEMPLATE, order)).toEqual({
      orderNumber: "2410040ABC",
      lines: [{ qty: 2, sku: "KAOS-HTM-L", variant: "Hitam, L", bin: "A-01" }],
      note: "Bungkus kado",
      tags: [],
    });
    expect(templateStrip({ ...DEFAULT_LABEL_TEMPLATE, showTags: true }, order).tags).toEqual(["Prioritas"]);
  });

  it("names the product when the SKU is left out and drops what is turned off", () => {
    const t = { showSku: false, showVariant: false, showBin: false, showBuyerNote: false, showTags: false };
    expect(templateStrip(t, order)).toEqual({
      orderNumber: "2410040ABC",
      lines: [{ qty: 2, sku: "Kaos Polos", variant: null, bin: null }],
      note: null,
      tags: [],
    });
  });
});
