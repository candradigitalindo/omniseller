import { localDate, startOfDate } from "../../common/time-zone";
import type { OrderRuleActions, OrderRuleConditions, WeekSchedule } from "../../db/schema";
import { hoursOn, minutesOf, sameCourier } from "../campaign/cutoff-plan";

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

/** Actions as stored: every key present. Arranging accepts on the way, so it implies accepting. */
export function normalizeActions(a: OrderRuleActions): Required<OrderRuleActions> {
  const arrange = a.arrange ?? null;
  return {
    warehouseId: a.warehouseId ?? null,
    tagIds: [...new Set(a.tagIds ?? [])],
    accept: arrange !== null || a.accept === true,
    arrange,
  };
}

/** Why a rule's actions cannot be saved: it must do something. */
export function actionsProblem(a: OrderRuleActions): string | null {
  const does = !!a.warehouseId || (a.tagIds?.length ?? 0) > 0 || !!a.accept || !!a.arrange;
  return does ? null : "Pilih paling sedikit satu tindakan.";
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
  return [...out];
}

export type AutoAction = "warehouse" | "tags" | "accept" | "arrange";

/** What the history keeps of one run: the rule, what it did, and what was refused with the reason. */
export interface AutoRunRecord {
  ruleId: string;
  rule: string;
  done: AutoAction[];
  refused: { action: AutoAction; code: string; message: string }[];
}
