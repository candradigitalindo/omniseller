import { localDate, startOfDate } from "../../common/time-zone";
import type { OrderRuleActions, OrderRuleConditions, OrderRulePrint, WeekSchedule } from "../../db/schema";
import { addDays, hoursOn, minutesOf, SEARCH_DAYS, sameCourier } from "../campaign/cutoff-plan";

/**
 * Automatic order processing (PRD FR-ORD-19, backend doc 8.37) as pure rules: whether a rule fits a new
 * order, which rule acts, when the business is open, and what a rule must do.
 */

/** Rules a business keeps; BigSeller-sized businesses use a handful. */
export const MAX_ORDER_RULES = 50;

/** A new order as the rules see it. */
export interface OrderFacts {
  storeId: string;
  warehouseId: string | null;
  courier: string | null;
  /** SKUs of the open lines: the product's, else the marketplace's. */
  skus: string[];
  /** Open units (ordered less cancelled). */
  units: number;
  total: number;
}

/** The business's opening hours (UI L43): a default week and special periods, in its time zone. */
export interface BusinessHours {
  timezone: string;
  week: WeekSchedule | null;
  periods: { from: string; to: string; schedule: WeekSchedule }[];
}

/** Open at `at` by the business's hours; open whenever it set none. */
export function openAt(hours: BusinessHours | null, at: Date): boolean {
  if (!hours) return true;
  const date = localDate(hours.timezone, at);
  const day = hoursOn(hours, date);
  if (day === undefined) return true;
  if (day === null) return false;
  const open = minutesOf(day.open);
  const close = minutesOf(day.close);
  if (open === null || close === null) return true;
  const minutes = Math.floor((at.getTime() - startOfDate(hours.timezone, date).getTime()) / 60_000);
  return minutes >= open && minutes < close;
}

const sameSku = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

/** Every condition holds; an empty list or a missing value means any. */
export function ruleMatches(c: OrderRuleConditions, o: OrderFacts, open: boolean): boolean {
  if (c.storeIds?.length && !c.storeIds.includes(o.storeId)) return false;
  if (c.warehouseIds?.length && !(o.warehouseId && c.warehouseIds.includes(o.warehouseId))) return false;
  if (c.couriers?.length && !(o.courier && c.couriers.some((x) => sameCourier(x, o.courier!)))) return false;
  if (c.skus?.length && !o.skus.some((s) => c.skus!.some((x) => sameSku(x, s)))) return false;
  if (c.items === "single" && o.units !== 1) return false;
  if (c.items === "multiple" && o.units < 2) return false;
  if (c.minTotal != null && o.total < c.minTotal) return false;
  if (c.maxTotal != null && o.total > c.maxTotal) return false;
  if (c.withinOperatingHours && !open) return false;
  return true;
}

/** The rule that acts: the active one first by priority (then the oldest) whose conditions hold. */
export function firstMatch<
  R extends { id: string; priority: number; active: boolean; conditions: OrderRuleConditions },
>(rules: readonly R[], o: OrderFacts, open: boolean): R | null {
  return (
    [...rules]
      .filter((r) => r.active)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .find((r) => ruleMatches(r.conditions, o, open)) ?? null
  );
}

/** Whether any of these rules asks for the business's hours (read only then). */
export function needsHours(rules: readonly { active: boolean; conditions: OrderRuleConditions }[]): boolean {
  return rules.some((r) => r.active && r.conditions.withinOperatingHours === true);
}

const uniqueText = (list: readonly string[] | undefined) => {
  const out: string[] = [];
  for (const raw of list ?? []) {
    const v = raw.trim().replace(/\s+/g, " ");
    if (v && !out.some((x) => x.toUpperCase() === v.toUpperCase())) out.push(v);
  }
  return out;
};

/** Conditions as stored: every key present, lists without repeats, "any" spelled out. */
export function normalizeConditions(c: OrderRuleConditions): Required<OrderRuleConditions> {
  return {
    storeIds: [...new Set(c.storeIds ?? [])],
    couriers: uniqueText(c.couriers),
    warehouseIds: [...new Set(c.warehouseIds ?? [])],
    skus: uniqueText(c.skus),
    items: c.items ?? "any",
    minTotal: c.minTotal ?? null,
    maxTotal: c.maxTotal ?? null,
    withinOperatingHours: c.withinOperatingHours ?? false,
  };
}

/** A time of day as rules keep it: "13:00". */
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Actions as stored: every key present. Arranging accepts on the way, so it implies accepting. A print
 * instruction and a time are kept even without an arrange, so `actionsProblem` can name them.
 */
export type NormalizedActions = Omit<Required<OrderRuleActions>, "print"> & { print: Required<OrderRulePrint> | null };

export function normalizeActions(a: OrderRuleActions): NormalizedActions {
  const arrange = a.arrange ?? null;
  return {
    warehouseId: a.warehouseId ?? null,
    tagIds: [...new Set(a.tagIds ?? [])],
    accept: arrange !== null || a.accept === true,
    arrange,
    arrangeAt: a.arrangeAt ?? null,
    print: a.print
      ? {
          deviceId: a.print.deviceId,
          format: a.print.format ?? "thermal",
          template: a.print.template ?? "standard",
          packingList: a.print.packingList ?? false,
        }
      : null,
  };
}

/** Why a rule's actions cannot be saved, and which field says so; null when they can. */
export function actionsProblem(a: OrderRuleActions): { path: string; message: string } | null {
  const does = !!a.warehouseId || (a.tagIds?.length ?? 0) > 0 || !!a.accept || !!a.arrange;
  if (!does) return { path: "actions", message: "Pilih paling sedikit satu tindakan." };
  if (a.arrangeAt != null && !TIME_OF_DAY.test(a.arrangeAt)) {
    return { path: "actions.arrangeAt", message: "Jam ditulis JJ:MM, misalnya 13:00." };
  }
  if (a.arrangeAt != null && !a.arrange) {
    return { path: "actions.arrangeAt", message: "Jam hanya untuk Atur pengiriman." };
  }
  if (a.print && !a.arrange) {
    return {
      path: "actions.print",
      message: "Cetak otomatis butuh Atur pengiriman: label baru ada setelah pengiriman diatur.",
    };
  }
  return null;
}

/** Why a rule's conditions cannot be saved: a total range must run upwards. */
export function conditionsProblem(c: OrderRuleConditions): string | null {
  if (c.minTotal != null && c.maxTotal != null && c.minTotal > c.maxTotal) {
    return "Nilai pesanan terkecil harus di bawah yang terbesar.";
  }
  return null;
}

/**
 * Permissions a rule acts with: whoever saves it must hold them all, as if doing it by hand (the rule
 * then acts as the system). Choosing a warehouse and accepting are `order:accept`, as their buttons.
 */
export function actionPermissions(a: OrderRuleActions): string[] {
  const out = new Set<string>(["order:accept"]);
  if ((a.tagIds?.length ?? 0) > 0) out.add("order:tag");
  if (a.arrange) out.add("shipment:arrange");
  if (a.print) out.add("shipment:print");
  return [...out];
}

/** The steps a rule takes: `schedule` waits for the time of day, `print` is the label's auto print. */
export type AutoAction = "warehouse" | "tags" | "accept" | "arrange" | "schedule" | "print";

/** What the history keeps of one run: the rule, what it did, and what was refused with the reason. */
export interface AutoRunRecord {
  ruleId: string;
  rule: string;
  done: AutoAction[];
  refused: { action: AutoAction; code: string; message: string }[];
  /** ISO 8601: when the arrange request is sent, for a rule with a time of day. */
  arrangeAt?: string;
  /** Why a rule with a time of day arranged at once instead. */
  arrangeNow?: "deadline" | "no_slot";
}

/** An order arriving this long after the rule's time still joins that batch (the scan runs each minute). */
export const SCHEDULE_GRACE_MS = 60_000;
/** The arrange request must go this long before the order's deadline, or it goes at once. */
export const SCHEDULE_MARGIN_MS = 90 * 60_000;

export interface ScheduleInput {
  /** "HH:MM" in the business's time zone. */
  time: string;
  timezone: string;
  /** The business's operating hours; null when it set none (every day, any time). */
  hours: Pick<BusinessHours, "week" | "periods"> | null;
  now: Date;
  /** The order's ship-by deadline (the marketplace's or the courier cut-off), whichever comes first. */
  deadline: Date | null;
}

/**
 * When a rule with a time of day sends the arrange request: the first such moment from now (an order a
 * minute late still joins today's batch) on a day the business is open at that time, provided it comes
 * at least SCHEDULE_MARGIN_MS before the order's deadline. `{ now: "deadline" }` when waiting would miss
 * the deadline, `{ now: "no_slot" }` when no open day is found within SEARCH_DAYS: arrange at once.
 */
export function scheduledArrange(input: ScheduleInput): { at: Date } | { now: "deadline" | "no_slot" } {
  const minutes = minutesOf(input.time);
  if (minutes === null) return { now: "no_slot" };
  const first = localDate(input.timezone, input.now);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const date = addDays(first, i);
    const at = new Date(startOfDate(input.timezone, date).getTime() + minutes * 60_000);
    if (at.getTime() < input.now.getTime() - SCHEDULE_GRACE_MS) continue;
    if (input.hours && !openAt({ timezone: input.timezone, ...input.hours }, at)) continue;
    if (input.deadline && at.getTime() > input.deadline.getTime() - SCHEDULE_MARGIN_MS) return { now: "deadline" };
    return { at };
  }
  return { now: "no_slot" };
}

/** The print instruction a shipment carries for a rule, valid for a while after the arrange. */
export const AUTO_PRINT_VALID_MS = 12 * 3600_000;

export function printIntent(p: Required<OrderRulePrint> | OrderRulePrint, ruleId: string, now: Date) {
  return {
    deviceId: p.deviceId,
    format: p.format ?? "thermal",
    template: p.template ?? "standard",
    packingList: p.packingList ?? false,
    ruleId,
    until: new Date(now.getTime() + AUTO_PRINT_VALID_MS).toISOString(),
  };
}
