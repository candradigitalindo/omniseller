import { describe, expect, it } from "vitest";
import { clock, cutoffProblems, DEFAULT_WEEK, daysLabel, weekProblem, weekSummary } from "./courier-hours-meta";

describe("courier days and hours", () => {
  it("names the days a courier comes, Monday first", () => {
    expect(daysLabel([0, 1, 2, 3, 4, 5, 6], "Setiap hari")).toBe("Setiap hari");
    expect(daysLabel([6, 1, 2, 3, 4, 5], "Setiap hari")).toBe("Sen–Sab");
    expect(daysLabel([1, 3, 5], "Setiap hari")).toBe("Sen, Rab, Jum");
    expect(daysLabel([6, 0], "Setiap hari")).toBe("Sab, Min");
    expect(daysLabel([5, 6, 0], "Setiap hari")).toBe("Jum–Min");
  });

  it("writes times the Indonesian way", () => {
    expect(clock("15:00")).toBe("15.00");
    expect(clock("07:30:00")).toBe("07.30");
  });

  it("checks a week day by day, Monday first", () => {
    expect(weekProblem(DEFAULT_WEEK)).toBeNull();
    const late = DEFAULT_WEEK.map((d, i) => (i === 3 ? { open: "17:00", close: "08:00" } : d));
    expect(weekProblem(late)).toEqual({ day: 3, key: "closeBeforeOpen" });
    const typo = DEFAULT_WEEK.map((d, i) => (i === 1 ? { open: "8", close: "17:00" } : d));
    expect(weekProblem(typo)).toEqual({ day: 1, key: "timeFormatDay" });
  });

  it("sums a week up in one line", () => {
    expect(weekSummary(DEFAULT_WEEK, "tutup")).toBe("08.00–17.00 Sen–Jum, 08.00–14.00 Sab");
    expect(weekSummary([null, null, null, null, null, null, null], "tutup semua hari")).toBe("tutup semua hari");
  });

  it("says what a cut-off still needs", () => {
    expect(cutoffProblems({ warehouseId: "W", courier: "J&T", cutoffTime: "15:00", days: [1] })).toEqual({});
    expect(cutoffProblems({ warehouseId: "", courier: " ", cutoffTime: "", days: [] })).toEqual({
      warehouseId: "warehouseRequired",
      courier: "courierRequired",
      cutoffTime: "timeFormat",
      days: "daysRequired",
    });
  });
});
