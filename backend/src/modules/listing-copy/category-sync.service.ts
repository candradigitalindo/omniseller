import { Inject, Injectable } from "@nestjs/common";
import type { CategoryRules, MarketplaceCategory } from "@omniseller/connector-core";
import { logger } from "@omniseller/logging";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { MarketplaceGateway } from "../channel/marketplace-gateway";
import { rulesOf } from "./categories.service";
import { type CategoryInput, ListingCopyRepository } from "./listing-copy.repository";

const log = logger.forModule("listing_copy.categories");

/** A category tree older than this is read again before a copy uses it. */
export const TREE_TTL_MS = 7 * 86_400_000;
/** Category rules (attributes, limits) older than this are read again. */
export const RULES_TTL_MS = 7 * 86_400_000;

/** Full paths ("Pakaian Pria > Kaos") from a flat list of categories with parent ids. */
export function categoryPaths(list: MarketplaceCategory[]): CategoryInput[] {
  const byId = new Map(list.map((c) => [c.externalId, c]));
  const paths = new Map<string, string>();
  const pathOf = (c: MarketplaceCategory, depth = 0): string => {
    const known = paths.get(c.externalId);
    if (known !== undefined) return known;
    const parent = c.parentExternalId ? byId.get(c.parentExternalId) : undefined;
    // a parent missing from the list, or a loop, ends the path there
    const path = parent && depth < 12 ? `${pathOf(parent, depth + 1)} > ${c.name}` : c.name;
    paths.set(c.externalId, path);
    return path;
  };
  return list.map((c) => ({
    externalId: c.externalId,
    externalParentId: c.parentExternalId && byId.has(c.parentExternalId) ? c.parentExternalId : null,
    name: c.name,
    path: pathOf(c),
    isLeaf: c.isLeaf,
    permitted: c.permitted,
  }));
}

/**
 * Worker side of the category cache (backend doc 8.25): reads a store's category tree and the rules of
 * its leaf categories through MarketplaceGateway, and keeps them in `channel_category`.
 */
@Injectable()
export class CategorySyncService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ListingCopyRepository) private readonly repo: ListingCopyRepository,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
  ) {}

  /** Reads the whole tree; categories the marketplace no longer lists are removed. Returns how many. */
  async refresh(ctx: RequestContext, storeId: string, queueJobId?: string): Promise<number> {
    const startedAt = new Date();
    const list = await this.gateway.call(
      ctx,
      storeId,
      { kind: "categories.pull", direction: "pull", request: {}, ...(queueJobId ? { queueJobId } : {}) },
      (connector, shop) => connector.products.categories(shop),
      (l) => ({ categories: l.length, leaves: l.filter((c) => c.isLeaf).length }),
    );
    const rows = categoryPaths(list);
    await withTenantTx(this.db, ctx, async (tx) => {
      await this.repo.upsertCategories(tx, ctx.tenantId, storeId, rows, startedAt);
      // an empty answer is a marketplace hiccup, not a store without categories
      if (rows.length > 0) await this.repo.deleteUnseenCategories(tx, storeId, startedAt);
    });
    log.info({ store_id: storeId, categories: rows.length }, "category tree refreshed");
    return rows.length;
  }

  /** The tree, read again when it was never read or is older than TREE_TTL_MS. */
  async ensureTree(ctx: RequestContext, storeId: string, queueJobId?: string): Promise<void> {
    const stats = await withTenantTx(this.db, ctx, (tx) => this.repo.categoryStats(tx, storeId));
    if (stats.count > 0 && stats.refreshedAt && Date.now() - stats.refreshedAt.getTime() < TREE_TTL_MS) return;
    await this.refresh(ctx, storeId, queueJobId);
  }

  /**
   * Rules of leaf categories, from the cache when fresh, otherwise read from the marketplace and kept.
   * Categories missing from the cache are left out of the answer.
   */
  async rulesFor(
    ctx: RequestContext,
    storeId: string,
    categoryIds: string[],
    queueJobId?: string,
  ): Promise<Map<string, CategoryRules>> {
    const ids = [...new Set(categoryIds.filter(Boolean))];
    const out = new Map<string, CategoryRules>();
    if (ids.length === 0) return out;
    const cached = await withTenantTx(this.db, ctx, (tx) => this.repo.categoriesByIds(tx, storeId, ids));
    const stale: string[] = [];
    for (const id of ids) {
      const row = cached.get(id);
      if (!row?.isLeaf) continue;
      const rules = rulesOf(row);
      if (rules && row.rulesReadAt && Date.now() - row.rulesReadAt.getTime() < RULES_TTL_MS) out.set(id, rules);
      else stale.push(id);
    }
    if (stale.length === 0) return out;
    const read = await this.gateway.call(
      ctx,
      storeId,
      {
        kind: "categories.rules",
        direction: "pull",
        request: { categories: stale.length },
        ...(queueJobId ? { queueJobId } : {}),
      },
      (connector, shop) => connector.products.categoryRules(shop, stale),
      (r) => ({ categories: r.length, attributes: r.reduce((n, x) => n + x.attributes.length, 0) }),
    );
    const at = new Date();
    await withTenantTx(this.db, ctx, async (tx) => {
      for (const rules of read) {
        await this.repo.saveRules(tx, storeId, rules.categoryId, rules as unknown as Record<string, unknown>, at);
      }
    });
    for (const rules of read) out.set(rules.categoryId, rules);
    return out;
  }
}
