import { localDate, startOfDate } from "../../common/time-zone";
import type { DayHours, WeekSchedule } from "../../db/schema";

/**
 * Courier cut-offs, courier holidays, and operating hours as rules (PRD FR-CMP-05, 06; UI L43; backend
 * doc 8.31). Dates are calendar dates (YYYY-MM-DD) and times "HH:MM" in the business's time zone; weeks
 * start on Sunday (0). Pure functions.
 */

/** How far ahead the next cut-off is looked for: a courier that never comes leaves no deadline. */
export const SEARCH_DAYS = 31;
/** Under this much time to the cut-off an order is shown yellow (UI L03). */
export const CUTOFF_WARNING_MS = 2 * 3600_000;

const TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])(?::[0-5][0-9])?$/;

/** Minutes after midnight of "HH:MM" or "HH:MM:SS" (PostgreSQL `time`); null when it is not a time. */
export function minutesOf(time: string): number | null {
  const m = TIME.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** "15:00:00" as "15:00". */
export function hhmm(time: string): string {
  return time.slice(0, 5);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 for Sunday to 6 for Saturday, from the calendar date alone. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Courier names compared as handovers compare them: letters and digits only, any case. */
export function courierKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** One name starts the other: "J&T" and "J&T Express" are one courier, "J&T Cargo" and "J&T Express" are not. */
export function sameCourier(a: string, b: string): boolean {
  const x = courierKey(a);
  const y = courierKey(b);
  return x !== "" && y !== "" && (x.startsWith(y) || y.startsWith(x));
}

/**
 * The cut-off that applies to an order's courier: the most specific configured name that matches ("JNE
 * YES" over "JNE"). None for an order whose courier is not known yet.
 */
export function cutoffFor<T extends { courier: string }>(cutoffs: readonly T[], courier: string | null): T | null {
  if (!courier) return null;
  const found = cutoffs.filter((c) => sameCourier(c.courier, courier));
  return found.sort((a, b) => courierKey(b.courier).length - courierKey(a.courier).length)[0] ?? null;
}

/** A week is seven days, each closed (null) or open before it closes. */
export function weekProblem(week: readonly DayHours[]): string | null {
  if (week.length !== 7) return "week";
  for (const day of week) {
    if (day === null) continue;
    const open = minutesOf(day.open);
    const close = minutesOf(day.close);
    if (open === null || close === null) return "time";
    if (close <= open) return "closeBeforeOpen";
  }
  return null;
}

export interface CourierCalendarInput {
  timezone: string;
  /** Active cut-offs of every warehouse. */
  cutoffs: { warehouseId: string; courier: string; time: string; days: readonly number[] }[];
  holidays: { date: string; courier: string | null }[];
  /** The default week, if the business set one. */
  week: WeekSchedule | null;
  /** Special periods (Ramadan): they replace the default week on their dates. */
  periods: { from: string; to: string; schedule: WeekSchedule }[];
}

/** The hours of a date: a special period's, else the default week's; undefined when nothing is set. */
export function hoursOn(input: Pick<CourierCalendarInput, "week" | "periods">, date: string): DayHours | undefined {
  const period = input.periods.find((p) => p.from <= date && date <= p.to);
  const week = period?.schedule ?? input.week;
  return week ? (week[weekdayOf(date)] ?? null) : undefined;
}

/**
 * The internal deadline of an order to ship (FR-CMP-05, 06): the first cut-off of its courier at its
 * warehouse at or after the moment it became the seller's to process, on a day the courier comes, that
 * is not the courier's holiday, and when the business is open; on a day the business closes before the
 * cut-off, its closing time, since nobody hands parcels over after it. Null when no cut-off applies, or
 * none falls in the next SEARCH_DAYS days.
 */
export function internalDeadline(
  input: CourierCalendarInput,
  order: { warehouseId: string | null; courier: string | null; readyAt: Date },
): { at: Date; courier: string } | null {
  if (!order.warehouseId) return null;
  const cutoff = cutoffFor(
    input.cutoffs.filter((c) => c.warehouseId === order.warehouseId),
    order.courier,
  );
  const cutoffMinutes = cutoff ? minutesOf(cutoff.time) : null;
  if (!cutoff || cutoffMinutes === null) return null;
  const first = localDate(input.timezone, order.readyAt);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const date = addDays(first, i);
    if (!cutoff.days.includes(weekdayOf(date))) continue;
    const holiday = input.holidays.some(
      (h) => h.date === date && (h.courier === null || sameCourier(h.courier, cutoff.courier)),
    );
    if (holiday) continue;
    const hours = hoursOn(input, date);
    if (hours === null) continue;
    const close = hours ? minutesOf(hours.close) : null;
    const minutes = close !== null ? Math.min(cutoffMinutes, close) : cutoffMinutes;
    const at = new Date(startOfDate(input.timezone, date).getTime() + minutes * 60_000);
    if (at.getTime() >= order.readyAt.getTime()) return { at, courier: cutoff.courier };
  }
  return null;
}

export type InternalSlaState = "ok" | "warning" | "missed";

/** How an order to ship stands against its internal deadline: missed once the cut-off passed. */
export function internalSlaOf(
  deadline: Date | null,
  toShip: boolean,
  now = new Date(),
): { state: InternalSlaState; remainingMs: number } | null {
  if (!deadline || !toShip) return null;
  const remainingMs = deadline.getTime() - now.getTime();
  return {
    state: remainingMs <= 0 ? "missed" : remainingMs <= CUTOFF_WARNING_MS ? "warning" : "ok",
    remainingMs,
  };
}
