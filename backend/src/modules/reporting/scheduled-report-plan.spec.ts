import { describe, expect, it } from "vitest";
import {
  mondayOf,
  periodBefore,
  periodLabel,
  REPORT_KINDS,
  reportBody,
  reportKindOf,
  reportKindsOf,
  reportTitle,
  sendsFrom,
} from "./scheduled-report-plan";

describe("scheduled report periods", () => {
  it("reports on the week before, Monday to Sunday, whatever the day it is sent", () => {
    expect(mondayOf("2026-10-13")).toBe("2026-10-12"); // a Tuesday
    expect(mondayOf("2026-10-12")).toBe("2026-10-12"); // the Monday itself
    expect(mondayOf("2026-10-18")).toBe("2026-10-12"); // a Sunday
    for (const date of ["2026-10-12", "2026-10-13", "2026-10-18"]) {
      expect(periodBefore("weekly", date)).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    }
    expect(periodBefore("weekly", "2026-01-01")).toEqual({ from: "2025-12-22", to: "2025-12-28" });
  });

  it("reports on the calendar month before, whatever the day of the month", () => {
    expect(periodBefore("monthly", "2026-10-01")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(periodBefore("monthly", "2026-10-31")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(periodBefore("monthly", "2026-03-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodBefore("monthly", "2026-01-05")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("goes out from 07.00 on the day after the period", () => {
    expect(sendsFrom({ to: "2026-10-11" })).toEqual({ date: "2026-10-12", hour: 7 });
    expect(sendsFrom({ to: "2026-09-30" })).toEqual({ date: "2026-10-01", hour: 7 });
  });

  it("names the period the way the email and the notification say it", () => {
    expect(periodLabel("weekly", { from: "2026-10-05", to: "2026-10-11" })).toBe("minggu 5–11 Okt 2026");
    expect(periodLabel("weekly", { from: "2026-09-28", to: "2026-10-04" })).toBe("minggu 28 Sep–4 Okt 2026");
    expect(periodLabel("weekly", { from: "2025-12-29", to: "2026-01-04" })).toBe("minggu 29 Des 2025–4 Jan 2026");
    expect(periodLabel("monthly", { from: "2026-09-01", to: "2026-09-30" })).toBe("bulan September 2026");
    expect(reportTitle("sales", "weekly", { from: "2026-10-05", to: "2026-10-11" })).toBe(
      "Laporan penjualan minggu 5–11 Okt 2026",
    );
    expect(reportTitle("staff", "monthly", { from: "2026-09-01", to: "2026-09-30" })).toBe(
      "Laporan kinerja tim bulan September 2026",
    );
    expect(reportBody("sales")).toBe(
      "Laporan terlampir di email Anda sebagai berkas Excel. Buka Laporan Penjualan untuk melihatnya di aplikasi.",
    );
    expect(reportBody("staff")).toContain("Buka Kinerja Tim");
  });

  it("knows the four kinds, their permission, and the plan feature the team report needs", () => {
    expect(REPORT_KINDS.map((k) => k.kind)).toEqual([
      "report.sales_weekly",
      "report.sales_monthly",
      "report.staff_weekly",
      "report.staff_monthly",
    ]);
    expect(reportKindsOf("weekly").map((k) => k.report)).toEqual(["sales", "staff"]);
    expect(reportKindOf("report.staff_monthly")).toMatchObject({
      report: "staff",
      cadence: "monthly",
      permission: "settings:user",
      feature: "staff_report",
    });
    expect(reportKindOf("report.sales_weekly")?.feature).toBeNull();
    expect(reportKindOf("digest.daily")).toBeUndefined();
    // every kind matches the preference table's CHECK
    for (const k of REPORT_KINDS) expect(k.kind).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
  });
});
