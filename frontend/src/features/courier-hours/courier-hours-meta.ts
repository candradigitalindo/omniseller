import type { components } from "@/lib/api/schema";

/** Kurir & Jam Operasional (UI L43, backend doc 8.31): cut-offs, courier holidays, operating hours. */

export type Cutoff = components["schemas"]["CutoffDto_Output"];
export type Holiday = components["schemas"]["HolidayDto_Output"];
export type Hours = components["schemas"]["HoursDto_Output"];
export type Period = Hours["periods"][number];
export type DayHours = { open: string; close: string } | null;
export type Week = DayHours[];

export const TABS = ["cutoff", "libur", "jam"] as const;
export type Tab = (typeof TABS)[number];

/** Days as people list them in Indonesia, Monday first; the api counts 0 = Sunday. */
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const DAY_SHORT = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"] as const;
export const DAY_LONG = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"] as const;

/** "Setiap hari", "Sen–Sab", or "Sen, Rab, Jum": days in a row as a range, others listed. */
export function daysLabel(days: readonly number[], everyDay: string): string {
  const set = new Set(days);
  if (set.size === 7) return everyDay;
  const ordered = DAY_ORDER.filter((d) => set.has(d));
  const positions = ordered.map((d) => DAY_ORDER.indexOf(d));
  const consecutive = positions.every((p, i) => i === 0 || p === positions[i - 1]! + 1);
  if (ordered.length >= 3 && consecutive) return `${DAY_SHORT[ordered[0]!]}–${DAY_SHORT[ordered.at(-1)!]}`;
  return ordered.map((d) => DAY_SHORT[d]).join(", ");
}

/** "15:00" as Indonesians write it: "15.00". */
export function clock(time: string): string {
  return time.slice(0, 5).replace(":", ".");
}

/** A week to start from: Monday to Friday 08:00–17:00, Saturday until 14:00, Sunday closed. */
export const DEFAULT_WEEK: Week = [
  null,
  { open: "08:00", close: "17:00" },
  { open: "08:00", close: "17:00" },
  { open: "08:00", close: "17:00" },
  { open: "08:00", close: "17:00" },
  { open: "08:00", close: "17:00" },
  { open: "08:00", close: "14:00" },
];

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** The first day of a week that is not right, by its index (0 = Sunday), and why. */
export function weekProblem(week: Week): { day: number; key: "timeFormatDay" | "closeBeforeOpen" } | null {
  for (const day of DAY_ORDER) {
    const h = week[day];
    if (!h) continue;
    if (!TIME.test(h.open) || !TIME.test(h.close)) return { day, key: "timeFormatDay" };
    if (h.close <= h.open) return { day, key: "closeBeforeOpen" };
  }
  return null;
}

/** "08.00–17.00 Sen–Jum, 08.00–14.00 Sab": a week in one line, closed days left out. */
export function weekSummary(week: Week, closedAll: string): string {
  const groups = new Map<string, number[]>();
  for (const day of DAY_ORDER) {
    const h = week[day];
    if (!h) continue;
    const key = `${clock(h.open)}–${clock(h.close)}`;
    groups.set(key, [...(groups.get(key) ?? []), day]);
  }
  if (groups.size === 0) return closedAll;
  return [...groups].map(([hours, days]) => `${hours} ${daysLabel(days, "setiap hari")}`).join(", ");
}

export interface CutoffDraft {
  warehouseId: string;
  courier: string;
  cutoffTime: string;
  days: number[];
}

export type CutoffProblem = "warehouseRequired" | "courierRequired" | "timeFormat" | "daysRequired";

export function cutoffProblems(d: CutoffDraft): Partial<Record<keyof CutoffDraft, CutoffProblem>> {
  const out: Partial<Record<keyof CutoffDraft, CutoffProblem>> = {};
  if (!d.warehouseId) out.warehouseId = "warehouseRequired";
  if (!d.courier.trim()) out.courier = "courierRequired";
  if (!TIME.test(d.cutoffTime)) out.cutoffTime = "timeFormat";
  if (d.days.length === 0) out.days = "daysRequired";
  return out;
}
