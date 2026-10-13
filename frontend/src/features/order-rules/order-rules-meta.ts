import type { components } from "@/lib/api/schema";

export type OrderRule = components["schemas"]["OrderRuleDto_Output"];
export type RuleBody = components["schemas"]["CreateOrderRuleDto"];
export type ItemsKind = OrderRule["conditions"]["items"];

/** What a rule does with an accepted order: nothing more, accept it, or accept and arrange the shipment. */
export const PROCESS = ["none", "accept", "pickup", "dropoff"] as const;
export type Process = (typeof PROCESS)[number];
export const ITEMS: readonly ItemsKind[] = ["any", "single", "multiple"];

/** The order is left in the warehouse it was given (a Select value cannot be empty). */
export const KEEP_WAREHOUSE = "keep";
/** No automatic print (a Select value cannot be empty). */
export const NO_PRINT = "none";
export const PRINT_FORMATS = ["thermal", "a4"] as const;
export const PRINT_TEMPLATES = ["standard", "custom"] as const;
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
/** "13:00" as it is read: "13.00". */
export const clockText = (time: string) => time.replace(":", ".");

/** The editor (L55) as typed: lists of names as text, totals as rupiah text. */
export interface RuleDraft {
  name: string;
  active: boolean;
  storeIds: string[];
  couriers: string;
  warehouseIds: string[];
  skus: string;
  items: ItemsKind;
  minTotal: string;
  maxTotal: string;
  withinOperatingHours: boolean;
  warehouseId: string;
  tagIds: string[];
  process: Process;
  /** "HH:MM" when the arrange request waits for that time of day; "" for at once. */
  arrangeAt: string;
  /** The agent that prints the label when it is ready; "" for no automatic print. */
  printDeviceId: string;
  printFormat: (typeof PRINT_FORMATS)[number];
  printTemplate: (typeof PRINT_TEMPLATES)[number];
  printPackingList: boolean;
}

export type DraftProblem = "name" | "money" | "range" | "nothing" | "time";

export function emptyDraft(): RuleDraft {
  return {
    name: "",
    active: true,
    storeIds: [],
    couriers: "",
    warehouseIds: [],
    skus: "",
    items: "any",
    minTotal: "",
    maxTotal: "",
    withinOperatingHours: false,
    warehouseId: KEEP_WAREHOUSE,
    tagIds: [],
    process: "none",
    arrangeAt: "",
    printDeviceId: "",
    printFormat: "thermal",
    printTemplate: "standard",
    printPackingList: false,
  };
}

const processOf = (a: OrderRule["actions"]): Process => a.arrange ?? (a.accept ? "accept" : "none");

export function draftOf(r: OrderRule): RuleDraft {
  return {
    name: r.name,
    active: r.active,
    storeIds: r.conditions.storeIds,
    couriers: r.conditions.couriers.join(", "),
    warehouseIds: r.conditions.warehouseIds,
    skus: r.conditions.skus.join(", "),
    items: r.conditions.items,
    minTotal: r.conditions.minTotal === null ? "" : String(r.conditions.minTotal),
    maxTotal: r.conditions.maxTotal === null ? "" : String(r.conditions.maxTotal),
    withinOperatingHours: r.conditions.withinOperatingHours,
    warehouseId: r.actions.warehouseId ?? KEEP_WAREHOUSE,
    tagIds: r.actions.tagIds,
    process: processOf(r.actions),
    arrangeAt: r.actions.arrangeAt ?? "",
    printDeviceId: r.actions.print?.deviceId ?? "",
    printFormat: r.actions.print?.format ?? "thermal",
    printTemplate: r.actions.print?.template ?? "standard",
    printPackingList: r.actions.print?.packingList ?? false,
  };
}

/** Whether the draft arranges the shipment (the time and the print belong to that step). */
export const arranges = (d: Pick<RuleDraft, "process">) => d.process === "pickup" || d.process === "dropoff";

/** "J&T, SiCepat" or one per line: the names, trimmed, without empty ones. */
export function splitList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "Rp 150.000" or "150000" as 150000; null when empty; NaN when it is not a whole rupiah amount. */
export function rupiahValue(text: string): number | null {
  const v = text.replace(/^\s*rp\.?/i, "").replace(/[\s.]/g, "");
  if (v === "") return null;
  return /^\d{1,13}$/.test(v) ? Number(v) : Number.NaN;
}

/** What keeps the draft from being saved, per field. */
export function draftProblems(
  d: RuleDraft,
): Partial<Record<"name" | "minTotal" | "maxTotal" | "actions" | "arrangeAt", DraftProblem>> {
  const out: Partial<Record<"name" | "minTotal" | "maxTotal" | "actions" | "arrangeAt", DraftProblem>> = {};
  if (!d.name.trim()) out.name = "name";
  const min = rupiahValue(d.minTotal);
  const max = rupiahValue(d.maxTotal);
  if (Number.isNaN(min)) out.minTotal = "money";
  if (Number.isNaN(max)) out.maxTotal = "money";
  if (min !== null && max !== null && !Number.isNaN(min) && !Number.isNaN(max) && min > max) out.maxTotal = "range";
  if (d.warehouseId === KEEP_WAREHOUSE && d.tagIds.length === 0 && d.process === "none") out.actions = "nothing";
  if (arranges(d) && d.arrangeAt !== "" && !TIME_OF_DAY.test(d.arrangeAt)) out.arrangeAt = "time";
  return out;
}

/** The request body of a draft that has no problems. */
export function ruleBody(d: RuleDraft): RuleBody {
  return {
    name: d.name.trim(),
    active: d.active,
    conditions: {
      storeIds: d.storeIds,
      couriers: splitList(d.couriers),
      warehouseIds: d.warehouseIds,
      skus: splitList(d.skus),
      items: d.items,
      minTotal: rupiahValue(d.minTotal),
      maxTotal: rupiahValue(d.maxTotal),
      withinOperatingHours: d.withinOperatingHours,
    },
    actions: {
      warehouseId: d.warehouseId === KEEP_WAREHOUSE ? null : d.warehouseId,
      tagIds: d.tagIds,
      accept: d.process !== "none",
      arrange: d.process === "pickup" || d.process === "dropoff" ? d.process : null,
      // the time and the print go with the arrange: without one they are dropped, not refused
      arrangeAt: arranges(d) && d.arrangeAt !== "" ? d.arrangeAt : null,
      print:
        arranges(d) && d.printDeviceId !== ""
          ? {
              deviceId: d.printDeviceId,
              format: d.printFormat,
              template: d.printTemplate,
              packingList: d.printPackingList,
            }
          : null,
    },
  };
}

/** The editor's field an api error path points at: `conditions.storeIds.0` is the stores' list. */
export function fieldOfPath(path: string): string {
  const [first, second] = path.split(".");
  return (first === "conditions" || first === "actions") && second ? second : (first ?? path);
}

/** The rules' ids with the one at `index` moved by `delta` places (the arrows of L55). */
export function moved(ids: readonly string[], index: number, delta: -1 | 1): string[] {
  const to = index + delta;
  if (index < 0 || index >= ids.length || to < 0 || to >= ids.length) return [...ids];
  const out = [...ids];
  [out[index], out[to]] = [out[to]!, out[index]!];
  return out;
}

/** Phrases of a rule's sentence on L55, under `orderRules.*`. */
export type WhenKey =
  | "when_stores"
  | "when_couriers"
  | "when_warehouses"
  | "when_skus"
  | `when_items_${Exclude<ItemsKind, "any">}`
  | "when_between"
  | "when_min"
  | "when_max"
  | "when_hours";
export type DoKey =
  | "do_warehouse"
  | "do_tags"
  | `do_${Exclude<Process, "none">}`
  | "do_pickup_at"
  | "do_dropoff_at"
  | "do_print";
export type Part<K> = { key: K; values: Record<string, string | number> };

export interface Names {
  store: (id: string) => string | undefined;
  warehouse: (id: string) => string | undefined;
  tag: (id: string) => string | undefined;
  agent: (id: string) => string | undefined;
}

/**
 * A rule's conditions as short phrases, each with its key in `orderRules.when_*`; empty when it takes every
 * new order. Things deleted since are left out.
 */
export function conditionParts(c: OrderRule["conditions"], names: Names): Part<WhenKey>[] {
  const known = (ids: string[], name: (id: string) => string | undefined) =>
    ids.map(name).filter((n): n is string => !!n);
  const out: Part<WhenKey>[] = [];
  const stores = known(c.storeIds, names.store);
  if (c.storeIds.length > 0) out.push({ key: "when_stores", values: { names: stores.join(", ") || "—" } });
  if (c.couriers.length > 0) out.push({ key: "when_couriers", values: { names: c.couriers.join(", ") } });
  const warehouses = known(c.warehouseIds, names.warehouse);
  if (c.warehouseIds.length > 0) out.push({ key: "when_warehouses", values: { names: warehouses.join(", ") || "—" } });
  if (c.skus.length > 0) out.push({ key: "when_skus", values: { skus: c.skus.join(", ") } });
  if (c.items !== "any") out.push({ key: `when_items_${c.items}`, values: {} });
  if (c.minTotal !== null && c.maxTotal !== null) {
    out.push({ key: "when_between", values: { min: c.minTotal, max: c.maxTotal } });
  } else if (c.minTotal !== null) out.push({ key: "when_min", values: { min: c.minTotal } });
  else if (c.maxTotal !== null) out.push({ key: "when_max", values: { max: c.maxTotal } });
  if (c.withinOperatingHours) out.push({ key: "when_hours", values: {} });
  return out;
}

/** A rule's actions as short phrases in the order they run, each with its key in `orderRules.do_*`. */
export function actionParts(a: OrderRule["actions"], names: Names): Part<DoKey>[] {
  const out: Part<DoKey>[] = [];
  if (a.warehouseId) out.push({ key: "do_warehouse", values: { name: names.warehouse(a.warehouseId) ?? "—" } });
  const tags = a.tagIds.map(names.tag).filter((n): n is string => !!n);
  if (a.tagIds.length > 0) out.push({ key: "do_tags", values: { names: tags.join(", ") || "—" } });
  const process = processOf(a);
  if ((process === "pickup" || process === "dropoff") && a.arrangeAt) {
    out.push({ key: `do_${process}_at`, values: { time: clockText(a.arrangeAt) } });
  } else if (process !== "none") out.push({ key: `do_${process}`, values: {} });
  if (a.print) out.push({ key: "do_print", values: { agent: names.agent(a.print.deviceId) ?? "—" } });
  return out;
}
