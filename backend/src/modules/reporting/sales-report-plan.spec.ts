import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  alignSeries,
  averageOrderValue,
  bucketOf,
  buckets,
  cancellationRate,
  daysBetween,
  previousRange,
  reportWindows,
  share,
  wholeMonths,
} from "./sales-report-plan";

const TZ = "Asia/Jakarta";

describe("dates", () => {
  it("adds days and months within the calendar", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2024-03-31", -1)).toBe("2024-02-29");
    expect(addMonths("2026-11-15", 2)).toBe("2027-01-15");
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(31);
  });

  it("knows a range of whole months", () => {
    expect(wholeMonths("2026-09-01", "2026-09-30")).toBe(1);
    expect(wholeMonths("2026-07-01", "2026-09-30")).toBe(3);
    expect(wholeMonths("2026-09-01", "2026-09-29")).toBeNull();
    expect(wholeMonths("2026-09-02", "2026-09-30")).toBeNull();
  });

  it("compares months with the months before, other ranges with as many days before", () => {
    expect(previousRange("2026-10-01", "2026-10-31")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(previousRange("2026-03-01", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousRange("2026-07-01", "2026-09-30")).toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(previousRange("2026-10-05", "2026-10-11")).toEqual({ from: "2026-09-28", to: "2026-10-04" });
  });
});

describe("report windows", () => {
  it("covers whole local days of a past period and the same days before", () => {
    const w = reportWindows(TZ, { from: "2026-09-01", to: "2026-09-30" }, new Date("2026-10-04T05:00:00Z"));
    expect(w.current.from.toISOString()).toBe("2026-08-31T17:00:00.000Z");
    expect(w.current.to.toISOString()).toBe("2026-09-30T17:00:00.000Z");
    expect(w.previous.from.toISOString()).toBe("2026-07-31T17:00:00.000Z");
    expect(w.previous.to.toISOString()).toBe("2026-08-31T17:00:00.000Z");
  });

  it("stops a running period now and the one before at the same point", () => {
    // 4 October 12:00 WIB: this month so far against 1 September to 4 September 12:00
    const now = new Date("2026-10-04T05:00:00Z");
    const w = reportWindows(TZ, { from: "2026-10-01", to: "2026-10-31" }, now);
    expect(w.current.to).toEqual(now);
    expect(w.previousRange).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(w.previous.from.toISOString()).toBe("2026-08-31T17:00:00.000Z");
    expect(w.previous.to.toISOString()).toBe("2026-09-04T05:00:00.000Z");
  });
});

describe("buckets", () => {
  it("starts weeks on Monday and months on the 1st", () => {
    expect(bucketOf("2026-10-04", "week")).toBe("2026-09-28"); // a Sunday
    expect(bucketOf("2026-10-05", "week")).toBe("2026-10-05"); // a Monday
    expect(bucketOf("2026-10-17", "month")).toBe("2026-10-01");
    expect(buckets("2026-09-30", "2026-10-13", "week")).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(buckets("2026-08-15", "2026-10-02", "month")).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
    expect(buckets("2026-10-01", "2026-10-03", "day")).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("lays the period before next to this one, zero where nothing sold", () => {
    const series = alignSeries(
      [{ bucket: "2026-10-02", orders: 2, revenue: 100_000 }],
      [{ bucket: "2026-09-01", orders: 1, revenue: 40_000 }],
      { from: "2026-10-01", to: "2026-10-03" },
      { from: "2026-09-01", to: "2026-09-03" },
      "day",
    );
    expect(series).toEqual([
      { bucket: "2026-10-01", orders: 0, revenue: 0, previousOrders: 1, previousRevenue: 40_000 },
      { bucket: "2026-10-02", orders: 2, revenue: 100_000, previousOrders: 0, previousRevenue: 0 },
      { bucket: "2026-10-03", orders: 0, revenue: 0, previousOrders: 0, previousRevenue: 0 },
    ]);
    expect(
      alignSeries([], null, { from: "2026-10-01", to: "2026-10-01" }, { from: "2026-09-30", to: "2026-09-30" }, "day"),
    ).toEqual([{ bucket: "2026-10-01", orders: 0, revenue: 0, previousOrders: null, previousRevenue: null }]);
  });
});

describe("figures", () => {
  it("derives the cancellation rate, average order value, and shares", () => {
    expect(cancellationRate({ paid: 40, cancelled: 3 })).toBe(7.5);
    expect(cancellationRate({ paid: 0, cancelled: 0 })).toBeNull();
    expect(averageOrderValue({ orders: 3, revenue: 100_000 })).toBe(33_333);
    expect(averageOrderValue({ orders: 0, revenue: 0 })).toBe(0);
    expect(share(150, 400)).toBe(37.5);
    expect(share(1, 0)).toBe(0);
  });
});
