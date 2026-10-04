import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";

export type StockRow = components["schemas"]["StockPageDto_Output"]["items"][number];
export type StockCell = StockRow["warehouses"][number];
export type PushState = StockRow["push"][number]["state"];
export type Warehouse = components["schemas"]["WarehouseListDto_Output"]["items"][number];
export type AdjustReason = components["schemas"]["AdjustStockDto"]["reason"];

/** The stock filters of L19, as the api names them (`?stock=`). */
export const STOCK_FILTERS = ["low", "out", "negative", "unset"] as const;
export type StockFilter = (typeof STOCK_FILTERS)[number];

export function stockFilterOf(value: string | null): StockFilter | null {
  return STOCK_FILTERS.find((f) => f === value) ?? null;
}

export const ADJUST_REASONS = [
  "correction",
  "damaged",
  "lost",
  "sample",
  "other",
] as const satisfies readonly AdjustReason[];

/** Dot color per push state (L19 "Terkirim ke"): green synced, red failed, yellow paused, gray waiting. */
export const PUSH_TONE: Record<PushState, Tone> = {
  synced: "success",
  pending: "neutral",
  failed: "danger",
  paused: "warning",
};

/**
 * What the stock on hand becomes after an adjustment: a count replaces it (`set`), a difference adds to it
 * (`delta`). Under zero the api refuses it (`stock.insufficient`), so the form says so first.
 */
export function adjustedOnHand(onHand: number, mode: "set" | "delta", quantity: number): number {
  return mode === "set" ? quantity : onHand + quantity;
}

/** The warehouse columns of the table: the filtered one, else every active warehouse in the user's scope. */
export function warehouseColumns(warehouses: Warehouse[], filter: string | null): Warehouse[] {
  if (filter) return warehouses.filter((w) => w.id === filter);
  return warehouses.filter((w) => w.active);
}

/**
 * Where a "stock running out" alert leads. Alerts count variant and warehouse pairs while the list's
 * filters judge a variant across warehouses, so only a single SKU gets a narrowed view; several open the
 * whole list, whose tiles and chips show the rest.
 */
export function criticalStockHref(items: readonly { sku: string }[]): string {
  const skus = [...new Set(items.map((i) => i.sku))];
  return skus.length === 1 ? `/stok?q=${encodeURIComponent(skus[0]!)}` : "/stok";
}
