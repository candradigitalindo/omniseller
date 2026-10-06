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

/** "Atur minimum & rak" (FR-STK-07, 12): one row per warehouse, as typed. */
export interface LocationDraft {
  warehouseId: string;
  minStock: string;
  binLocation: string;
}

/** Every active warehouse in scope, filled from the variant's stock there (a warehouse without stock yet starts empty). */
export function locationDrafts(row: Pick<StockRow, "warehouses">, warehouses: Warehouse[]): LocationDraft[] {
  return warehouses
    .filter((w) => w.active)
    .map((w) => {
      const cell = row.warehouses.find((c) => c.warehouseId === w.id);
      return {
        warehouseId: w.id,
        minStock: cell?.minStock === null || cell?.minStock === undefined ? "" : String(cell.minStock),
        binLocation: cell?.binLocation ?? "",
      };
    });
}

const COUNT = /^\d+$/;

/** What is wrong with a row: the minimum a whole number from 0 (empty: none), the bin at most 50 characters. */
export function locationProblems(d: LocationDraft): { minStock?: "wholeNumber" | "tooLarge"; binLocation?: "tooLong" } {
  const min = d.minStock.trim();
  return {
    ...(min !== "" && !COUNT.test(min)
      ? { minStock: "wholeNumber" as const }
      : min !== "" && Number(min) > 10_000_000
        ? { minStock: "tooLarge" as const }
        : {}),
    ...(d.binLocation.trim().length > 50 ? { binLocation: "tooLong" as const } : {}),
  };
}

/** The body to send for a row, only what changed; null when nothing did. */
export function locationPatch(
  before: LocationDraft,
  after: LocationDraft,
): { minStock?: number | null; binLocation?: string | null } | null {
  const min = (d: LocationDraft) => (d.minStock.trim() === "" ? null : Number(d.minStock.trim()));
  const bin = (d: LocationDraft) => d.binLocation.trim() || null;
  const patch = {
    ...(min(after) !== min(before) ? { minStock: min(after) } : {}),
    ...(bin(after) !== bin(before) ? { binLocation: bin(after) } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : null;
}

/** The stock card of a row (L21), in the warehouse the stock list is filtered to. */
export function historyHref(row: Pick<StockRow, "id" | "sku">, warehouseId: string | null): string {
  const q = new URLSearchParams({ variant: row.id, sku: row.sku, ...(warehouseId ? { warehouse: warehouseId } : {}) });
  return `/stok/riwayat?${q.toString()}`;
}
