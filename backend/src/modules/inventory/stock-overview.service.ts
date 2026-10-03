import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { ListingsService } from "../catalog/listings.service";
import { channelDisplayName, StoresService } from "../channel/stores.service";
import { InventoryRepository, type InventoryRow, type StockFilter, type VariantInfo } from "./inventory.repository";
import { InventoryService } from "./inventory.service";
import { toPlanStore } from "./stock-inputs";
import { storePaused } from "./stock-plan";

export type PushState = "synced" | "pending" | "failed" | "paused";

export interface StorePush {
  storeId: string;
  storeName: string;
  channel: string;
  channelName: string;
  /** synced: every listing has the current push; failed: at least one push was refused or failed;
   * pending: waiting to be pushed (or stock not set yet); paused: read-only or unmapped warehouses */
  state: PushState;
  listings: number;
  lastPushedAt: Date | null;
  lastAttemptAt: Date | null;
  failCount: number;
  lastError: string | null;
}

export interface StockItem {
  variant: VariantInfo;
  rows: InventoryRow[];
  push: StorePush[];
}

/**
 * The stock page (L19, PRD FR-STK-01, 02): variants with their stock per warehouse in the caller's
 * scope, and per connected store whether the marketplace has the current value.
 */
@Injectable()
export class StockOverviewService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(InventoryRepository) private readonly repo: InventoryRepository,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(StoresService) private readonly stores: StoresService,
  ) {}

  async list(
    ctx: RequestContext,
    filter: {
      q?: string | undefined;
      warehouseId?: string | undefined;
      stock?: StockFilter | undefined;
      includeArchived?: boolean | undefined;
    },
    before: string | undefined,
    limit: number,
  ): Promise<{ items: StockItem[]; more: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const ws = (await this.inventory.warehousesIn(tx, ctx, filter.warehouseId)).map((w) => w.id);
      const page = await this.repo.variantPage(
        tx,
        {
          q: filter.q,
          stock: filter.stock,
          includeArchived: filter.includeArchived ?? false,
          warehouseIds: ws,
        },
        before,
        limit,
      );
      const variants = page.slice(0, limit);
      const ids = variants.map((v) => v.variantId);
      const rows = await this.repo.rows(tx, ids, ws);

      const visibleStores = new Map((await this.stores.listIn(tx, ctx)).map((s) => [s.id, s]));
      const listings = (await this.listings.mappedForVariantsIn(tx, ids)).filter((l) => visibleStores.has(l.storeId));
      const targets = await this.stores.stockTargetsIn(
        tx,
        listings.map((l) => l.storeId),
      );
      const states = await this.repo.states(
        tx,
        listings.map((l) => l.id),
      );

      const items = variants.map((variant) => {
        const own = listings.filter((l) => l.variantId === variant.variantId);
        const push: StorePush[] = [];
        for (const storeId of [...new Set(own.map((l) => l.storeId))]) {
          const store = visibleStores.get(storeId)!;
          const target = targets.get(storeId);
          const ofStore = own.filter((l) => l.storeId === storeId);
          const st = states.filter((s) => ofStore.some((l) => l.id === s.listingId));
          const failing = st.filter((s) => s.lastError !== null);
          const synced = ofStore.every((l) => st.some((s) => s.listingId === l.id && s.lastPushedQty !== null));
          const latest = (pick: (s: (typeof st)[number]) => Date | null) =>
            st.reduce<Date | null>((acc, s) => {
              const d = pick(s);
              return d && (!acc || d > acc) ? d : acc;
            }, null);
          push.push({
            storeId,
            storeName: store.name,
            channel: store.channel,
            channelName: channelDisplayName(store.channel),
            state:
              !target || storePaused(toPlanStore(target))
                ? "paused"
                : failing.length > 0
                  ? "failed"
                  : synced
                    ? "synced"
                    : "pending",
            listings: ofStore.length,
            lastPushedAt: latest((s) => s.lastPushedAt),
            lastAttemptAt: latest((s) => s.lastAttemptAt),
            failCount: Math.max(0, ...failing.map((s) => s.pushFailCount)),
            lastError: failing[0]?.lastError ?? null,
          });
        }
        return { variant, rows: rows.filter((r) => r.variantId === variant.variantId), push };
      });
      return { items, more: page.length > limit };
    });
  }
}
