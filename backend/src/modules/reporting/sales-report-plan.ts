import { startOfDate } from "../../common/time-zone";

/**
 * Sales report decisions as pure functions (backend doc 8.20, PRD FR-RPT-02, UI L30): the period and
 * the one it is compared with in the business's time zone, the calendar buckets of the chart, and the
 * derived figures. The service loads data and calls these.
 */

export type Granularity = "day" | "week" | "month";
const DAY_MS = 86_400_000;

/** YYYY-MM-DD plus n days. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD plus n months, the day kept within the month (31 March - 1 month = 28 or 29 February). */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

/** Days from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

const lastOfMonth = (date: string) => addDays(addMonths(`${date.slice(0, 8)}01`, 1), -1);

/** The range covers whole calendar months: the 1st to the last day of a month. */
export function wholeMonths(from: string, to: string): number | null {
  if (!from.endsWith("-01") || to !== lastOfMonth(to)) return null;
  const months =
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
  return months > 0 ? months : null;
}

/** The dates of the period before: the same calendar months for whole months, else as many days. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const months = wholeMonths(from, to);
  if (months) {
    const start = addMonths(from, -months);
    return { from: start, to: addDays(from, -1) };
  }
  const days = daysBetween(from, to);
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

export interface Window {
  from: Date;
  to: Date;
}

/**
 * Instants of the report and of its comparison. A period that is still running stops at `now`, and the
 * one before it at the same point of its own length ("bulan ini vs bulan lalu" up to the same day and
 * hour), so a month in progress is not compared with a whole month.
 */
export function reportWindows(
  tz: string,
  range: { from: string; to: string },
  now: Date,
): { current: Window; previous: Window; previousRange: { from: string; to: string } } {
  const start = startOfDate(tz, range.from);
  const end = startOfDate(tz, addDays(range.to, 1));
  const prev = previousRange(range.from, range.to);
  const prevStart = startOfDate(tz, prev.from);
  const prevEnd = startOfDate(tz, addDays(prev.to, 1));
  const running = now.getTime() < end.getTime();
  const elapsed = Math.max(0, now.getTime() - start.getTime());
  return {
    current: { from: start, to: running ? new Date(Math.max(start.getTime(), now.getTime())) : end },
    previous: {
      from: prevStart,
      to: running ? new Date(Math.min(prevEnd.getTime(), prevStart.getTime() + elapsed)) : prevEnd,
    },
    previousRange: prev,
  };
}

/** The first day of the bucket a date falls in: itself, the Monday of its ISO week, or the 1st of its month. */
export function bucketOf(date: string, unit: Granularity): string {
  if (unit === "day") return date;
  if (unit === "month") return `${date.slice(0, 8)}01`;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/** Every bucket from the one holding `from` to the one holding `to`. */
export function buckets(from: string, to: string, unit: Granularity): string[] {
  const out: string[] = [];
  for (let b = bucketOf(from, unit); b <= to; ) {
    out.push(b);
    b = unit === "day" ? addDays(b, 1) : unit === "week" ? addDays(b, 7) : addMonths(b, 1);
  }
  return out;
}

export interface BucketFigures {
  bucket: string;
  orders: number;
  revenue: number;
}

/**
 * The chart: every bucket of the period with its figures (zero when nothing sold), and the period
 * before laid next to it bucket by bucket (the first day before against the first day now).
 */
export function alignSeries(
  current: readonly BucketFigures[],
  previous: readonly BucketFigures[] | null,
  range: { from: string; to: string },
  prevRange: { from: string; to: string },
  unit: Granularity,
): {
  bucket: string;
  orders: number;
  revenue: number;
  previousOrders: number | null;
  previousRevenue: number | null;
}[] {
  const now = new Map(current.map((r) => [r.bucket, r]));
  const before = new Map((previous ?? []).map((r) => [r.bucket, r]));
  const prevBuckets = buckets(prevRange.from, prevRange.to, unit);
  return buckets(range.from, range.to, unit).map((bucket, i) => {
    const p = prevBuckets[i];
    return {
      bucket,
      orders: now.get(bucket)?.orders ?? 0,
      revenue: now.get(bucket)?.revenue ?? 0,
      previousOrders: previous ? (p ? (before.get(p)?.orders ?? 0) : null) : null,
      previousRevenue: previous ? (p ? (before.get(p)?.revenue ?? 0) : null) : null,
    };
  });
}

/** Share of paid orders that were cancelled, in percent with one decimal; null without paid orders. */
export function cancellationRate(c: { paid: number; cancelled: number }): number | null {
  return c.paid > 0 ? Math.round((c.cancelled / c.paid) * 1000) / 10 : null;
}

export function averageOrderValue(s: { orders: number; revenue: number }): number {
  return s.orders > 0 ? Math.round(s.revenue / s.orders) : 0;
}

/** Share of the whole, in percent with one decimal. */
export function share(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}
