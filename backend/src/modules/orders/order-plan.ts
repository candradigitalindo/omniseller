import type { NormalizedRecipient, OrderState } from "@omniseller/connector-core";
import type { OrderStatus } from "@omniseller/shared";
import type { OrderProblemCode } from "../../db/schema";

/**
 * Order decisions as pure functions (backend doc 7.9, 8.14): the status a marketplace fact leads to,
 * the stock movements that keep reservations in line with the status, the problems an order has, and
 * its ship-by state. The services load data, call these, and write the result.
 */

/** Statuses whose units are still in the warehouse and held for the order. */
export const HOLD_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "unpaid",
  "new",
  "problem",
  "ready_to_pack",
  "packed",
  "ready_to_ship",
]);
/** Statuses in which the units have left the warehouse. */
export const SHIPPED_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "shipped",
  "delivered",
  "completed",
  "return_in_progress",
  "returned",
]);
/**
 * What a marketplace snapshot writes about the buyer: name, username, phone, address, note, and the
 * marketplace's buyer id. Once an order's buyer data is anonymized (backend doc 8.34) a later snapshot
 * leaves them out, so they never come back.
 */
export const BUYER_DATA_FIELDS = [
  "buyerNote",
  "externalBuyerId",
  "buyerUsername",
  "buyerName",
  "buyerPhone",
  "shippingAddress",
] as const;

export function withoutBuyerData<T extends object>(fields: T): T {
  const out = { ...fields } as Record<string, unknown>;
  for (const f of BUYER_DATA_FIELDS) delete out[f];
  return out as T;
}

/** Statuses the seller still has to act on before the ship-by deadline. */
export const TO_SHIP_STATUSES: ReadonlySet<OrderStatus> = new Set([
  "new",
  "problem",
  "ready_to_pack",
  "packed",
  "ready_to_ship",
]);

export interface OrderFact {
  state: OrderState;
  fulfillment: "seller" | "marketplace";
}

/** Status of an order seen for the first time (inserts are not checked by the transition trigger). */
export function initialStatus(f: OrderFact): OrderStatus {
  if (f.fulfillment === "marketplace") {
    if (f.state === "cancelled") return "cancelled";
    if (f.state === "completed") return "completed";
    if (f.state === "returning") return "return_in_progress";
    return "marketplace_fulfilled";
  }
  switch (f.state) {
    case "unpaid":
      return "unpaid";
    case "to_ship":
    case "seller_processing":
      return "new";
    case "shipped":
      return "shipped";
    case "delivered":
      return "delivered";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "returning":
      return "return_in_progress";
  }
}

export interface StatusStep {
  to: OrderStatus;
  /** `marketplace` steps skip seller steps and need withStatusSource(tx, "marketplace"). */
  via: "any" | "marketplace";
}

const BEFORE_HANDOVER: ReadonlySet<OrderStatus> = new Set(["new", "problem", "ready_to_pack", "packed"]);
const CANCELLABLE: ReadonlySet<OrderStatus> = new Set([
  "unpaid",
  "new",
  "problem",
  "ready_to_pack",
  "packed",
  "ready_to_ship",
  "shipped",
]);

/**
 * The transitions that bring an existing order in line with a marketplace fact. Never backwards: a
 * fact behind the stored status (a late webhook) gives no step. Seller-side progress at the
 * marketplace (shipment arranged) gives no step either; it only shows in external_status.
 */
export function statusSteps(current: OrderStatus, f: OrderFact): StatusStep[] {
  const s = f.state;
  if (current === "cancelled" || current === "returned") return [];
  if (current === "marketplace_fulfilled") {
    if (s === "completed") return [{ to: "completed", via: "any" }];
    if (s === "cancelled") return [{ to: "cancelled", via: "any" }];
    if (s === "returning") return [{ to: "return_in_progress", via: "any" }];
    return [];
  }
  if (s === "cancelled") return CANCELLABLE.has(current) ? [{ to: "cancelled", via: "any" }] : [];
  if (s === "unpaid") return [];

  const steps: StatusStep[] = [];
  let cur: OrderStatus = current;
  const go = (to: OrderStatus, via: StatusStep["via"]) => {
    steps.push({ to, via });
    cur = to;
  };
  if (cur === "unpaid") go("new", "any");
  if (s === "to_ship" || s === "seller_processing") return steps;

  if (BEFORE_HANDOVER.has(cur) || cur === "ready_to_ship") {
    const handedOver = cur === "ready_to_ship" ? "any" : "marketplace";
    if (s === "shipped") go("shipped", handedOver);
    else if (s === "delivered") go("delivered", "marketplace");
    else if (s === "completed") go("completed", "marketplace");
    else if (s === "returning") {
      go("shipped", handedOver);
      go("return_in_progress", "any");
    }
    return steps;
  }
  if (cur === "shipped") {
    if (s === "delivered") go("delivered", "any");
    else if (s === "completed") go("completed", "marketplace");
    else if (s === "returning") go("return_in_progress", "any");
  } else if (cur === "delivered") {
    if (s === "completed") go("completed", "any");
    else if (s === "returning") go("return_in_progress", "any");
  } else if (cur === "completed") {
    if (s === "returning") go("return_in_progress", "any");
  } else if (cur === "return_in_progress") {
    if (s === "completed") go("completed", "any");
  }
  return steps;
}

export interface ItemStock {
  qty: number;
  cancelledQty: number;
  reservedQty: number;
  shippedQty: number;
  variantId: string | null;
  warehouseId: string | null;
}

export interface StockMove {
  type: "order_reserve" | "order_release" | "order_ship";
  qty: number;
}

/**
 * Stock movements that make an item's reservation match the order status:
 * - held statuses reserve what is still to be fulfilled (a partial cancellation releases the rest)
 * - shipped statuses take the reserved units out of the warehouse (`order_ship`). Units that were never
 *   reserved (the SKU was unmapped, or the order was already shipped when OmniSeller first saw it, as
 *   in the 90-day import) do not touch stock: they are part of the stock that was counted later.
 * - cancelled releases the reservation
 * Orders fulfilled by the marketplace and items without variant or warehouse never touch stock.
 */
export function itemStockPlan(
  status: OrderStatus,
  fulfillment: "seller" | "marketplace",
  item: ItemStock,
): { moves: StockMove[]; reservedQty: number; shippedQty: number } {
  const open = item.qty - item.cancelledQty;
  const shipped = SHIPPED_STATUSES.has(status) ? Math.max(item.shippedQty, open) : item.shippedQty;
  if (fulfillment === "marketplace" || !item.variantId || !item.warehouseId) {
    return { moves: [], reservedQty: item.reservedQty, shippedQty: shipped };
  }
  if (HOLD_STATUSES.has(status)) {
    const diff = open - item.reservedQty;
    const moves: StockMove[] =
      diff > 0 ? [{ type: "order_reserve", qty: diff }] : diff < 0 ? [{ type: "order_release", qty: -diff }] : [];
    return { moves, reservedQty: open, shippedQty: item.shippedQty };
  }
  if (SHIPPED_STATUSES.has(status)) {
    const moves: StockMove[] = item.reservedQty > 0 ? [{ type: "order_ship", qty: item.reservedQty }] : [];
    return { moves, reservedQty: 0, shippedQty: shipped };
  }
  if (status === "cancelled") {
    const moves: StockMove[] = item.reservedQty > 0 ? [{ type: "order_release", qty: item.reservedQty }] : [];
    return { moves, reservedQty: 0, shippedQty: item.shippedQty };
  }
  return { moves: [], reservedQty: item.reservedQty, shippedQty: item.shippedQty };
}

export interface ProblemItem {
  sku: string;
  title: string;
  open: number;
  variantId: string | null;
  warehouseId: string | null;
  externalWarehouseId: string | null;
}

export interface ProblemInput {
  status: OrderStatus;
  fulfillment: "seller" | "marketplace";
  recipientAvailable: boolean;
  recipient: Pick<NormalizedRecipient, "name" | "phone" | "fullAddress"> | null;
  items: ProblemItem[];
  /** keyed by `${variantId}|${warehouseId}` */
  stock: ReadonlyMap<string, { available: number; established: boolean }>;
}

/** Problems found from the order itself (FR-ORD-06, FR-WHS-10); duplicates and value are checked at intake. */
export function detectProblems(p: ProblemInput): Map<OrderProblemCode, Record<string, unknown>> {
  const out = new Map<OrderProblemCode, Record<string, unknown>>();
  if (p.fulfillment === "marketplace" || !HOLD_STATUSES.has(p.status)) return out;
  const open = p.items.filter((i) => i.open > 0);

  const unmapped = open.filter((i) => !i.variantId);
  if (unmapped.length > 0) out.set("unmapped_sku", { items: unmapped.map((i) => ({ sku: i.sku, title: i.title })) });

  const noWarehouse = open.filter((i) => !i.warehouseId);
  if (noWarehouse.length > 0) {
    out.set("unmapped_warehouse", {
      externalWarehouseIds: [...new Set(noWarehouse.map((i) => i.externalWarehouseId ?? ""))].filter(Boolean),
    });
  }

  // stock that was never established says nothing about what is on the shelf
  const short = open.filter((i) => {
    if (!i.variantId || !i.warehouseId) return false;
    const s = p.stock.get(`${i.variantId}|${i.warehouseId}`);
    return !!s && s.established && s.available < 0;
  });
  if (short.length > 0) {
    out.set("insufficient_stock", {
      items: short.map((i) => ({
        sku: i.sku,
        variantId: i.variantId,
        warehouseId: i.warehouseId,
        available: p.stock.get(`${i.variantId}|${i.warehouseId}`)!.available,
      })),
    });
  }

  if (p.status !== "unpaid" && p.recipientAvailable) {
    const missing = (["name", "phone", "fullAddress"] as const).filter((k) => !p.recipient?.[k]);
    if (missing.length > 0) out.set("address_incomplete", { missing });
  }
  return out;
}

/** Problems the order can be in "problem" status for; any open one moves a new order there. */
export function problemStep(status: OrderStatus, openProblems: number): StatusStep | null {
  if (status === "new" && openProblems > 0) return { to: "problem", via: "any" };
  if (status === "problem" && openProblems === 0) return { to: "new", via: "any" };
  return null;
}

/** Totals at or above this are flagged as an unusual value (FR-ORD-06), in rupiah. */
export const HIGH_VALUE_RUPIAH = 10_000_000;

export type SlaState = "ok" | "warning" | "overdue";
/** Under this much time left before the ship-by deadline an order is shown yellow (FR-ORD-07). */
export const SLA_WARNING_MS = 6 * 3600_000;

export function slaOf(
  shipByAt: Date | null,
  status: OrderStatus,
  now = new Date(),
): { state: SlaState; remainingMs: number } | null {
  if (!shipByAt || !TO_SHIP_STATUSES.has(status)) return null;
  const remainingMs = shipByAt.getTime() - now.getTime();
  return { state: remainingMs <= 0 ? "overdue" : remainingMs <= SLA_WARNING_MS ? "warning" : "ok", remainingMs };
}

export type SlaAlertLevel = "warning" | "overdue";

/**
 * The ship-by alert an order should have had by now (FR-SHP-10): warning at 6 hours or less, overdue
 * once the deadline passed. Null when no alert is due or the order already had this one; an order
 * alerted as warning is alerted again when it becomes overdue.
 */
export function slaAlertDue(
  shipByAt: Date | null,
  status: OrderStatus,
  sent: SlaAlertLevel | null,
  now = new Date(),
): SlaAlertLevel | null {
  const sla = slaOf(shipByAt, status, now);
  if (!sla || sla.state === "ok") return null;
  if (sla.state === "overdue") return sent === "overdue" ? null : "overdue";
  return sent === null ? "warning" : null;
}

// ---- manual orders (PRD FR-ORD-09, 12; backend doc 8.21) ----

/** Reasons a seller cancels a manual order for; marketplace orders use the marketplace's own list. */
export const MANUAL_CANCEL_REASONS = [
  { code: "buyer_request", label: "Pembeli membatalkan", needsItems: false },
  { code: "out_of_stock", label: "Stok habis", needsItems: false },
  { code: "unpaid", label: "Pembayaran tidak diterima", needsItems: false },
  { code: "duplicate", label: "Pesanan dobel", needsItems: false },
  { code: "other", label: "Alasan lain", needsItems: false },
] as const;

/**
 * Money of a manual order, in the marketplace orders' terms: a line is unit price times quantity, the
 * subtotal adds the lines, the order discount (a seller voucher) comes off it, and the buyer's shipping
 * fee is added on top.
 */
export function manualTotals(
  lines: readonly { unitPrice: number; qty: number }[],
  discount: number,
  shippingFee: number,
): { subtotal: number; total: number } {
  const subtotal = lines.reduce((n, l) => n + l.unitPrice * l.qty, 0);
  return { subtotal, total: subtotal - discount + shippingFee };
}

/** "MN-2610-0007": manual order 7 of October 2026 (the business's local month). */
export const manualOrderNumber = (period: string, n: number): string => `MN-${period}-${String(n).padStart(4, "0")}`;

const SELLER_PATH: readonly OrderStatus[] = [
  "new",
  "ready_to_pack",
  "packed",
  "ready_to_ship",
  "shipped",
  "delivered",
  "completed",
];

/**
 * Every seller step from `current` to `target`, none skipped (a manual order has no marketplace to
 * report facts that skip steps). Null when the target is not ahead on that path.
 */
export function pathTo(current: OrderStatus, target: OrderStatus): StatusStep[] | null {
  const from = SELLER_PATH.indexOf(current);
  const to = SELLER_PATH.indexOf(target);
  if (from < 0 || to <= from) return null;
  return SELLER_PATH.slice(from + 1, to + 1).map((s) => ({ to: s, via: "any" }));
}

/** Statuses in which an order may still change warehouse: nothing has been packed (FR-ORD-12). */
export const MOVABLE: ReadonlySet<OrderStatus> = new Set(["unpaid", "new", "problem", "ready_to_pack"]);

/**
 * A marketplace placed the order in its warehouse (FR-WHS-06, 07) when its store has more than one
 * active seller warehouse: such orders are never moved. Manual orders and orders of stores without
 * multi-warehouse are placed by OmniSeller and can be (FR-ORD-12).
 */
export function warehouseFixed(channel: string, sellerWarehouses: number): boolean {
  return channel !== "manual" && sellerWarehouses > 1;
}

/**
 * What the team performance report (FR-RPT-10, backend doc 8.35) counts from the order history. Only a
 * user's own entries count: the marketplace's and the system's never do. A user processed an order on a
 * day when they moved it on that day: a seller step of its status (every step of `SELLER_PATH` after
 * `new`, so recording a manual order's payment is not one), arranging its shipment, or handing it over.
 */
export const PROCESSING_STATUSES: readonly OrderStatus[] = SELLER_PATH.slice(1);
export const PROCESSING_EVENTS = ["shipment_requested", "handed_over"] as const;

/**
 * Packing by scan records how long it took from scanning the order to finishing it (`seconds`). Longer
 * than this the packer was interrupted, so the average time per order leaves it out.
 */
export const PACK_TIME_LIMIT_SECONDS = 30 * 60;
