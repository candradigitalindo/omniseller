import type { components, operations } from "@/lib/api/schema";

export type SalesReport = components["schemas"]["SalesReportDto_Output"];
export type Granularity = SalesReport["granularity"];
export type SeriesPoint = SalesReport["series"][number];
export type ReportQuery = NonNullable<operations["ReportsController_report"]["parameters"]["query"]>;
export type Channel = NonNullable<ReportQuery["channel"]>;
export type Section = "series" | "channels" | "stores" | "products" | "categories" | "regions" | "hours";
export type StaffReport = components["schemas"]["StaffReportDto_Output"];
export type StaffFigures = StaffReport["total"];
export type StaffQuery = NonNullable<operations["ReportsController_staffReport"]["parameters"]["query"]>;
export type StaffSection = "users" | "days";

const CHANNELS = [
  "shopee",
  "tiktokshop",
  "lazada",
  "blibli",
  "shopify",
  "woocommerce",
  "manual",
] as const satisfies readonly Channel[];

/** A channel from the URL, or null when it is not one the api knows. */
export function channelOf(value: string | null): Channel | null {
  return CHANNELS.find((c) => c === value) ?? null;
}

/** The period presets above the report (DOKUMEN-UI-UX 13.3 and L30). */
export const PERIODS = ["today", "7d", "30d", "month", "last_month", "custom"] as const;
export type Period = (typeof PERIODS)[number];
export const GRANULARITIES = ["day", "week", "month"] as const satisfies readonly Granularity[];
/** The api's longest period (backend doc 8.20). */
export const MAX_DAYS = 366;

export function periodOf(value: string | null): Period {
  return PERIODS.find((p) => p === value) ?? "month";
}

export function granularityOf(value: string | null): Granularity {
  return GRANULARITIES.find((g) => g === value) ?? "day";
}

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date, YYYY-MM-DD, in the business's time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** YYYY-MM-DD plus n days. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus n months, the day kept within the month (as the api counts them). */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

const firstOfMonth = (date: string) => `${date.slice(0, 8)}01`;
const lastOfMonth = (date: string) => addDays(addMonths(firstOfMonth(date), 1), -1);

/** Days from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** What is wrong with a custom period, if anything. */
export function customProblem(from: string, to: string): "missing" | "order" | "length" | null {
  if (!DATE.test(from) || !DATE.test(to)) return "missing";
  if (from > to) return "order";
  if (daysBetween(from, to) > MAX_DAYS) return "length";
  return null;
}

/**
 * The dates a preset asks the api for. "Bulan ini" is the whole calendar month: the api then compares it with
 * last month up to the same day and hour, while the first of the month until today would be compared with
 * as many days just before (backend doc 8.20). Null for a custom period that is not usable yet.
 */
export function periodRange(
  period: Period,
  today: string,
  custom: { from: string; to: string } = { from: "", to: "" },
): { from: string; to: string } | null {
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: firstOfMonth(today), to: lastOfMonth(today) };
    case "last_month": {
      const first = addMonths(firstOfMonth(today), -1);
      return { from: first, to: lastOfMonth(first) };
    }
    case "custom":
      return customProblem(custom.from, custom.to) ? null : custom;
  }
}

/** The first day of the bucket a date falls in: itself, the Monday of its week, or the 1st of its month. */
export function bucketOf(date: string, unit: Granularity): string {
  if (unit === "day") return date;
  if (unit === "month") return firstOfMonth(date);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/** Every bucket from the one holding `from` to the one holding `to`, as the api lists them. */
export function buckets(from: string, to: string, unit: Granularity): string[] {
  const out: string[] = [];
  for (let b = bucketOf(from, unit); b <= to; ) {
    out.push(b);
    b = unit === "day" ? addDays(b, 1) : unit === "week" ? addDays(b, 7) : addMonths(b, 1);
  }
  return out;
}

export interface TrendPoint extends SeriesPoint {
  /** the bucket of the period before laid next to this one, when there is a comparison */
  previousBucket: string | null;
}

/**
 * The chart's points. A period still running lists its days to come as zeros, and so does its comparison
 * (cut at the same point), so both lines would fall to zero: the chart stops at today's bucket.
 */
export function trendPoints(report: SalesReport, today: string): TrendPoint[] {
  const before = report.previousRange
    ? buckets(report.previousRange.from, report.previousRange.to, report.granularity)
    : [];
  const last = bucketOf(today, report.granularity);
  return report.series
    .map((p, i) => ({ ...p, previousBucket: report.previousRange ? (before[i] ?? null) : null }))
    .filter((p) => p.bucket <= last);
}

/** Whether the report's period reaches today, so the api counted only up to now. */
export function isRunning(report: SalesReport, today: string): boolean {
  return report.range.to >= today;
}

const labelFormats = {
  day: new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", timeZone: "UTC" }),
  week: new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", timeZone: "UTC" }),
  month: new Intl.DateTimeFormat("id-ID", { month: "short", year: "numeric", timeZone: "UTC" }),
} satisfies Record<Granularity, Intl.DateTimeFormat>;

/** A bucket on the axis: "6 Okt" for a day, the Monday "30 Sep" for a week, "Okt 2026" for a month. */
export function bucketLabel(bucket: string, unit: Granularity): string {
  return labelFormats[unit].format(new Date(`${bucket}T00:00:00Z`));
}

const dateFormat = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** A local date of the report: "6 Okt 2026". */
export function formatLocalDate(date: string): string {
  return dateFormat.format(new Date(`${date}T00:00:00Z`));
}

/** "1 Okt 2026 – 31 Okt 2026", or the single date. */
export function formatRange(range: { from: string; to: string }): string {
  return range.from === range.to
    ? formatLocalDate(range.from)
    : `${formatLocalDate(range.from)} – ${formatLocalDate(range.to)}`;
}

/** Weekdays as the api numbers them: 1 Monday to 7 Sunday. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function weekdayOf(n: number): Weekday {
  return WEEKDAYS.find((w) => w === n) ?? 1;
}
export const HOURS = Array.from({ length: 24 }, (_, h) => h);
/** Steps of the sequential scale (DOKUMEN-UI-UX 13.2), lightest to darkest. */
export const HEAT_STEPS = 8;
export const HEAT_LEVELS = Array.from({ length: HEAT_STEPS }, (_, i) => i + 1);

export interface HeatCell {
  weekday: number;
  hour: number;
  orders: number;
  revenue: number;
}

/** Every weekday and hour of the busy-time map, zero where nothing sold, row by row from Monday. */
export function heatGrid(byHour: SalesReport["byHour"]): HeatCell[][] {
  const at = new Map(byHour.map((c) => [`${c.weekday}|${c.hour}`, c]));
  return WEEKDAYS.map((weekday) =>
    HOURS.map((hour) => {
      const c = at.get(`${weekday}|${hour}`);
      return { weekday, hour, orders: c?.orders ?? 0, revenue: c?.revenue ?? 0 };
    }),
  );
}

/** The step of a cell: 0 for nothing, else 1 to 8 by its share of the busiest hour. */
export function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(HEAT_STEPS, Math.max(1, Math.ceil((value / max) * HEAT_STEPS)));
}

/** The query both the report and its CSV take; a store narrows more than its channel. */
export function reportQuery(f: {
  range: { from: string; to: string };
  granularity: Granularity;
  storeId: string | null;
  channel: Channel | null;
  compare: boolean;
}): ReportQuery {
  return {
    from: f.range.from,
    to: f.range.to,
    granularity: f.granularity,
    compare: f.compare ? "true" : "false",
    ...(f.storeId ? { storeId: f.storeId } : f.channel ? { channel: f.channel } : {}),
  };
}

/** The CSV of one part of the report (`penjualan-<bagian>-<dari>-<sampai>.csv`), same filters. */
export function exportHref(section: Section, query: ReportQuery): string {
  const params = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined));
  params.set("section", section);
  return `/v1/reports/sales/export?${params}`;
}

/** The team report's CSV (`kinerja-tim-per-anggota-<dari>-<sampai>.csv`), same period (L33 "Unduh"). */
export function staffExportHref(section: StaffSection, query: StaffQuery): string {
  const params = new URLSearchParams({
    ...(query.from && query.to ? { from: query.from, to: query.to } : {}),
    section,
  });
  return `/v1/reports/staff/export?${params}`;
}

/** An average packing time as minutes with one decimal, the unit of L33's column: 95 s is "1,6". */
export function packMinutes(seconds: number | null): string | null {
  if (seconds === null) return null;
  return new Intl.NumberFormat("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(seconds / 60);
}

/** The rows of "Per hari": the whole team's days, or one member's. */
export function staffDays(report: StaffReport, memberId: string | null): (StaffFigures & { date: string })[] {
  return memberId ? report.userDays.filter((d) => d.userId === memberId) : report.days;
}

/** A change in percentage points with its sign: "+1,2 poin". */
export function formatPointChange(points: number): string {
  const text = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 }).format(Math.abs(points));
  return `${points > 0 ? "+" : points < 0 ? "-" : ""}${text} poin`;
}

/** A share or a rate in percent: "51,3%". */
export function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 }).format(value)}%`;
}
