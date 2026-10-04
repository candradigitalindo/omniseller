import { describe, expect, it } from "vitest";
import {
  barcodeFor,
  barcodeProblem,
  CODE128_PATTERNS,
  code128,
  code128Values,
  ean8,
  ean13,
  gtinCheckDigit,
  internalEan13,
  isValidGtin,
} from "./barcode";

describe("GTIN check digits (FR-PRD-12)", () => {
  it("computes the GS1 mod-10 check digit for every GTIN length", () => {
    expect(gtinCheckDigit("400638133393")).toBe(1); // EAN-13 4006381333931
    expect(gtinCheckDigit("899123456789")).toBe(1); // EAN-13 8991234567891 (Indonesia, 899)
    expect(gtinCheckDigit("03600029145")).toBe(2); // UPC-A 036000291452
    expect(gtinCheckDigit("9638507")).toBe(4); // EAN-8 96385074
    expect(isValidGtin("4006381333931")).toBe(true);
    expect(isValidGtin("4006381333932")).toBe(false);
    expect(isValidGtin("12345")).toBe(false);
  });

  it("refuses spaces, other characters, and EAN/UPC numbers with a wrong last digit", () => {
    expect(barcodeProblem("8991234567891")).toBeNull();
    expect(barcodeProblem("KAOS-HTM-L")).toBeNull();
    expect(barcodeProblem("12345")).toBeNull(); // not GTIN-shaped: an internal number
    expect(barcodeProblem("8991234567890")).toMatch(/Digit terakhir/);
    expect(barcodeProblem("KAOS HTM")).toMatch(/tanpa spasi/);
    expect(barcodeProblem("KAOS-É")).toMatch(/tanpa spasi/);
    expect(barcodeProblem("A".repeat(49))).toMatch(/48 karakter/);
  });

  it("numbers internal EAN-13s under prefix 20, valid for any scanner", () => {
    expect(internalEan13(1)).toBe("2000000000015");
    expect(internalEan13(9_999_999_999)).toMatch(/^209999999999\d$/);
    for (const n of [1, 42, 123_456]) expect(isValidGtin(internalEan13(n))).toBe(true);
    expect(() => internalEan13(0)).toThrow(RangeError);
  });
});

describe("EAN bars", () => {
  it("draws an EAN-13: 95 modules, 30 bars, guards, left parity from the first digit", () => {
    const b = ean13("4006381333931");
    expect(b.modules).toBe(95);
    expect(b.bars).toHaveLength(30);
    expect(b.bars.filter((x) => x.guard)).toHaveLength(6);
    // first digit 4: left parity LGLLGG; built by hand from the published L, G, and R tables
    expect(modulesOf(b)).toBe(
      "101" +
        ["0001101", "0100111", "0101111", "0111101", "0001001", "0110011"].join("") +
        "01010" +
        ["1000010", "1000010", "1000010", "1110100", "1000010", "1100110"].join("") +
        "101",
    );
    expect(b.text).toBe("4 006381 333931");
    expect(b.quiet).toEqual({ left: 11, right: 7 });
    expect(() => ean13("4006381333932")).toThrow(RangeError);
  });

  it("draws an EAN-8 and treats a UPC-A as an EAN-13 with a leading zero", () => {
    const e8 = ean8("96385074");
    expect(e8.modules).toBe(67);
    expect(e8.bars).toHaveLength(22);
    const upc = barcodeFor("036000291452");
    expect(upc.symbology).toBe("ean13");
    expect(upc.bars).toEqual(ean13("0036000291452").bars);
    expect(upc.text).toBe("036000291452");
    expect(barcodeFor("8991234567891").symbology).toBe("ean13");
    expect(barcodeFor("96385074").symbology).toBe("ean8");
  });
});

describe("Code 128 bars", () => {
  it("keeps the published table: 11 modules a symbol, an even number of bar modules, all different", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    for (const [value, p] of CODE128_PATTERNS.entries()) {
      const widths = [...p].map(Number);
      expect(
        widths.reduce((n, w) => n + w, 0),
        `value ${value}`,
      ).toBe(value === 106 ? 13 : 11);
      expect(widths.filter((_, i) => i % 2 === 0).reduce((n, w) => n + w, 0) % 2, `value ${value}`).toBe(0);
    }
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
  });

  it("checks the published example and packs digit runs in code set C", () => {
    // "PJJ123C": the published code set A example has check value 54; set B starts at 104, one more
    expect(code128Values("PJJ123C")).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
    // all digits: pairs from the start
    expect(code128Values("12345678")).toEqual([105, 12, 34, 56, 78, checkOf([105, 12, 34, 56, 78]), 106]);
    // an odd run at the end: one digit in B, then pairs
    expect(code128Values("AB12345")).toEqual([
      104,
      33,
      34,
      17,
      99,
      23,
      45,
      checkOf([104, 33, 34, 17, 99, 23, 45]),
      106,
    ]);
    // short runs stay in B
    expect(code128Values("A1B2")).toEqual([104, 33, 17, 34, 18, checkOf([104, 33, 17, 34, 18]), 106]);
  });

  it("draws bars that add up with the stop's termination bar", () => {
    const b = code128("KAOS-HTM-L");
    // start + 10 characters + check = 12 symbols of 11 modules, stop 13
    expect(b.modules).toBe(12 * 11 + 13);
    expect(b.bars).toHaveLength(12 * 3 + 4);
    expect(b.quiet).toEqual({ left: 10, right: 10 });
    expect(barcodeFor("10012345678902").symbology).toBe("code128"); // GTIN-14
    expect(() => code128("KAOS-É")).toThrow(RangeError);
  });
});

function checkOf(values: number[]): number {
  let sum = values[0]!;
  for (let k = 1; k < values.length; k++) sum += values[k]! * k;
  return sum % 103;
}

/** The symbol as a string of modules, 1 for bar. */
function modulesOf(b: { modules: number; bars: { x: number; w: number }[] }): string {
  const m = Array.from({ length: b.modules }, () => "0");
  for (const bar of b.bars) for (let i = 0; i < bar.w; i++) m[bar.x + i] = "1";
  return m.join("");
}
