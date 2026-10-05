import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PRINT,
  documentDone,
  lineOf,
  loadPrintSettings,
  type PackLine,
  packed,
  packingScans,
  savePrintSettings,
  scanUnit,
} from "./shipping-meta";

const line = (over: Partial<PackLine>): PackLine => ({
  key: "01JVARIANT0000000000000001",
  variantId: "01JVARIANT0000000000000001",
  sku: "KAOS-HTM-L",
  barcode: "8991234567891",
  name: "Kaos Polos",
  variantName: "Hitam, L",
  imageUrl: null,
  qty: 2,
  ...over,
});
const lines = [
  line({}),
  line({ key: "sku:TOPI-01", variantId: null, sku: "TOPI-01", barcode: null, name: "Topi", variantName: null, qty: 1 }),
];

describe("packing by scan", () => {
  it("finds a line by barcode, SKU in any case, or line key", () => {
    expect(lineOf(lines, "8991234567891")?.sku).toBe("KAOS-HTM-L");
    expect(lineOf(lines, " kaos-htm-l ")?.sku).toBe("KAOS-HTM-L");
    expect(lineOf(lines, "sku:TOPI-01")?.sku).toBe("TOPI-01");
    expect(lineOf(lines, "SALAH")).toBeNull();
  });

  it("counts units up to each line's quantity and says why a scan did not count", () => {
    let counts: Record<string, number> = {};
    const first = scanUnit(lines, counts, "8991234567891");
    expect(first.outcome).toBe("counted");
    counts = scanUnit(lines, first.counts, "KAOS-HTM-L").counts;
    expect(scanUnit(lines, counts, "8991234567891").outcome).toBe("complete");
    expect(scanUnit(lines, counts, "SALAH").outcome).toBe("unknown");
    expect(packed(lines, counts)).toBe(false);
    counts = scanUnit(lines, counts, "TOPI-01").counts;
    expect(packed(lines, counts)).toBe(true);
    expect(packingScans(lines, counts)).toEqual([
      { code: "01JVARIANT0000000000000001", qty: 2 },
      { code: "sku:TOPI-01", qty: 1 },
    ]);
  });

  it("treats an order without lines as nothing to pack", () => {
    expect(packed([], {})).toBe(false);
  });
});

describe("documents and print settings", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("knows when a document is done", () => {
    expect(documentDone({ status: "running" })).toBe(false);
    expect(documentDone({ status: "ready" })).toBe(true);
    expect(documentDone({ status: "failed" })).toBe(true);
    expect(documentDone(undefined)).toBe(false);
  });

  it("remembers this station's print choices, and falls back when storage refuses", () => {
    expect(loadPrintSettings()).toEqual(DEFAULT_PRINT);
    savePrintSettings({ deviceId: "01JDEVICE00000000000000001", format: "a4", template: "custom", packingList: true });
    expect(loadPrintSettings()).toEqual({
      deviceId: "01JDEVICE00000000000000001",
      format: "a4",
      template: "custom",
      packingList: true,
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadPrintSettings()).toEqual(DEFAULT_PRINT);
  });
});
