import { describe, expect, it } from "vitest";
import {
  changePct,
  lastDates,
  rangeWindows,
  STALE_ORDER_SYNC_MS,
  salesSeries,
  storeHealth,
  tasksFrom,
} from "./dashboard-plan";

const TZ = "Asia/Jakarta";
// 14:15 WIB on Saturday 3 October 2026
const NOW = new Date("2026-10-03T07:15:00.000Z");

describe("dashboard periods", () => {
  it("compares today so far with yesterday up to the same time", () => {
    const w = rangeWindows("today", TZ, NOW);
    expect(w.current.from.toISOString()).toBe("2026-10-02T17:00:00.000Z");
    expect(w.current.to).toBe(NOW);
    expect(w.previous.from.toISOString()).toBe("2026-10-01T17:00:00.000Z");
    expect(w.previous.to.toISOString()).toBe("2026-10-02T07:15:00.000Z");
  });

  it("compares the last 7 or 30 days, today included, with the days before them", () => {
    const week = rangeWindows("7d", TZ, NOW);
    expect(week.current.from.toISOString()).toBe("2026-09-26T17:00:00.000Z");
    expect(week.previous.from.toISOString()).toBe("2026-09-19T17:00:00.000Z");
    expect(week.previous.to.toISOString()).toBe("2026-09-26T07:15:00.000Z");
    const month = rangeWindows("30d", TZ, NOW);
    expect(month.current.from.toISOString()).toBe("2026-09-03T17:00:00.000Z");
    expect(month.previous.from.toISOString()).toBe("2026-08-04T17:00:00.000Z");
  });

  it("lists the last days in the business's calendar, oldest first", () => {
    expect(lastDates(TZ, NOW, 3)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    // 23:30 WIB is already the next day in Jakarta, not in UTC
    expect(lastDates(TZ, new Date("2026-10-03T16:30:00Z"), 1)).toEqual(["2026-10-03"]);
    expect(lastDates(TZ, new Date("2026-10-03T17:30:00Z"), 1)).toEqual(["2026-10-04"]);
  });
});

describe("dashboard figures", () => {
  it("gives the change in percent with one decimal, or null with nothing to compare", () => {
    expect(changePct(150, 100)).toBe(50);
    expect(changePct(50, 100)).toBe(-50);
    expect(changePct(1, 3)).toBe(-66.7);
    expect(changePct(5, 0)).toBeNull();
    expect(changePct(0, 0)).toBeNull();
  });

  it("builds one chart series per channel with zero on days without sales", () => {
    const series = salesSeries(
      [
        { day: "2026-10-01", channel: "tiktokshop", orders: 2, revenue: 90_000 },
        { day: "2026-10-03", channel: "shopee", orders: 1, revenue: 50_000 },
        { day: "2026-10-01", channel: "shopee", orders: 3, revenue: 120_000 },
      ],
      ["2026-10-01", "2026-10-02", "2026-10-03"],
    );
    expect(series).toEqual([
      { channel: "shopee", revenue: [120_000, 0, 50_000], orders: [3, 0, 1] },
      { channel: "tiktokshop", revenue: [90_000, 0, 0], orders: [2, 0, 0] },
    ]);
  });
});

describe("store health", () => {
  const healthy = {
    status: "active",
    reasonText: null,
    syncMode: "live",
    lastOrderSyncAt: new Date(NOW.getTime() - 60_000),
    unmappedWarehouses: 0,
  };

  it("is a problem when the store must be reconnected", () => {
    expect(storeHealth({ ...healthy, status: "reauth_required", reasonText: "Izin dicabut." }, NOW)).toEqual({
      health: "problem",
      reason: "Izin dicabut.",
    });
    expect(storeHealth({ ...healthy, status: "reauth_required" }, NOW).reason).toBe("Toko perlu dihubungkan ulang.");
  });

  it("needs attention for what will matter soon", () => {
    expect(storeHealth({ ...healthy, status: "token_expiring" }, NOW).health).toBe("attention");
    expect(storeHealth({ ...healthy, lastOrderSyncAt: null }, NOW).reason).toBe(
      "Impor pesanan 90 hari sedang berjalan.",
    );
    const stale = new Date(NOW.getTime() - STALE_ORDER_SYNC_MS - 60_000);
    expect(storeHealth({ ...healthy, lastOrderSyncAt: stale }, NOW).reason).toBe(
      "Pesanan terakhir tersinkron 31 menit lalu.",
    );
    expect(storeHealth({ ...healthy, unmappedWarehouses: 2 }, NOW).reason).toBe(
      "2 gudang marketplace belum dipetakan.",
    );
    expect(storeHealth({ ...healthy, syncMode: "read_only" }, NOW).health).toBe("attention");
  });

  it("is healthy otherwise", () => {
    expect(storeHealth(healthy, NOW)).toEqual({ health: "healthy", reason: null });
  });
});

describe("tasks (Perlu tindakan)", () => {
  const none = {
    overdue: 0,
    dueSoon: 0,
    problem: 0,
    newOrders: 0,
    criticalStock: 0,
    storesToReconnect: 0,
    unmappedListings: 0,
  };

  it("is empty when nothing needs anyone", () => {
    expect(tasksFrom(none)).toEqual([]);
  });

  it("puts the most urgent first and says how many", () => {
    const tasks = tasksFrom({
      overdue: 1,
      dueSoon: 4,
      problem: 2,
      newOrders: 7,
      criticalStock: 3,
      storesToReconnect: 1,
      unmappedListings: 5,
    });
    expect(tasks.map((t) => [t.kind, t.severity, t.count])).toEqual([
      ["orders_due", "critical", 4],
      ["stores_reconnect", "critical", 1],
      ["orders_problem", "warning", 2],
      ["stock_critical", "warning", 3],
      ["orders_new", "info", 7],
      ["listings_unmapped", "info", 5],
    ]);
    expect(tasks[0]!.title).toBe("4 pesanan harus segera dikirim (1 sudah terlambat)");
  });

  it("warns about orders due within 6 hours and skips sections the user may not see", () => {
    const tasks = tasksFrom({ ...none, dueSoon: 2, criticalStock: null, unmappedListings: null });
    expect(tasks).toEqual([
      { kind: "orders_due", severity: "warning", count: 2, title: "2 pesanan harus dikirim dalam 6 jam" },
    ]);
  });
});
