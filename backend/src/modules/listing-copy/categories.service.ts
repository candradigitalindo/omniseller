import { Inject, Injectable } from "@nestjs/common";
import type { CategoryRules } from "@omniseller/connector-core";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { storeIsManual } from "../channel/channel.errors";
import type { StoreRow } from "../channel/channel.repository";
import { isManualChannel, StoresService } from "../channel/stores.service";
import { categoryNotFound } from "./listing-copy.errors";
import { channelCategoryRefreshRequested, channelCategoryRulesRequested } from "./listing-copy.events";
import { type CategoryRow, ListingCopyRepository } from "./listing-copy.repository";

/** A refresh asked for within this time of the last one is not queued again. */
const REFRESH_COOLDOWN_MS = 10 * 60_000;

export const rulesOf = (row: CategoryRow | undefined): CategoryRules | null =>
  row?.rules ? (row.rules as unknown as CategoryRules) : null;

/**
 * Marketplace categories as each store sees them (backend doc 8.25), read from the cache the worker
 * fills (`CategorySyncService`): the api never calls a marketplace. Asking for a category whose rules
 * were never read queues their reading.
 */
@Injectable()
export class CategoriesService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ListingCopyRepository) private readonly repo: ListingCopyRepository,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  /** A store in the caller's scope that has a marketplace behind it. */
  async marketplaceStore(ctx: RequestContext, storeId: string): Promise<StoreRow> {
    const { store } = await this.stores.get(ctx, storeId);
    if (isManualChannel(store.channel)) throw storeIsManual();
    return store;
  }

  /** Top-level categories, the children of one, or a search over full paths. */
  async list(
    ctx: RequestContext,
    storeId: string,
    f: { parentId?: string | undefined; q?: string | undefined; leafOnly?: boolean | undefined },
    limit: number,
  ): Promise<{ items: CategoryRow[]; refreshedAt: Date | null; total: number }> {
    await this.marketplaceStore(ctx, storeId);
    return withTenantTx(this.db, ctx, async (tx) => {
      const stats = await this.repo.categoryStats(tx, storeId);
      return { items: await this.repo.categories(tx, storeId, f, limit), ...stats, total: stats.count };
    });
  }

  /** One category with its rules; rules never read are queued (`rulesPending`). */
  async get(
    ctx: RequestContext,
    storeId: string,
    categoryId: string,
  ): Promise<{ category: CategoryRow; rulesPending: boolean }> {
    await this.marketplaceStore(ctx, storeId);
    return withTenantTx(this.db, ctx, async (tx) => {
      const category = await this.repo.category(tx, storeId, categoryId);
      if (!category) throw categoryNotFound();
      const rulesPending = category.isLeaf && !category.rules;
      if (rulesPending) {
        await this.outbox.enqueue(tx, ctx, channelCategoryRulesRequested, { storeId, categoryId }, storeId);
      }
      return { category, rulesPending };
    });
  }

  /** Reads the tree again from the marketplace, unless that happened in the last 10 minutes. */
  async requestRefresh(
    ctx: RequestContext,
    storeId: string,
  ): Promise<{ requested: boolean; refreshedAt: Date | null }> {
    await this.marketplaceStore(ctx, storeId);
    return withTenantTx(this.db, ctx, async (tx) => {
      const { refreshedAt } = await this.repo.categoryStats(tx, storeId);
      if (refreshedAt && Date.now() - refreshedAt.getTime() < REFRESH_COOLDOWN_MS)
        return { requested: false, refreshedAt };
      await this.outbox.enqueue(tx, ctx, channelCategoryRefreshRequested, { storeId }, storeId);
      return { requested: true, refreshedAt };
    });
  }

  // ---- in the caller's transaction ----

  categoryIn(tx: Tx, storeId: string, categoryId: string): Promise<CategoryRow | undefined> {
    return this.repo.category(tx, storeId, categoryId);
  }

  categoriesIn(tx: Tx, storeId: string, ids: string[]): Promise<Map<string, CategoryRow>> {
    return this.repo.categoriesByIds(tx, storeId, ids);
  }

  /** The seller's earlier choice of target category for a source category, when there is one. */
  async mappedCategoryIn(tx: Tx, sourceChannel: string, sourceCategoryId: string, targetChannel: string) {
    return this.repo.mappingFor(tx, sourceChannel, sourceCategoryId, targetChannel);
  }

  async rememberIn(
    tx: Tx,
    ctx: RequestContext,
    m: {
      sourceChannel: string;
      externalSourceCategoryId: string;
      targetChannel: string;
      externalTargetCategoryId: string;
      targetCategoryPath: string | null;
    },
  ): Promise<void> {
    if (!m.externalSourceCategoryId || !m.externalTargetCategoryId) return;
    // the same marketplace keeps its categories: nothing to learn
    if (m.sourceChannel === m.targetChannel && m.externalSourceCategoryId === m.externalTargetCategoryId) return;
    await this.repo.rememberMapping(tx, ctx.tenantId, m);
  }

  /** FR-INT-07: a store disconnected without its data loses its category cache. */
  deleteStoreCategoriesIn(tx: Tx, storeId: string, limit: number): Promise<number> {
    return this.repo.deleteStoreCategories(tx, storeId, limit);
  }
}
