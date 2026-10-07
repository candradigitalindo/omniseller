import { localDate, startOfDate } from "../../common/time-zone";

/**
 * Dashboard decisions as pure functions (backend doc 8.16, PRD FR-RPT-01, UI L01): the periods the
 * figures cover in the business's time zone, changes against the period before, the 30-day chart, how
 * healthy a store is, and the "Perlu tindakan" tasks.
 */

export type DashboardRange = "today" | "7d" | "30d";
const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The last `days` local dates, oldest first, ending with today. */
export function lastDates(tz: string, now: Date, days: number): string[] {
  const today = localDate(tz, now);
  return Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
}

export interface Window {
  from: Date;
  to: Date;
}

/**
 * The period of the figure cards and the one it is compared with: today so far against yesterday up
 * to the same time, or the last 7 or 30 days including today against the days before them.
 */
export function rangeWindows(range: DashboardRange, tz: string, now: Date): { current: Window; previous: Window } {
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30;
  const firstDate = lastDates(tz, now, days)[0]!;
  const from = startOfDate(tz, firstDate);
  const previousFrom = startOfDate(tz, addDays(firstDate, -days));
  return {
    current: { from, to: now },
    previous: { from: previousFrom, to: new Date(previousFrom.getTime() + (now.getTime() - from.getTime())) },
  };
}

/** Percentage change, one decimal; null when there is nothing to compare with. */
export function changePct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** The chart: one series per channel over the given dates, days without sales as zero. */
export function salesSeries(
  rows: { day: string; channel: string; orders: number; revenue: number }[],
  dates: string[],
): { channel: string; revenue: number[]; orders: number[] }[] {
  const channels = [...new Set(rows.map((r) => r.channel))].sort();
  return channels.map((channel) => {
    const byDay = new Map(rows.filter((r) => r.channel === channel).map((r) => [r.day, r]));
    return {
      channel,
      revenue: dates.map((d) => byDay.get(d)?.revenue ?? 0),
      orders: dates.map((d) => byDay.get(d)?.orders ?? 0),
    };
  });
}

export type StoreHealth = "healthy" | "attention" | "problem";

/** Orders not read for this long show the store as needing attention (the poll runs every 5 minutes). */
export const STALE_ORDER_SYNC_MS = 30 * 60_000;

/** "Status toko": problem when the store must be reconnected, attention for what needs a look soon. */
export function storeHealth(
  s: {
    status: string;
    reasonText: string | null;
    syncMode: string;
    lastOrderSyncAt: Date | null;
    unmappedWarehouses: number;
  },
  now: Date,
): { health: StoreHealth; reason: string | null } {
  if (s.status === "reauth_required") {
    return { health: "problem", reason: s.reasonText ?? "Toko perlu dihubungkan ulang." };
  }
  if (s.status === "token_expiring")
    return { health: "attention", reason: "Izin toko di marketplace segera berakhir." };
  if (!s.lastOrderSyncAt) return { health: "attention", reason: "Impor pesanan 90 hari sedang berjalan." };
  const stale = now.getTime() - s.lastOrderSyncAt.getTime();
  if (stale > STALE_ORDER_SYNC_MS) {
    return {
      health: "attention",
      reason: `Pesanan terakhir tersinkron ${Math.round(stale / 60_000)} menit lalu.`,
    };
  }
  if (s.unmappedWarehouses > 0) {
    return { health: "attention", reason: `${s.unmappedWarehouses} gudang marketplace belum dipetakan.` };
  }
  if (s.syncMode === "read_only") {
    return { health: "attention", reason: "Mode uji berdampingan: stok belum didorong ke marketplace." };
  }
  return { health: "healthy", reason: null };
}

export interface Task {
  kind:
    | "orders_cutoff"
    | "orders_due"
    | "orders_problem"
    | "orders_new"
    | "stock_critical"
    | "stores_reconnect"
    | "listings_unmapped"
    | "legal_nib"
    | "legal_documents";
  severity: "critical" | "warning" | "info";
  count: number;
  title: string;
}

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const;

/** Most urgent first, keeping the order within one severity (the list shows its first five). */
export function bySeverity<T extends { severity: keyof typeof SEVERITY_RANK }>(tasks: T[]): T[] {
  return tasks
    .map((t, i) => [t, i] as const)
    .sort((a, b) => SEVERITY_RANK[a[0].severity] - SEVERITY_RANK[b[0].severity] || a[1] - b[1])
    .map(([t]) => t);
}

/** "Perlu tindakan": what needs someone now, most urgent first; sections the user may not see are null. */
export function tasksFrom(c: {
  /** Orders to ship whose courier cut-off is today or earlier (backend doc 8.31); null without cut-offs. */
  cutoff?: { count: number; missed: number; nextTime: string | null } | null;
  overdue: number;
  dueSoon: number;
  problem: number;
  newOrders: number;
  criticalStock: number | null;
  storesToReconnect: number;
  unmappedListings: number | null;
}): Task[] {
  const tasks: Task[] = [];
  if (c.cutoff && c.cutoff.count > 0) {
    const { count, missed, nextTime } = c.cutoff;
    tasks.push({
      kind: "orders_cutoff",
      severity: missed > 0 ? "critical" : "warning",
      count,
      title: nextTime
        ? missed > 0
          ? `${count} pesanan harus dikirim sebelum pickup ${nextTime} (${missed} sudah lewat cut-off)`
          : `${count} pesanan harus dikirim sebelum pickup ${nextTime}`
        : `${count} pesanan lewat cut-off kurir hari ini`,
    });
  }
  if (c.dueSoon > 0) {
    tasks.push({
      kind: "orders_due",
      severity: c.overdue > 0 ? "critical" : "warning",
      count: c.dueSoon,
      title:
        c.overdue > 0
          ? `${c.dueSoon} pesanan harus segera dikirim (${c.overdue} sudah terlambat)`
          : `${c.dueSoon} pesanan harus dikirim dalam 6 jam`,
    });
  }
  if (c.storesToReconnect > 0) {
    tasks.push({
      kind: "stores_reconnect",
      severity: "critical",
      count: c.storesToReconnect,
      title: `${c.storesToReconnect} toko perlu dihubungkan ulang`,
    });
  }
  if (c.problem > 0) {
    tasks.push({
      kind: "orders_problem",
      severity: "warning",
      count: c.problem,
      title: `${c.problem} pesanan bermasalah`,
    });
  }
  if (c.criticalStock) {
    tasks.push({
      kind: "stock_critical",
      severity: "warning",
      count: c.criticalStock,
      title: `${c.criticalStock} produk stok habis atau menipis`,
    });
  }
  if (c.newOrders > 0) {
    tasks.push({
      kind: "orders_new",
      severity: "info",
      count: c.newOrders,
      title: `${c.newOrders} pesanan baru menunggu diproses`,
    });
  }
  if (c.unmappedListings) {
    tasks.push({
      kind: "listings_unmapped",
      severity: "info",
      count: c.unmappedListings,
      title: `${c.unmappedListings} listing belum terhubung ke produk`,
    });
  }
  return tasks;
}
