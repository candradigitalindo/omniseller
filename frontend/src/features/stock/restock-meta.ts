import type { Tone } from "@/components/common/page";
import type { components, operations } from "@/lib/api/schema";

export type RestockRow = components["schemas"]["RestockListDto_Output"]["items"][number];
export type RestockReason = NonNullable<RestockRow["reason"]>;
export type RestockQuery = NonNullable<operations["InventoryController_restockList"]["parameters"]["query"]>;

/** Sales windows the api counts (backend doc 8.20): the last 7, 14, or 30 days. */
export const WINDOWS = ["7", "14", "30"] as const;
export type RestockWindow = (typeof WINDOWS)[number];

export function windowOf(value: string | null): RestockWindow {
  return WINDOWS.find((w) => w === value) ?? "30";
}

/** The api's defaults: flag stock lasting under 14 days, suggest enough for 30. */
export const DEFAULT_COVER_DAYS = 14;
export const DEFAULT_TARGET_DAYS = 30;
/** Rows per load; the api gives at most 1,000, and the CSV has all of them. */
export const PAGE = 200;
export const MAX_LIMIT = 1000;

/** A day count from the URL: a whole number from 1 to 365, else the default. */
export function dayCount(value: string | null, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : fallback;
}

/** How many rows to ask for after "Muat lebih banyak". */
export function nextLimit(limit: number): number {
  return Math.min(MAX_LIMIT, limit + PAGE);
}

/** Reason pill: out of stock is red, under the minimum or running out soon yellow (8.5). */
export const REASON_TONE: Record<RestockReason, Tone> = {
  out: "danger",
  below_min: "warning",
  low_cover: "warning",
};

/** The color of "cukup untuk": red when nothing is left, yellow under the warning days. */
export function coverTone(row: Pick<RestockRow, "available" | "daysOfCover">, coverDays: number): Tone | null {
  if (row.available <= 0) return "danger";
  if (row.daysOfCover !== null && row.daysOfCover < coverDays) return "warning";
  return null;
}

export function restockQuery(f: {
  window: RestockWindow;
  coverDays: number;
  targetDays: number;
  warehouseId: string | null;
  q: string;
  all: boolean;
}): Omit<RestockQuery, "limit"> {
  return {
    window: f.window,
    coverDays: f.coverDays,
    targetDays: f.targetDays,
    ...(f.warehouseId ? { warehouseId: f.warehouseId } : {}),
    ...(f.q ? { q: f.q } : {}),
    ...(f.all ? { all: "true" } : {}),
  };
}

/** Every row as CSV, with the same filters. */
export function restockExportHref(query: Omit<RestockQuery, "limit">): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  return `/v1/inventory/restock/export?${params}`;
}

/** Units sold per day with at most one decimal: "1,4". */
export function formatRate(rate: number): string {
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 }).format(rate);
}
