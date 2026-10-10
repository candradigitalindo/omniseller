import { describe, expect, it } from "vitest";
import {
  bucketLabel,
  buckets,
  customProblem,
  exportHref,
  formatPointChange,
  formatRange,
  heatGrid,
  heatLevel,
  packMinutes,
  periodRange,
  reportQuery,
  type SalesReport,
  type StaffReport,
  staffDays,
  staffExportHref,
  todayIn,
  trendPoints,
} from "./report-meta";

const point = (bucket: string, revenue: number, previousRevenue: number | null) => ({
  bucket,
  orders: revenue > 0 ? 1 : 0,
  revenue,
  previousOrders: previousRevenue === null ? null : previousRevenue > 0 ? 1 : 0,
  previousRevenue,
});

function report(over: Partial<SalesReport>): SalesReport {
  return {
    timezone: "Asia/Jakarta",
    range: { from: "2026-10-01", to: "2026-10-31" },
    granularity: "day",
    period: { from: "2026-09-30T17:00:00.000Z", to: "2026-10-06T03:00:00.000Z" },
    previousRange: { from: "2026-09-01", to: "2026-09-30" },
    previousPeriod: { from: "2026-08-31T17:00:00.000Z", to: "2026-09-06T03:00:00.000Z" },
    summary: {
      revenue: 0,
      orders: 0,
      units: 0,
      averageOrderValue: 0,
      paidOrders: 0,
      cancelledOrders: 0,
      cancellationRate: null,
      shippedOrders: 0,
      shippedRevenue: 0,
      previous: null,
      change: null,
    },
    series: [],
    byChannel: [],
    byStore: [],
    byProduct: [],
    byCategory: [],
    byRegion: [],
    byHour: [],
    ...over,
  };
}

describe("report periods (L30, backend doc 8.20)", () => {
  it("asks for whole calendar months for this month and last month, so the api compares month with month", () => {
    expect(periodRange("month", "2026-10-06")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(periodRange("last_month", "2026-10-06")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    // across a year and into February
    expect(periodRange("last_month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(periodRange("month", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("counts rolling periods back from today, today included", () => {
    expect(periodRange("today", "2026-10-06")).toEqual({ from: "2026-10-06", to: "2026-10-06" });
    expect(periodRange("7d", "2026-10-06")).toEqual({ from: "2026-09-30", to: "2026-10-06" });
    expect(periodRange("30d", "2026-10-06")).toEqual({ from: "2026-09-07", to: "2026-10-06" });
  });

  it("takes a custom period only once it is usable", () => {
    expect(periodRange("custom", "2026-10-06", { from: "2026-08-01", to: "2026-08-15" })).toEqual({
      from: "2026-08-01",
      to: "2026-08-15",
    });
    expect(periodRange("custom", "2026-10-06", { from: "", to: "2026-08-15" })).toBeNull();
    expect(customProblem("2026-08-15", "2026-08-01")).toBe("order");
    expect(customProblem("2025-01-01", "2026-01-02")).toBe("length"); // 367 days
    expect(customProblem("2025-01-01", "2025-12-31")).toBeNull();
    expect(customProblem("2024-01-01", "2024-12-31")).toBeNull(); // 366 days in a leap year
  });

  it("reads today in the business's time zone, not the browser's", () => {
    // 23.30 UTC on 5 October is already 6 October in Jakarta and still 5 October in New York
    const at = new Date("2026-10-05T23:30:00Z");
    expect(todayIn("Asia/Jakarta", at)).toBe("2026-10-06");
    expect(todayIn("America/New_York", at)).toBe("2026-10-05");
  });
});

describe("the trend chart", () => {
  it("lists buckets as the api does: days, weeks from Monday, months", () => {
    expect(buckets("2026-10-01", "2026-10-03", "day")).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(buckets("2026-10-01", "2026-10-14", "week")).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(buckets("2026-08-15", "2026-10-01", "month")).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
  });

  it("stops a running month at today and pairs each day with the same day of the month before", () => {
    const series = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map((d, i) =>
      point(d, i < 2 ? 100 : 0, 50),
    );
    const points = trendPoints(
      report({
        range: { from: "2026-10-05", to: "2026-10-08" },
        previousRange: { from: "2026-10-01", to: "2026-10-04" },
        series,
      }),
      "2026-10-06",
    );
    expect(points.map((p) => [p.bucket, p.previousBucket])).toEqual([
      ["2026-10-05", "2026-10-01"],
      ["2026-10-06", "2026-10-02"],
    ]);
  });

  it("keeps every bucket of a past period and has no comparison without one", () => {
    const series = [point("2026-09-01", 10, null), point("2026-09-02", 0, null)];
    const points = trendPoints(
      report({ range: { from: "2026-09-01", to: "2026-09-02" }, previousRange: null, series }),
      "2026-10-06",
    );
    expect(points.map((p) => [p.bucket, p.previousBucket])).toEqual([
      ["2026-09-01", null],
      ["2026-09-02", null],
    ]);
  });

  it("labels buckets by their unit", () => {
    expect(bucketLabel("2026-10-06", "day")).toBe("6 Okt");
    expect(bucketLabel("2026-09-28", "week")).toBe("28 Sep");
    expect(bucketLabel("2026-10-01", "month")).toBe("Okt 2026");
    expect(formatRange({ from: "2026-10-01", to: "2026-10-31" })).toBe("1 Okt 2026 – 31 Okt 2026");
    expect(formatRange({ from: "2026-10-06", to: "2026-10-06" })).toBe("6 Okt 2026");
  });
});

describe("the busy-time map", () => {
  it("fills every weekday and hour, Monday first, zero where nothing sold", () => {
    const grid = heatGrid([
      { weekday: 1, hour: 0, orders: 2, revenue: 100 },
      { weekday: 7, hour: 23, orders: 5, revenue: 900 },
    ]);
    expect(grid).toHaveLength(7);
    expect(grid.every((row) => row.length === 24)).toBe(true);
    expect(grid[0]?.[0]).toEqual({ weekday: 1, hour: 0, orders: 2, revenue: 100 });
    expect(grid[6]?.[23]).toEqual({ weekday: 7, hour: 23, orders: 5, revenue: 900 });
    expect(grid[3]?.[12]).toEqual({ weekday: 4, hour: 12, orders: 0, revenue: 0 });
  });

  it("steps cells from 1 to 8 by their share of the busiest hour, 0 for none", () => {
    expect(heatLevel(0, 40)).toBe(0);
    expect(heatLevel(1, 40)).toBe(1);
    expect(heatLevel(5, 40)).toBe(1);
    expect(heatLevel(6, 40)).toBe(2);
    expect(heatLevel(20, 40)).toBe(4);
    expect(heatLevel(40, 40)).toBe(8);
    expect(heatLevel(3, 0)).toBe(0);
  });
});

describe("report queries", () => {
  it("narrows by a store before its channel and keeps the comparison switch", () => {
    const range = { from: "2026-10-01", to: "2026-10-31" };
    expect(reportQuery({ range, granularity: "day", storeId: "S1", channel: "shopee", compare: true })).toEqual({
      ...range,
      granularity: "day",
      compare: "true",
      storeId: "S1",
    });
    expect(reportQuery({ range, granularity: "week", storeId: null, channel: "shopee", compare: false })).toEqual({
      ...range,
      granularity: "week",
      compare: "false",
      channel: "shopee",
    });
  });

  it("downloads a part with the same filters", () => {
    const query = reportQuery({
      range: { from: "2026-10-01", to: "2026-10-31" },
      granularity: "day",
      storeId: null,
      channel: "manual",
      compare: true,
    });
    const url = new URL(exportHref("regions", query), "http://x");
    expect(url.pathname).toBe("/v1/reports/sales/export");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      granularity: "day",
      compare: "true",
      channel: "manual",
      section: "regions",
    });
  });

  it("writes a change of the cancellation rate in points", () => {
    expect(formatPointChange(1.25)).toBe("+1,3 poin");
    expect(formatPointChange(-0.5)).toBe("-0,5 poin");
    expect(formatPointChange(0)).toBe("0 poin");
  });
});

describe("the team report (L33)", () => {
  it("writes the average packing time in minutes with one decimal", () => {
    expect(packMinutes(95)).toBe("1,6");
    expect(packMinutes(20)).toBe("0,3");
    expect(packMinutes(600)).toBe("10,0");
    expect(packMinutes(null)).toBeNull();
  });

  it("downloads per member or per member per day for the period", () => {
    expect(staffExportHref("users", { from: "2026-10-01", to: "2026-10-31" })).toBe(
      "/v1/reports/staff/export?from=2026-10-01&to=2026-10-31&section=users",
    );
    expect(staffExportHref("days", {})).toBe("/v1/reports/staff/export?section=days");
  });

  it("lists the team's days, or one member's", () => {
    const f = {
      processed: 1,
      packed: 0,
      packedByScan: 0,
      labels: 0,
      pickLists: 0,
      packingLists: 0,
      handedOver: 0,
      timedPacks: 0,
      packSecondsAverage: null,
    };
    const report = {
      days: [{ date: "2026-10-01", ...f }],
      userDays: [
        { userId: "a", date: "2026-10-01", ...f },
        { userId: "b", date: "2026-10-02", ...f },
      ],
    } as unknown as StaffReport;
    expect(staffDays(report, null)).toBe(report.days);
    expect(staffDays(report, "b").map((d) => d.date)).toEqual(["2026-10-02"]);
  });
});
