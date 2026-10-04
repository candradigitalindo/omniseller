import { describe, expect, it } from "vitest";
import {
  checkPacking,
  courierMatches,
  type HandoverParcel,
  handoverNumber,
  handoverRefusal,
  labelRefusal,
  marketplaceLabelRefusal,
  type PackLine,
  paperOf,
  printerFor,
  printTitle,
} from "./scan-plan";

describe("label refusals (FR-SHP-17)", () => {
  const ready = { labelFileId: "F1" };
  it("needs an arranged shipment whose every package has its label", () => {
    expect(marketplaceLabelRefusal(undefined, [])?.code).toBe("shipment.not_arranged");
    expect(marketplaceLabelRefusal({ status: "pending", lastError: null }, [])?.code).toBe("shipment.pending");
    expect(marketplaceLabelRefusal({ status: "arranged", lastError: null }, [])?.code).toBe("label.not_ready");
    expect(
      marketplaceLabelRefusal({ status: "arranged", lastError: "Resi belum keluar" }, [ready, { labelFileId: null }]),
    ).toEqual({ code: "label.not_ready", message: "Resi belum keluar" });
    expect(marketplaceLabelRefusal({ status: "in_transit", lastError: null }, [ready])?.code).toBe("shipment.shipped");
    expect(marketplaceLabelRefusal({ status: "label_ready", lastError: null }, [ready])).toBeNull();
    expect(marketplaceLabelRefusal({ status: "packed", lastError: null }, [ready])).toBeNull();
  });

  it("draws manual orders' labels, never a cancelled order's", () => {
    const manual = { manual: true, status: "packed" as const, hasAddress: true };
    expect(labelRefusal(manual, undefined, [])).toBeNull();
    expect(labelRefusal({ ...manual, hasAddress: false }, undefined, [])?.code).toBe("order.no_address");
    expect(labelRefusal({ ...manual, status: "cancelled" }, undefined, [])?.code).toBe("order.cancelled");
    expect(
      labelRefusal({ manual: false, status: "cancelled", hasAddress: true }, { status: "packed", lastError: null }, [
        ready,
      ])?.code,
    ).toBe("order.cancelled");
    expect(
      labelRefusal(
        { manual: false, status: "ready_to_ship", hasAddress: true },
        { status: "packed", lastError: null },
        [ready],
      ),
    ).toBeNull();
  });
});

describe("print jobs", () => {
  it("send label stock to the label printer and A4 to the document printer", () => {
    expect(paperOf("labels", { orderIds: [], format: "thermal" })).toBe("label");
    expect(paperOf("labels", { orderIds: [], format: "a4" })).toBe("a4");
    expect(paperOf("packing_list", { orderIds: [] })).toBe("label");
    expect(paperOf("barcode_labels", { orderIds: [], labelFormat: "label_40x30" })).toBe("label");
    expect(paperOf("barcode_labels", { orderIds: [], labelFormat: "a4_3x10" })).toBe("a4");
    expect(paperOf("pick_list", { orderIds: [] })).toBe("a4");
    expect(paperOf("handover_manifest", { orderIds: [] })).toBe("a4");
    expect(paperOf("test_page", { orderIds: [] })).toBe("label");
    const agent = { labelPrinter: "Zebra GK420", documentPrinter: "EPSON L3110" };
    expect(printerFor(undefined, "label", agent)).toBe("Zebra GK420");
    expect(printerFor(null, "a4", agent)).toBe("EPSON L3110");
    expect(printerFor("Xprinter", "a4", agent)).toBe("Xprinter");
    expect(printerFor(undefined, "label", { labelPrinter: null, documentPrinter: "EPSON" })).toBeNull();
  });

  it("are named for the print queue", () => {
    expect(printTitle("labels", { orderIds: ["A"] }, { number: "2609ABC" })).toBe("Label 2609ABC");
    expect(printTitle("labels", { orderIds: ["A", "B"] }, { number: "2609ABC" })).toBe("Label 2 pesanan");
    expect(printTitle("packing_list", { orderIds: ["A"] })).toBe("Daftar kemas 1 pesanan");
    expect(printTitle("pick_list", { orderIds: ["A", "B", "C"] })).toBe("Daftar ambil 3 pesanan");
    expect(
      printTitle("barcode_labels", {
        orderIds: [],
        items: [
          { variantId: "V1", copies: 3 },
          { variantId: "V2", copies: 2 },
        ],
      }),
    ).toBe("Label barcode 5 lembar");
    expect(printTitle("handover_manifest", { orderIds: [] }, { number: "MNF-2610-0001" })).toBe(
      "Manifest MNF-2610-0001",
    );
    expect(printTitle("test_page", { orderIds: [] })).toBe("Cetak percobaan");
  });
});

describe("courier handover (FR-SHP-05)", () => {
  it("numbers manifests per month", () => {
    expect(handoverNumber("2610", 7)).toBe("MNF-2610-0007");
    expect(handoverNumber("2610", 12345)).toBe("MNF-2610-12345");
  });

  it("matches couriers without case, spaces, or punctuation, one starting the other", () => {
    expect(courierMatches("J&T Express", "J&T EXPRESS")).toBe(true);
    expect(courierMatches("JNE", "JNE Reguler")).toBe(true);
    expect(courierMatches("SiCepat REG", "sicepat")).toBe(true);
    expect(courierMatches("J&T Express", "J&T Cargo")).toBe(false);
    expect(courierMatches("SPX Express", "JNE Reguler")).toBe(false);
    expect(courierMatches("J&T Express", null)).toBe(true);
    expect(courierMatches("???", "JNE")).toBe(true);
  });

  const parcel: HandoverParcel = {
    manual: false,
    orderStatus: "ready_to_ship",
    fulfillmentMode: "seller",
    warehouseId: "W1",
    hasAddress: true,
    shipmentStatus: "packed",
    provider: "J&T Express",
  };
  const h = { warehouseId: "W1", courier: "J&T Express" };

  it("takes marketplace parcels packed with their label, from this warehouse, for this courier", () => {
    expect(handoverRefusal(parcel, h)).toBeNull();
    expect(handoverRefusal({ ...parcel, shipmentStatus: "label_ready" }, h)?.code).toBe("handover.not_packed");
    expect(handoverRefusal({ ...parcel, shipmentStatus: "arranged" }, h)?.code).toBe("handover.not_ready");
    expect(handoverRefusal({ ...parcel, shipmentStatus: null }, h)?.code).toBe("handover.not_ready");
    expect(handoverRefusal({ ...parcel, shipmentStatus: "handed_over" }, h)?.code).toBe("handover.already_sent");
    expect(handoverRefusal({ ...parcel, orderStatus: "shipped" }, h)?.code).toBe("handover.already_sent");
    expect(handoverRefusal({ ...parcel, warehouseId: "W2" }, h)?.code).toBe("handover.other_warehouse");
    expect(handoverRefusal({ ...parcel, provider: "SPX Express" }, h)).toEqual({
      code: "handover.courier_mismatch",
      message: "Paket ini untuk SPX Express, bukan J&T Express.",
    });
    expect(handoverRefusal({ ...parcel, fulfillmentMode: "marketplace" }, h)?.code).toBe("order.marketplace_fulfilled");
  });

  it("never lets a cancelled order's parcel go", () => {
    expect(handoverRefusal({ ...parcel, orderStatus: "cancelled" }, h)?.code).toBe("handover.cancelled");
    expect(handoverRefusal({ ...parcel, shipmentStatus: "cancelled" }, h)?.code).toBe("handover.cancelled");
  });

  it("takes manual orders packed or ready to ship, with an address", () => {
    const manual: HandoverParcel = { ...parcel, manual: true, orderStatus: "packed", shipmentStatus: null };
    expect(handoverRefusal(manual, h)).toBeNull();
    expect(handoverRefusal({ ...manual, orderStatus: "ready_to_ship" }, h)).toBeNull();
    expect(handoverRefusal({ ...manual, orderStatus: "ready_to_pack" }, h)?.code).toBe("handover.not_packed");
    expect(handoverRefusal({ ...manual, hasAddress: false }, h)?.code).toBe("order.no_address");
    expect(handoverRefusal({ ...manual, provider: null }, h)).toBeNull();
  });
});

describe("packing by scan (FR-SHP-04)", () => {
  const lines: PackLine[] = [
    { key: "V1", qty: 2, codes: ["8991234567891", "KAOS-HTM-L", "V1"] },
    { key: "V2", qty: 1, codes: ["TOPI-01", "V2"] },
  ];

  it("matches when every line has exactly its quantity", () => {
    const check = checkPacking(lines, [
      { code: "8991234567891", qty: 1 },
      { code: "kaos-htm-l", qty: 1 },
      { code: "TOPI-01", qty: 1 },
    ]);
    expect(check).toEqual({
      ok: true,
      lines: [
        { key: "V1", expected: 2, scanned: 2 },
        { key: "V2", expected: 1, scanned: 1 },
      ],
      unknown: [],
    });
  });

  it("refuses a wrong SKU, a short line, and a line over its quantity", () => {
    const wrong = checkPacking(lines, [
      { code: "KAOS-HTM-L", qty: 2 },
      { code: "TOPI-01", qty: 1 },
      { code: "SEPATU-42", qty: 1 },
    ]);
    expect(wrong.ok).toBe(false);
    expect(wrong.unknown).toEqual(["SEPATU-42"]);
    const short = checkPacking(lines, [{ code: "KAOS-HTM-L", qty: 2 }]);
    expect(short.ok).toBe(false);
    expect(short.lines[1]).toEqual({ key: "V2", expected: 1, scanned: 0 });
    const over = checkPacking(lines, [
      { code: "KAOS-HTM-L", qty: 3 },
      { code: "TOPI-01", qty: 1 },
    ]);
    expect(over.ok).toBe(false);
    expect(over.lines[0]).toEqual({ key: "V1", expected: 2, scanned: 3 });
  });

  it("counts a line by its key when it has no code to scan", () => {
    expect(checkPacking([{ key: "sku:", qty: 1, codes: ["sku:"] }], [{ code: "sku:", qty: 1 }]).ok).toBe(true);
  });

  it("fills the first line that still needs units when two lines share a code", () => {
    const shared: PackLine[] = [
      { key: "A", qty: 1, codes: ["SAMA"] },
      { key: "B", qty: 2, codes: ["SAMA"] },
    ];
    expect(checkPacking(shared, [{ code: "SAMA", qty: 3 }]).ok).toBe(true);
    expect(checkPacking(shared, [{ code: "SAMA", qty: 4 }]).lines).toEqual([
      { key: "A", expected: 1, scanned: 1 },
      { key: "B", expected: 2, scanned: 3 },
    ]);
  });
});
