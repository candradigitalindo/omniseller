import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, STOCK_DIRTY } from "../../infra/tokens";
import type { StockDirtySet, StockPair } from "../../jobs/stock-dirty";
import { ListingsService } from "../catalog/listings.service";
import { type StockTarget, StoresService } from "../channel/stores.service";
import { InventoryRepository } from "./inventory.repository";

/** OmniSeller warehouses a store's active seller warehouses are mapped to. */
function mappedWarehouses(t: StockTarget): string[] {
  return [
    ...new Set(
      t.warehouses.flatMap((w) =>
        w.active && w.kind === "seller" && w.mappingStatus === "mapped" && w.warehouseId ? [w.warehouseId] : [],
      ),
    ),
  ];
}

const pushes = (t: StockTarget | undefined): t is StockTarget => !!t && t.usable && t.store.syncMode === "live";

/**
 * What makes the stock pusher run besides stock changes (backend doc 9.4): a listing gets its variant,
 * a store goes live or its warehouse mapping changes, an allocation rule changes, or the seller asks.
 * Each marks the affected (variant, warehouse) pairs dirty; the pusher does the rest.
 */
@Injectable()
export class StockTriggersService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(InventoryRepository) private readonly repo: InventoryRepository,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(STOCK_DIRTY) private readonly dirty: StockDirtySet,
  ) {}

  async markPairs(ctx: RequestContext, pairs: StockPair[]): Promise<void> {
    await this.dirty.markMany(ctx.tenantId, pairs);
  }

  /** Operational repair: recompute this variant through the normal push planner, even if unchanged. */
  async forcePair(ctx: RequestContext, pair: StockPair): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const listings = await this.listings.mappedForVariantsIn(tx, [pair.variantId]);
      await this.repo.invalidateStates(
        tx,
        listings.map((l) => l.id),
      );
    });
    await this.dirty.mark(ctx.tenantId, pair.variantId, pair.warehouseId);
  }

  /** A listing got a (new) variant: whatever was pushed for it before no longer counts. */
  async listingMapped(ctx: RequestContext, listingId: string): Promise<number> {
    const pairs = await withTenantTx(this.db, ctx, async (tx) => {
      const [l] = await this.listings.listingsByIdsIn(tx, [listingId]);
      if (!l?.variantId) return [];
      await this.repo.invalidateStates(tx, [l.id]);
      const target = (await this.stores.stockTargetsIn(tx, [l.storeId])).get(l.storeId);
      if (!pushes(target)) return [];
      return mappedWarehouses(target).map((warehouseId) => ({ variantId: l.variantId!, warehouseId }));
    });
    await this.dirty.markMany(ctx.tenantId, pairs);
    return pairs.length;
  }

  /** A listing lost its variant: its push state describes a mapping that no longer exists. */
  async listingUnmapped(ctx: RequestContext, listingId: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const [l] = await this.listings.listingsByIdsIn(tx, [listingId]);
      if (l && !l.variantId) await this.repo.deleteStates(tx, [l.id]);
    });
  }

  /**
   * Pushes a store's mapped listings again (all, or those of `variantIds`). `force` forgets what was
   * pushed, so every value is sent even if the marketplace should already have it.
   */
  async resyncStore(
    ctx: RequestContext,
    storeId: string,
    opts: { variantIds?: string[] | undefined; force: boolean },
  ): Promise<number> {
    const pairs = await withTenantTx(this.db, ctx, async (tx) => {
      const target = (await this.stores.stockTargetsIn(tx, [storeId])).get(storeId);
      if (!pushes(target)) return [];
      const listings = await this.listings.mappedInStoreIn(tx, storeId, opts.variantIds);
      if (opts.force) {
        await this.repo.invalidateStates(
          tx,
          listings.map((l) => l.id),
        );
      }
      const warehouses = mappedWarehouses(target);
      const variants = [...new Set(listings.map((l) => l.variantId!))];
      return variants.flatMap((variantId) => warehouses.map((warehouseId) => ({ variantId, warehouseId })));
    });
    await this.dirty.markMany(ctx.tenantId, pairs);
    return pairs.length;
  }
}
