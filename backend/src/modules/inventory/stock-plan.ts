import type { StockUpdate } from "@omniseller/connector-core";

/**
 * What the stock pusher sends (backend doc 9.4, PRD FR-STK-02, 03, 04, FR-WHS-04, 05, FR-MFS-02).
 * Pure functions: the service loads the data, these decide, the service calls the marketplaces.
 */

export type RuleMode = "all" | "percent" | "fixed";

/** A stock_allocation_rule row. `null` scope fields mean "every channel warehouse / every variant". */
export interface AllocationRule {
  id: string;
  storeId: string;
  channelWarehouseId: string | null;
  variantId: string | null;
  mode: RuleMode;
  value: number;
  buffer: number;
  priority: number;
  active: boolean;
}

/** Listing statuses the marketplaces accept stock for; banned and deleted items refuse edits. */
export const PUSHABLE_STATUSES: ReadonlySet<string> = new Set(["active", "inactive", "reviewing"]);

export interface PlanListing {
  id: string;
  storeId: string;
  variantId: string;
  externalItemId: string;
  externalVariantId: string;
  status: string;
  /** Stock locations the listing reported at its last pull (keys of channel_data.stockByWarehouse). */
  stockKeys: string[];
}

export interface PlanChannelWarehouse {
  id: string;
  externalId: string;
  kind: "seller" | "fulfillment";
  /** The OmniSeller warehouse it is mapped to; null while unmapped and for marketplace-managed ones. */
  warehouseId: string | null;
  active: boolean;
  isDefault: boolean;
}

export interface PlanStore {
  id: string;
  /** Connection works: active or token_expiring. */
  usable: boolean;
  /** sync_mode = 'live'. Read-only stores are never pushed to (FR-MIG-05). */
  live: boolean;
  /** Largest quantity the marketplace accepts per warehouse (connector manifest). */
  maxStockQuantity: number | null;
  warehouses: PlanChannelWarehouse[];
}

export interface PlanStock {
  /** on_hand - reserved - buffer; negative means oversold. */
  available: number;
  /** stock_set_at is set: a person established this quantity at least once. */
  established: boolean;
}

export interface PlanState {
  listingId: string;
  channelWarehouseId: string;
  lastPushedQty: number | null;
  lastError: string | null;
}

export type SkipReason =
  /** read-only, not connected, or a seller warehouse is still unmapped (FR-WHS-04) */
  | "store_paused"
  /** banned, deleted, or unknown at the marketplace */
  | "not_pushable"
  /** the variant's stock in a warehouse it would draw from was never established */
  | "stock_not_set"
  /** all of the listing's stock sits in marketplace-managed warehouses (FR-MFS-02) */
  | "marketplace_managed"
  /** the listing stocks a location OmniSeller does not know yet; the warehouse sync will add it */
  | "unknown_warehouse";

export interface PlannedPush {
  kind: "push";
  listing: PlanListing;
  update: StockUpdate;
  /** Quantity per channel warehouse, recorded in listing_stock_state once the marketplace answers. */
  targets: { channelWarehouseId: string; quantity: number }[];
}

export type PlanOutcome =
  | PlannedPush
  | { kind: "unchanged"; listing: PlanListing }
  | { kind: "skip"; listing: PlanListing; reason: SkipReason };

export function stockKey(variantId: string, warehouseId: string): string {
  return `${variantId}|${warehouseId}`;
}

const specificity = (r: AllocationRule) => (r.channelWarehouseId ? 1 : 0) + (r.variantId ? 1 : 0);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Negative when `a` wins over `b`. */
function ruleOrder(a: AllocationRule, b: AllocationRule): number {
  return (
    specificity(b) - specificity(a) ||
    a.priority - b.priority ||
    Number(!!b.variantId) - Number(!!a.variantId) ||
    byId(a.id, b.id)
  );
}

/**
 * The rule for one listing location: the most specific active rule of the store wins (warehouse and
 * variant, then either one, then store-wide); a tie goes to the smallest priority, then to the rule for
 * the variant.
 */
export function resolveRule(
  rules: readonly AllocationRule[],
  storeId: string,
  channelWarehouseId: string,
  variantId: string,
): AllocationRule | null {
  let best: AllocationRule | null = null;
  for (const r of rules) {
    if (!r.active || r.storeId !== storeId) continue;
    if (r.channelWarehouseId !== null && r.channelWarehouseId !== channelWarehouseId) continue;
    if (r.variantId !== null && r.variantId !== variantId) continue;
    if (!best || ruleOrder(r, best) < 0) best = r;
  }
  return best;
}

/**
 * Quantity shown on a marketplace location: never negative, never more than is available. The rule's
 * buffer comes off first; a percentage rounds down; a fixed amount is capped by what is available.
 */
export function allocate(available: number, rule: AllocationRule | null, max: number | null = null): number {
  let qty = Math.max(available, 0);
  if (rule) {
    qty = Math.max(qty - rule.buffer, 0);
    if (rule.mode === "percent") qty = Math.floor((qty * rule.value) / 100);
    else if (rule.mode === "fixed") qty = Math.min(rule.value, qty);
  }
  return max === null ? qty : Math.min(qty, max);
}

/** No push at all: not connected, read-only, or a seller warehouse without mapping (FR-WHS-04). */
export function storePaused(store: PlanStore): boolean {
  return (
    !store.usable || !store.live || store.warehouses.some((w) => w.active && w.kind === "seller" && !w.warehouseId)
  );
}

interface PlanInput {
  listings: readonly PlanListing[];
  stores: ReadonlyMap<string, PlanStore>;
  /** keyed by stockKey(variantId, warehouseId) */
  stock: ReadonlyMap<string, PlanStock>;
  rules: readonly AllocationRule[];
  states: readonly PlanState[];
}

/**
 * One outcome per listing. A listing is pushed as a whole: every seller location it stocks, because
 * TikTok Shop refuses a request that leaves a warehouse out, and Shopee refuses a change of the item's
 * location structure. A location is the listing's own stock key, mapped to a channel warehouse by id or,
 * for a shop with a single seller warehouse, to that one.
 *
 * Several locations of one listing that draw from the same OmniSeller warehouse would show the same
 * physical stock twice to buyers, so the primary one (the marketplace default, then the oldest) gets the
 * allocation and the others 0. Different stores each get the full allocation, as every multichannel tool
 * does; the push latency keeps that safe.
 */
export function planStockPush(input: PlanInput): PlanOutcome[] {
  const stateOf = new Map(input.states.map((s) => [`${s.listingId}|${s.channelWarehouseId}`, s]));
  return input.listings.map((listing) => planListing(listing, input, stateOf));
}

function planListing(listing: PlanListing, input: PlanInput, stateOf: Map<string, PlanState>): PlanOutcome {
  const skip = (reason: SkipReason): PlanOutcome => ({ kind: "skip", listing, reason });
  const store = input.stores.get(listing.storeId);
  if (!store || storePaused(store)) return skip("store_paused");
  if (!PUSHABLE_STATUSES.has(listing.status)) return skip("not_pushable");

  const byExternal = new Map(store.warehouses.map((w) => [w.externalId, w]));
  const sellers = store.warehouses.filter((w) => w.active && w.kind === "seller");
  const sellerKeys = listing.stockKeys.filter((k) => byExternal.get(k)?.kind !== "fulfillment");
  if (listing.stockKeys.length > 0 && sellerKeys.length === 0) return skip("marketplace_managed");
  const keys = sellerKeys.length > 0 ? sellerKeys : sellers.map((w) => w.externalId);
  if (keys.length === 0) return skip("unknown_warehouse");

  const located: { key: string; cw: PlanChannelWarehouse }[] = [];
  for (const key of keys) {
    const known = byExternal.get(key);
    const cw = known ? (known.active ? known : undefined) : sellers.length === 1 ? sellers[0] : undefined;
    if (!cw?.warehouseId) return skip("unknown_warehouse");
    located.push({ key, cw });
  }

  const byWarehouse = new Map<string, { key: string; cw: PlanChannelWarehouse }[]>();
  for (const l of located) byWarehouse.set(l.cw.warehouseId!, [...(byWarehouse.get(l.cw.warehouseId!) ?? []), l]);
  const quantity = new Map<string, number>();
  for (const [warehouseId, members] of byWarehouse) {
    const stock = input.stock.get(stockKey(listing.variantId, warehouseId));
    if (!stock?.established) return skip("stock_not_set");
    members.sort(
      (a, b) => Number(b.cw.isDefault) - Number(a.cw.isDefault) || byId(a.cw.id, b.cw.id) || byId(a.key, b.key),
    );
    const [primary, ...rest] = members;
    const rule = resolveRule(input.rules, store.id, primary!.cw.id, listing.variantId);
    quantity.set(primary!.key, allocate(stock.available, rule, store.maxStockQuantity));
    for (const r of rest) quantity.set(r.key, 0);
  }

  const perWarehouse = new Map<string, number>();
  for (const l of located) perWarehouse.set(l.cw.id, (perWarehouse.get(l.cw.id) ?? 0) + quantity.get(l.key)!);
  const changed = [...perWarehouse].some(([cwId, qty]) => {
    const state = stateOf.get(`${listing.id}|${cwId}`);
    return !state || state.lastPushedQty !== qty || state.lastError !== null;
  });
  if (!changed) return { kind: "unchanged", listing };
  return {
    kind: "push",
    listing,
    update: {
      externalItemId: listing.externalItemId,
      externalVariantId: listing.externalVariantId,
      warehouses: located.map((l) => ({ externalWarehouseId: l.key, quantity: quantity.get(l.key)! })),
    },
    targets: [...perWarehouse].map(([channelWarehouseId, qty]) => ({ channelWarehouseId, quantity: qty })),
  };
}

export type StockAlert = "low" | "out";
const ALERT_RANK: Record<StockAlert, number> = { low: 1, out: 2 };

/**
 * Stock alert of one variant in one warehouse (PRD FR-NTF-01): `out` when nothing is sellable, `low` at
 * or under the minimum the seller set. Stock nobody established says nothing (ADR-036).
 */
export function stockAlertOf(s: {
  available: number;
  minStock: number | null;
  established: boolean;
}): StockAlert | null {
  if (!s.established) return null;
  if (s.available <= 0) return "out";
  if (s.minStock !== null && s.available <= s.minStock) return "low";
  return null;
}

/** An alert is sent when the level gets worse than the one already sent (none, low, out). */
export function alertWorsened(sent: StockAlert | null, now: StockAlert | null): boolean {
  return now !== null && ALERT_RANK[now] > (sent ? ALERT_RANK[sent] : 0);
}
