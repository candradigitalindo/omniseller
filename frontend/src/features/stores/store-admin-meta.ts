import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";

export type StoreDetail = components["schemas"]["StoreDto_Output"];
export type SyncJob = components["schemas"]["SyncJobPageDto_Output"]["items"][number];
export type SyncStatus = SyncJob["status"];
export type Rule = components["schemas"]["RuleDto_Output"];
export type RuleMode = Rule["mode"];
export type RuleBody = components["schemas"]["CreateRuleDto"];
export type RulePatch = components["schemas"]["UpdateRuleDto"];

/** The tabs of a store's page (L40 "halaman kelola"); a manual sales channel has its settings only. */
export const STORE_TABS = ["koneksi", "gudang", "pengaturan", "log"] as const;
export type StoreTab = (typeof STORE_TABS)[number];

export function storeTabOf(value: string | null, manual: boolean): StoreTab {
  if (manual) return "pengaturan";
  return STORE_TABS.find((t) => t === value) ?? "koneksi";
}

/** Sync log outcomes the filter offers (`GET /v1/stores/{id}/sync-jobs?status=`). */
export const LOG_FILTERS = ["failed", "skipped"] as const;
export type LogFilter = (typeof LOG_FILTERS)[number];

export function logFilterOf(value: string | null): LogFilter | null {
  return LOG_FILTERS.find((f) => f === value) ?? null;
}

export const SYNC_TONE: Record<SyncStatus, Tone> = {
  queued: "neutral",
  running: "info",
  succeeded: "success",
  failed: "danger",
  skipped: "neutral",
};

/** Work against a marketplace that the log names in the seller's words; any other kind shows as written. */
export const SYNC_KINDS = [
  "auth.exchange",
  "auth.refresh",
  "warehouses.pull",
  "webhooks.subscribe",
  "listings.pull",
  "listings.refresh",
  "listings.status_push",
  "orders.pull",
  "orders.refresh",
  "orders.cancel",
  "returns.pull",
  "returns.refresh",
  "returns.details",
  "returns.respond",
  "returns.evidence",
  "returns.cancellations",
  "shipments.arrange",
  "shipments.labels",
  "tracking.pull",
  "stock.push",
  "categories.pull",
  "categories.rules",
  "categories.recommend",
  "brands.search",
  "products.create",
  "products.get",
  "products.image_upload",
  "products.prerequisites",
] as const;
type Underscored<S extends string> = S extends `${infer A}.${infer B}` ? `${A}_${B}` : S;
export type SyncKindKey = Underscored<(typeof SYNC_KINDS)[number]>;

export function syncKindKey(kind: string): SyncKindKey | null {
  const known = SYNC_KINDS.find((k) => k === kind);
  return known ? (known.replace(".", "_") as SyncKindKey) : null;
}

/** How long a job took: "<0,1 dtk", "0,4 dtk", "12 dtk", "2 mnt 5 dtk". */
export function durationText(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 100) return "<0,1 dtk";
  if (ms < 1_000) return `${(ms / 1_000).toFixed(1).replace(".", ",")} dtk`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)} dtk`;
  return `${Math.floor(ms / 60_000)} mnt ${Math.round((ms % 60_000) / 1_000)} dtk`;
}

export interface CallLine {
  method: string;
  path: string;
  status: number | null;
  ms: number | null;
  error: string | null;
}

/** The marketplace calls of a job as the log lists them; the api keeps them redacted. */
export function callsOf(job: Pick<SyncJob, "calls">): CallLine[] {
  return job.calls.map((c) => ({
    method: typeof c.method === "string" ? c.method : "?",
    path: typeof c.path === "string" ? c.path : "?",
    status: typeof c.httpStatus === "number" ? c.httpStatus : null,
    ms: typeof c.durationMs === "number" ? c.durationMs : null,
    error: typeof c.errorCode === "string" ? c.errorCode : null,
  }));
}

/**
 * Work that went through with some listings refused (a stock push, listing status): how many the api
 * kept in `result.failed` (at most 20) and the first reason.
 */
export function partialFailures(job: Pick<SyncJob, "result">): { count: number; reason: string | null } | null {
  const failed = job.result?.failed;
  if (!Array.isArray(failed) || failed.length === 0) return null;
  const first: unknown = failed[0];
  const reason =
    first && typeof first === "object" && "error" in first && typeof first.error === "string" ? first.error : null;
  return { count: failed.length, reason };
}

/** What a rule covers: the whole store, one marketplace warehouse, one variant, or both. */
export type RuleScope = "store" | "warehouse" | "variant" | "both";

export function ruleScope(r: Pick<Rule, "channelWarehouseId" | "variantId">): RuleScope {
  if (r.channelWarehouseId && r.variantId) return "both";
  if (r.channelWarehouseId) return "warehouse";
  return r.variantId ? "variant" : "store";
}

/**
 * What a marketplace location shows of `available` under a rule (backend `allocate`): never below zero,
 * the buffer comes off first, a percentage rounds down, a fixed amount is never more than there is.
 */
export function allocatePreview(available: number, rule: Pick<Rule, "mode" | "value" | "buffer"> | null): number {
  let qty = Math.max(available, 0);
  if (!rule) return qty;
  qty = Math.max(qty - rule.buffer, 0);
  if (rule.mode === "percent") return Math.floor((qty * rule.value) / 100);
  if (rule.mode === "fixed") return Math.min(rule.value, qty);
  return qty;
}

/** A rule as typed in its dialog. */
export interface RuleDraft {
  channelWarehouseId: string | null;
  variantId: string | null;
  mode: RuleMode;
  value: string;
  buffer: string;
  priority: string;
  active: boolean;
}

export function ruleDraftOf(rule: Rule | null): RuleDraft {
  if (!rule) {
    return {
      channelWarehouseId: null,
      variantId: null,
      mode: "percent",
      value: "",
      buffer: "0",
      priority: "100",
      active: true,
    };
  }
  return {
    channelWarehouseId: rule.channelWarehouseId,
    variantId: rule.variantId,
    mode: rule.mode,
    value: rule.mode === "all" ? "" : String(rule.value),
    buffer: String(rule.buffer),
    priority: String(rule.priority),
    active: rule.active,
  };
}

const WHOLE = /^\d+$/;
const MAX_QTY = 10_000_000;
type Problem = "required" | "wholeNumber" | "percentMax" | "tooLarge" | "priorityRange";

/** What is wrong with a draft: whole numbers, a percentage up to 100, a priority from 0 to 1,000. */
export function ruleProblems(d: RuleDraft): Partial<Record<"value" | "buffer" | "priority", Problem>> {
  const out: Partial<Record<"value" | "buffer" | "priority", Problem>> = {};
  const value = d.value.trim();
  if (d.mode !== "all") {
    if (value === "") out.value = "required";
    else if (!WHOLE.test(value)) out.value = "wholeNumber";
    else if (d.mode === "percent" && Number(value) > 100) out.value = "percentMax";
    else if (Number(value) > MAX_QTY) out.value = "tooLarge";
  }
  const buffer = d.buffer.trim();
  if (buffer !== "" && !WHOLE.test(buffer)) out.buffer = "wholeNumber";
  else if (Number(buffer) > MAX_QTY) out.buffer = "tooLarge";
  const priority = d.priority.trim();
  if (priority !== "" && (!WHOLE.test(priority) || Number(priority) > 1_000)) out.priority = "priorityRange";
  return out;
}

const numberOr = (text: string, fallback: number) => (text.trim() === "" ? fallback : Number(text.trim()));

/** `POST /v1/stock-allocation-rules` from a checked draft: empty buffer 0, empty priority 100. */
export function ruleBody(storeId: string, d: RuleDraft): RuleBody {
  return {
    storeId,
    channelWarehouseId: d.channelWarehouseId,
    variantId: d.variantId,
    mode: d.mode,
    ...(d.mode === "all" ? {} : { value: Number(d.value.trim()) }),
    buffer: numberOr(d.buffer, 0),
    priority: numberOr(d.priority, 100),
    active: d.active,
  };
}

/** `PATCH` of a rule: only what changed. What a rule covers does not change; it is a new rule. */
export function rulePatch(rule: Rule, d: RuleDraft): RulePatch | null {
  const patch: RulePatch = {};
  if (d.mode !== rule.mode) patch.mode = d.mode;
  if (d.mode !== "all") {
    const value = Number(d.value.trim());
    if (value !== rule.value || d.mode !== rule.mode) patch.value = value;
  }
  const buffer = numberOr(d.buffer, 0);
  if (buffer !== rule.buffer) patch.buffer = buffer;
  const priority = numberOr(d.priority, 100);
  if (priority !== rule.priority) patch.priority = priority;
  if (d.active !== rule.active) patch.active = d.active;
  return Object.keys(patch).length > 0 ? patch : null;
}
