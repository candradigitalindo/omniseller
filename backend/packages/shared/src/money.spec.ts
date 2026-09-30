import { describe, expect, it } from "vitest";
import { addRupiah, formatRupiah, InvalidMoneyError, percentOf, rupiah } from "./money.js";

describe("money", () => {
  it("accepts whole rupiah from number, bigint, and digit strings", () => {
    expect(rupiah(245000)).toBe(245000);
    expect(rupiah(245000n)).toBe(245000);
    expect(rupiah("245000")).toBe(245000);
    expect(rupiah("-14000")).toBe(-14000);
  });

  it("rejects decimals and unsafe values instead of rounding", () => {
    expect(() => rupiah(1.5)).toThrow(InvalidMoneyError);
    expect(() => rupiah("1.5")).toThrow(InvalidMoneyError);
    expect(() => rupiah(Number.NaN)).toThrow(InvalidMoneyError);
    expect(() => rupiah(2n ** 60n)).toThrow(InvalidMoneyError);
  });

  it("computes percentages to whole rupiah", () => {
    expect(percentOf(rupiah(245000), 4.5)).toBe(11025);
    expect(percentOf(rupiah(245000), 0.5)).toBe(1225);
    expect(percentOf(rupiah(-1001), 50)).toBe(-501);
  });

  it("adds amounts", () => {
    expect(addRupiah(rupiah(1), rupiah(2), rupiah(3))).toBe(6);
  });

  it("formats like the UI spec", () => {
    expect(formatRupiah(rupiah(1250000))).toBe("Rp 1.250.000");
    expect(formatRupiah(rupiah(-14000))).toBe("-Rp 14.000");
    expect(formatRupiah(rupiah(0))).toBe("Rp 0");
  });
});
