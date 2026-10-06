import { CircleDashed, type LucideIcon, PackageCheck, Truck, Undo2, XCircle } from "lucide-react";
import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";
import type { Permission } from "@/lib/session";
import { type StoreStatus, usableStore } from "../stores/store-meta";

export type OrderListItem = components["schemas"]["OrderPageDto_Output"]["items"][number];
export type OrderDetail = components["schemas"]["OrderDto_Output"];
export type OrderStatus = OrderListItem["status"];
export type ProblemCode = OrderListItem["problems"][number]["code"];

/** Pill per status (DOKUMEN-UI-UX 8.5): red only for orders that need a person. */
export const STATUS_PILL: Record<OrderStatus, { tone: Tone; icon?: LucideIcon }> = {
  unpaid: { tone: "neutral" },
  new: { tone: "info", icon: CircleDashed },
  problem: { tone: "danger" },
  ready_to_pack: { tone: "info" },
  packed: { tone: "info", icon: PackageCheck },
  ready_to_ship: { tone: "info", icon: Truck },
  shipped: { tone: "info", icon: Truck },
  delivered: { tone: "success" },
  completed: { tone: "success" },
  return_in_progress: { tone: "warning", icon: Undo2 },
  returned: { tone: "neutral", icon: Undo2 },
  marketplace_fulfilled: { tone: "neutral", icon: Truck },
  cancelled: { tone: "neutral", icon: XCircle },
};

/** The tabs of L03, in order, with the statuses each one lists. */
export const ORDER_TABS = [
  { key: "all", statuses: [] },
  { key: "new", statuses: ["new"] },
  { key: "problem", statuses: ["problem"] },
  { key: "ready_to_pack", statuses: ["ready_to_pack"] },
  { key: "packed", statuses: ["packed"] },
  { key: "ready_to_ship", statuses: ["ready_to_ship"] },
  { key: "shipped", statuses: ["shipped", "delivered"] },
  { key: "completed", statuses: ["completed"] },
  { key: "cancelled", statuses: ["cancelled"] },
  { key: "returns", statuses: ["return_in_progress", "returned"] },
] as const satisfies readonly { key: string; statuses: readonly OrderStatus[] }[];

export type OrderTab = (typeof ORDER_TABS)[number]["key"];

export function tabOf(status: string | null): OrderTab {
  return (
    ORDER_TABS.find((t) => t.statuses.length === 1 && t.statuses[0] === status)?.key ??
    ORDER_TABS.find((t) => t.key === status)?.key ??
    "all"
  );
}

/** How many orders a tab holds, from the summary's counts per status. */
export function tabCount(tab: OrderTab, statuses: Record<string, number>): number | null {
  const def = ORDER_TABS.find((t) => t.key === tab);
  if (!def || def.statuses.length === 0) return null;
  return def.statuses.reduce((n, s) => n + (statuses[s] ?? 0), 0);
}

/** The four steps of the stepper in L04; returns and cancellations show no stepper. */
export const ORDER_STEPS = ["new", "packed", "shipped", "completed"] as const;

export function stepOf(status: OrderStatus): number | null {
  switch (status) {
    case "new":
    case "problem":
      return 0;
    case "ready_to_pack":
    case "packed":
    case "ready_to_ship":
      return 1;
    case "shipped":
    case "delivered":
      return 2;
    case "completed":
      return 3;
    default:
      return null;
  }
}

/** Statuses a seller may cancel from (backend `SELLER_CANCELLABLE`). */
const CANCELLABLE: ReadonlySet<OrderStatus> = new Set([
  "unpaid",
  "new",
  "problem",
  "ready_to_pack",
  "packed",
  "ready_to_ship",
]);

/** Statuses "Atur kirim" accepts (backend `ARRANGEABLE`). */
export const ARRANGEABLE: ReadonlySet<OrderStatus> = new Set(["new", "ready_to_pack", "packed"]);

export type PrimaryAction = "pay" | "accept" | "pack" | "arrange" | "label" | "ship" | "complete";

type ActionInput = Pick<OrderDetail, "status" | "fulfillmentMode" | "shippingAddress" | "addressHidden"> & {
  channel: string | null;
};

const ACTION_PERMISSION: Record<PrimaryAction, Permission> = {
  pay: "order:write",
  accept: "order:accept",
  pack: "shipment:pack",
  arrange: "shipment:arrange",
  label: "shipment:print",
  ship: "shipment:handover",
  complete: "order:write",
};

/**
 * The one main button of L04 for this order and user (DOKUMEN-UI-UX 14.2): the next seller step of a
 * marketplace order, or of a manual order (backend 8.22). Orders the marketplace ships, and orders with an
 * open problem, have none: the problem card comes first.
 */
export function primaryActionOf(o: ActionInput, can: (p: Permission) => boolean): PrimaryAction | null {
  const action = nextStep(o);
  return action && can(ACTION_PERMISSION[action]) ? action : null;
}

function nextStep(o: ActionInput): PrimaryAction | null {
  if (o.fulfillmentMode === "marketplace") return null;
  if (o.channel === "manual") {
    if (o.status === "unpaid") return "pay";
    const shipsToBuyer = o.shippingAddress !== null || o.addressHidden;
    if (o.status === "shipped" || o.status === "delivered") return "complete";
    if (o.status === "new" || o.status === "ready_to_pack" || o.status === "packed" || o.status === "ready_to_ship") {
      return shipsToBuyer ? "ship" : "complete";
    }
    return null;
  }
  switch (o.status) {
    case "new":
      return "accept";
    case "ready_to_pack":
      return "pack";
    case "packed":
      return "arrange";
    case "ready_to_ship":
      return "label";
    default:
      return null;
  }
}

/** Whether "Batalkan pesanan" belongs in the menu: a status the seller may cancel from, not yet asked. */
export function canCancel(o: Pick<OrderDetail, "status" | "fulfillmentMode" | "cancelRequested">): boolean {
  return CANCELLABLE.has(o.status) && o.fulfillmentMode === "seller" && !o.cancelRequested;
}

/** The shipping address as name, phone, and lines, from a marketplace's (`fullAddress`) or a manual order's (`line1`). */
export function addressLines(address: Record<string, unknown> | null): {
  name: string | null;
  phone: string | null;
  lines: string[];
} {
  if (!address) return { name: null, phone: null, lines: [] };
  const text = (k: string) => {
    const v = address[k];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const street = text("fullAddress") ?? text("line1");
  const area = [text("district"), text("city"), text("province"), text("postalCode")].filter(
    (x): x is string => x !== null,
  );
  // a marketplace's full address usually ends with the area already
  const areaLine = area.length > 0 && !(street && area.every((a) => street.includes(a))) ? area.join(", ") : null;
  return { name: text("name"), phone: text("phone"), lines: [street, areaLine].filter((x): x is string => x !== null) };
}

/**
 * Stores whose orders can be read again from the marketplace: marketplace stores whose connection works. A store
 * waiting for its permission again would only fail in the worker; manual channels have nothing to read.
 */
export function syncableStores<T extends { channel: string; status: StoreStatus }>(stores: readonly T[]): T[] {
  return stores.filter((s) => s.channel !== "manual" && usableStore(s.status));
}

/** Statuses an order may move warehouse from (backend `MOVABLE`): before anyone packed it. */
export const MOVABLE: ReadonlySet<OrderStatus> = new Set(["unpaid", "new", "problem", "ready_to_pack"]);

/** Statuses whose parcel can be tracked again (backend `TRACKED`). */
export const TRACKED: ReadonlySet<OrderStatus> = new Set([
  "shipped",
  "delivered",
  "completed",
  "return_in_progress",
  "returned",
]);
