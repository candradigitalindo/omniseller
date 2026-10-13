import { describe, expect, it } from "vitest";
import { dueReports, REPORT_SPREAD_MS, scanDelayMs } from "./report-scan";

const tenant = (localDate: string, localHour: number, createdOn = "2026-01-01") => ({
  id: "01T",
  localDate,
  localHour,
  createdOn,
});

describe("dueReports", () => {
  it("owes the week before from Monday 07.00 local, all week long", () => {
    const weekly = (d: ReturnType<typeof tenant>) => dueReports(d).filter((x) => x.cadence === "weekly");
    expect(weekly(tenant("2026-10-12", 6))).toEqual([]); // Monday 06.xx
    const week = { tenantId: "01T", cadence: "weekly", periodStart: "2026-10-05", periodEnd: "2026-10-11" };
    expect(weekly(tenant("2026-10-12", 7))).toEqual([week]);
    expect(weekly(tenant("2026-10-13", 0))).toEqual([week]); // Tuesday, catch-up
    expect(weekly(tenant("2026-10-18", 23))).toEqual([week]); // Sunday, still that week
    // the month before stays due all month too, until its run row exists
    expect(dueReports(tenant("2026-10-12", 6)).map((d) => d.cadence)).toEqual(["monthly"]);
  });

  it("owes the month before from the 1st at 07.00, beside the week when both are due", () => {
    expect(dueReports(tenant("2026-11-01", 6)).map((d) => d.cadence)).toEqual(["weekly"]); // a Sunday: last week only
    expect(dueReports(tenant("2026-11-01", 7))).toEqual([
      { tenantId: "01T", cadence: "weekly", periodStart: "2026-10-19", periodEnd: "2026-10-25" },
      { tenantId: "01T", cadence: "monthly", periodStart: "2026-10-01", periodEnd: "2026-10-31" },
    ]);
    expect(dueReports(tenant("2026-11-20", 12)).map((d) => d.cadence)).toEqual(["weekly", "monthly"]);
    expect(dueReports(tenant("2026-06-01", 8)).map((d) => [d.cadence, d.periodStart])).toEqual([
      ["weekly", "2026-05-25"],
      ["monthly", "2026-05-01"],
    ]);
  });

  it("never owes a period that ended before the business existed", () => {
    expect(dueReports(tenant("2026-10-13", 9, "2026-10-12"))).toEqual([]);
    expect(dueReports(tenant("2026-10-13", 9, "2026-10-11"))).toHaveLength(1);
    expect(dueReports(tenant("2026-11-01", 9, "2026-10-31")).map((d) => d.cadence)).toEqual(["monthly"]);
  });
});

describe("scanDelayMs", () => {
  it("spreads businesses over the hour, the same way every scan", () => {
    const a = scanDelayMs("01HZZZZZZZZZZZZZZZZZZZZZZZA");
    expect(a).toBe(scanDelayMs("01HZZZZZZZZZZZZZZZZZZZZZZZA"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(REPORT_SPREAD_MS);
    expect(scanDelayMs("01HZZZZZZZZZZZZZZZZZZZZZZZB")).not.toBe(a);
  });
});
