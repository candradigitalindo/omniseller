/**
 * The restock list as a pure function (backend doc 8.20, PRD FR-STK-07): how fast each variant sells in
 * each warehouse over the last 7, 14, or 30 days, how many days its stock lasts at that pace, and how
 * much to order to last the target number of days. The service loads stock and sales and calls this.
 */

export type RestockReason =
  /** nothing sellable left while it sells or has a minimum */
  | "out"
  /** at or under the minimum the seller set */
  | "below_min"
  /** lasts fewer days than the cover asked for */
  | "low_cover";

const RANK: Record<RestockReason, number> = { out: 0, below_min: 1, low_cover: 2 };

export interface RestockInput {
  variantId: string;
  warehouseId: string;
  sku: string;
  /** on hand minus reserved and buffer; can be negative when oversold */
  available: number;
  minStock: number | null;
  /** units sold in the window (sold orders, after cancellations) */
  unitsSold: number;
}

export interface RestockLine extends RestockInput {
  /** units per day over the window */
  dailyRate: number;
  /** days the sellable stock lasts at that rate; null when it does not sell */
  daysOfCover: number | null;
  /** units to order so stock lasts the target days and stays above the minimum */
  suggested: number;
  reason: RestockReason | null;
}

export interface RestockOptions {
  windowDays: number;
  /** stock lasting fewer days than this needs restocking */
  coverDays: number;
  /** a restock should last this many days */
  targetDays: number;
}

export function restockLines(rows: readonly RestockInput[], o: RestockOptions): RestockLine[] {
  return rows
    .map((r) => {
      const dailyRate = r.unitsSold / o.windowDays;
      const sellable = Math.max(r.available, 0);
      const daysOfCover = dailyRate > 0 ? Math.round((sellable / dailyRate) * 10) / 10 : null;
      // above the minimum: at or under it is "low" (stock alerts, FR-NTF-01)
      const floor = r.minStock !== null ? r.minStock + 1 : 0;
      const target = Math.max(Math.ceil(dailyRate * o.targetDays), floor);
      const suggested = Math.max(0, target - sellable);
      const reason: RestockReason | null =
        r.available <= 0 && (dailyRate > 0 || r.minStock !== null)
          ? "out"
          : r.minStock !== null && r.available <= r.minStock
            ? "below_min"
            : daysOfCover !== null && daysOfCover < o.coverDays
              ? "low_cover"
              : null;
      return { ...r, dailyRate: Math.round(dailyRate * 100) / 100, daysOfCover, suggested, reason };
    })
    .sort(
      (a, b) =>
        (a.reason ? RANK[a.reason] : 9) - (b.reason ? RANK[b.reason] : 9) ||
        (a.daysOfCover ?? Number.POSITIVE_INFINITY) - (b.daysOfCover ?? Number.POSITIVE_INFINITY) ||
        b.dailyRate - a.dailyRate ||
        a.sku.localeCompare(b.sku),
    );
}
