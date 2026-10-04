import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { Tx } from "../../db/client";
import { dataOf, ListingsService } from "../catalog/listings.service";
import { storeNotFound } from "../channel/channel.errors";
import { StoresService } from "../channel/stores.service";
import { InventoryRepository } from "./inventory.repository";
import { toPlanListing, toPlanStore, toRule } from "./stock-inputs";
import { planStockPush, stockKey } from "./stock-plan";

/**
 * - match: OmniSeller would send what the marketplace shows
 * - differ: OmniSeller would change the marketplace's stock
 * - unset: the variant's stock was never established in OmniSeller, so nothing would be sent (ADR-036)
 * - unknown: no marketplace stock for a location yet, or a location OmniSeller does not know
 * - managed: all stock sits in warehouses the marketplace manages
 * - inactive: banned or deleted at the marketplace
 */
export type ComparisonStatus = "match" | "differ" | "unset" | "unknown" | "managed" | "inactive";
export const COMPARISON_STATUSES: readonly ComparisonStatus[] = [
  "differ",
  "unset",
  "unknown",
  "match",
  "managed",
  "inactive",
];

export interface ComparisonLocation {
  externalWarehouseId: string;
  warehouseName: string | null;
  /** Seller stock the marketplace reported at the last listing pull. */
  marketplace: number | null;
  /** What OmniSeller would send once the store is live. */
  omniseller: number | null;
}

export interface ComparisonLine {
  listingId: string;
  variantId: string;
  sku: string;
  externalSku: string | null;
  title: string;
  status: ComparisonStatus;
  marketplace: number | null;
  omniseller: number | null;
  /** omniseller - marketplace, over the listing's locations. */
  difference: number | null;
  locations: ComparisonLocation[];
}

export interface StoreComparison {
  storeId: string;
  /** When the listings, and so the marketplace stock, were last pulled. */
  pulledAt: Date | null;
  /** Why nothing could be sent even when live: the store must be reconnected, or a warehouse is unmapped. */
  blocked: "store_unusable" | "warehouses_unmapped" | null;
  counts: Record<ComparisonStatus, number>;
  lines: ComparisonLine[];
}

const sum = (xs: (number | null)[]): number | null =>
  xs.some((x) => x === null) ? null : xs.reduce<number>((n, x) => n + (x ?? 0), 0);

/**
 * Parallel mode, side by side (PRD FR-MIG-05, UI L46 step 4): for every mapped listing of a store,
 * the stock the marketplace shows (set by the app the seller still uses) against what OmniSeller
 * would send once the store is live. The pusher's own plan (`planStockPush`) computes the second,
 * with the store taken as live and nothing pushed before, so the comparison shows exactly what the
 * cutover would change. Nothing is sent.
 */
@Injectable()
export class StockComparisonService {
  constructor(
    @Inject(InventoryRepository) private readonly repo: InventoryRepository,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(StoresService) private readonly stores: StoresService,
  ) {}

  async compareIn(tx: Tx, ctx: RequestContext, storeId: string): Promise<StoreComparison> {
    if (!this.stores.inScope(ctx, storeId)) throw storeNotFound();
    const target = (await this.stores.stockTargetsIn(tx, [storeId])).get(storeId);
    if (!target) throw storeNotFound();
    const store = { ...toPlanStore(target), live: true };
    const blocked = !store.usable
      ? "store_unusable"
      : store.warehouses.some((w) => w.active && w.kind === "seller" && !w.warehouseId)
        ? "warehouses_unmapped"
        : null;

    const listings = await this.listings.mappedInStoreIn(tx, storeId);
    const variantIds = [...new Set(listings.map((l) => l.variantId!))];
    const warehouseIds = [...new Set(store.warehouses.flatMap((w) => (w.warehouseId ? [w.warehouseId] : [])))];
    const rows = await this.repo.rows(tx, variantIds, warehouseIds);
    const rules = await this.repo.rules(tx, [storeId]);
    const variants = await this.repo.variants(tx, variantIds);
    const outcomes = planStockPush({
      listings: listings.map(toPlanListing),
      stores: new Map([[storeId, store]]),
      stock: new Map(
        rows.map((r) => [
          stockKey(r.variantId, r.warehouseId),
          { available: r.available ?? 0, established: r.stockSetAt !== null },
        ]),
      ),
      rules: rules.map(toRule),
      states: [],
    });

    const names = new Map(target.warehouses.map((w) => [w.externalWarehouseId, w.name]));
    const sellers = target.warehouses.filter((w) => w.active && w.kind === "seller");
    const byId = new Map(listings.map((l) => [l.id, l]));
    const counts = Object.fromEntries(COMPARISON_STATUSES.map((s) => [s, 0])) as Record<ComparisonStatus, number>;
    const lines: ComparisonLine[] = [];
    for (const o of outcomes) {
      const l = byId.get(o.listing.id)!;
      const reported = dataOf(l).stockByWarehouse ?? {};
      const marketplaceAt = (key: string): number | null =>
        key in reported
          ? reported[key]!
          : Object.keys(reported).length === 0 && sellers.length === 1
            ? l.stockAtChannel
            : null;
      let status: ComparisonStatus;
      let locations: ComparisonLocation[];
      if (o.kind === "push") {
        locations = o.update.warehouses.map((w) => ({
          externalWarehouseId: w.externalWarehouseId,
          warehouseName: names.get(w.externalWarehouseId) ?? null,
          marketplace: marketplaceAt(w.externalWarehouseId),
          omniseller: w.quantity,
        }));
        status = locations.some((x) => x.marketplace === null)
          ? "unknown"
          : locations.every((x) => x.marketplace === x.omniseller)
            ? "match"
            : "differ";
      } else {
        const keys =
          Object.keys(reported).length > 0 ? Object.keys(reported) : sellers.map((w) => w.externalWarehouseId);
        locations = keys.map((k) => ({
          externalWarehouseId: k,
          warehouseName: names.get(k) ?? null,
          marketplace: marketplaceAt(k),
          omniseller: null,
        }));
        status =
          o.kind === "unchanged"
            ? "match"
            : o.reason === "stock_not_set"
              ? "unset"
              : o.reason === "marketplace_managed"
                ? "managed"
                : o.reason === "not_pushable"
                  ? "inactive"
                  : "unknown";
      }
      const marketplace = sum(locations.map((x) => x.marketplace));
      const omniseller = sum(locations.map((x) => x.omniseller));
      counts[status]++;
      lines.push({
        listingId: l.id,
        variantId: l.variantId!,
        sku: variants.get(l.variantId!)?.sku ?? "",
        externalSku: l.externalSku,
        title: l.title,
        status,
        marketplace,
        omniseller,
        difference: marketplace !== null && omniseller !== null ? omniseller - marketplace : null,
        locations,
      });
    }
    const rank = new Map(COMPARISON_STATUSES.map((s, i) => [s, i]));
    lines.sort((a, b) => rank.get(a.status)! - rank.get(b.status)! || a.sku.localeCompare(b.sku));
    return { storeId, pulledAt: target.store.lastProductSyncAt, blocked, counts, lines };
  }
}
