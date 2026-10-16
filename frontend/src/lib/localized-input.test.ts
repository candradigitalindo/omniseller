import { describe, expect, it } from "vitest";
import { moneyText, parseMoneyText, parseTemporalText, temporalText } from "./localized-input";

describe("Indonesian inputs", () => {
  it("groups whole rupiah without losing precision and accepts a pasted currency prefix", () => {
    expect(moneyText("123456789012345678")).toBe("123.456.789.012.345.678");
    expect(parseMoneyText("Rp 1.250.000")).toBe("1250000");
    expect(parseMoneyText("000500")).toBe("500");
    expect(parseMoneyText("")).toBe("");
    for (const invalid of ["12,50", "12.5", "-1000", "1e6", "Rp abc"]) expect(parseMoneyText(invalid)).toBeNull();
  });
  it("shows Indonesian dates and 24-hour times while keeping canonical API values", () => {
    expect(temporalText("2026-10-05", "date")).toBe("05/10/2026");
    expect(temporalText("2026-10-05T14:30", "datetime-local")).toBe("05/10/2026 14.30");
    expect(parseTemporalText("05/10/2026", "date")).toBe("2026-10-05");
    expect(parseTemporalText("05/10/2026 14.30", "datetime-local")).toBe("2026-10-05T14:30");
    expect(parseTemporalText("14.30", "time")).toBe("14:30");
    expect(parseTemporalText("1430", "time")).toBe("14:30");
    expect(parseTemporalText("14,30", "time")).toBe("14:30");
    expect(parseTemporalText("2026-10-05", "date")).toBe("2026-10-05");
  });
  it("rejects impossible calendar days, missing time, and out-of-range clock values", () => {
    expect(parseTemporalText("29/02/2024", "date")).toBe("2024-02-29");
    for (const invalid of ["29/02/2026", "31/04/2026", "01/13/2026"])
      expect(parseTemporalText(invalid, "date")).toBeNull();
    expect(parseTemporalText("05/10/2026", "datetime-local")).toBeNull();
    expect(parseTemporalText("24.00", "time")).toBeNull();
    expect(parseTemporalText("12.60", "time")).toBeNull();
  });
});
