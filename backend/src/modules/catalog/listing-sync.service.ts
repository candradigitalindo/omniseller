import { Inject, Injectable } from "@nestjs/common";
import type { ListingPage, ListingStatusResult, NormalizedListing } from "@omniseller/connector-core";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { MarketplaceGateway } from "../channel/marketplace-gateway";
import { StoresService } from "../channel/stores.service";
import { SyncLogService } from "../sync/sync-log.service";
import { listingPullRequested } from "./catalog.events";
import { CatalogRepository } from "./catalog.repository";
import { type ListingChannelData, ListingsService } from "./listings.service";

const log = logger.forModule("catalog.sync");

/** Pages per job; a larger catalog continues in a new job, so a restart only repeats one batch. */
export const PAGES_PER_JOB = 10;
/** Incremental pulls look back a little before the last pull started, to cover clock skew. */
const OVERLAP_MS = 10 * 60_000;
const USABLE = new Set(["active", "token_expiring"]);

export interface PullInput {
  storeId: string;
  mode: "full" | "incremental";
  cursor?: string | undefined;
  startedAt?: string | undefined;
  since?: string | undefined;
}

export interface PullOutcome {
  pages: number;
  listings: number;
  done: boolean;
  closed: number;
  autoMapped: number;
}

function channelData(l: NormalizedListing): ListingChannelData {
  return {
    itemSku: l.itemSku,
    variantName: l.variantName,
    attributes: l.attributes,
    imageUrl: l.imageUrl,
    itemImageUrls: l.itemImageUrls,
    description: l.description,
    brand: l.brand,
    categoryPath: l.categoryPath,
    weightG: l.weightG,
    dimensionsMm: l.dimensionsMm,
    stockByWarehouse: l.stockByWarehouse,
    statusDetail: l.statusDetail,
    updatedAt: l.updatedAt?.toISOString() ?? null,
  };
}

/**
 * Worker side of the catalog (FR-INT-04, FR-PRD-02, 09, 10): pulls listings from the marketplace,
 * refreshes single items after a webhook, and pushes activate / deactivate. Every marketplace call
 * goes through MarketplaceGateway (rate limit, sync log, token refresh).
 */
@Injectable()
export class ListingSyncService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(CatalogRepository) private readonly repo: CatalogRepository,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(SyncLogService) private readonly syncLog: SyncLogService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  private async usable(ctx: RequestContext, storeId: string): Promise<boolean> {
    try {
      return USABLE.has((await this.stores.get(ctx, storeId)).store.status);
    } catch {
      return false;
    }
  }

  /**
   * A full pull (after connecting, or on request) reads every item and, on its last page, closes the
   * listings it did not see. An incremental pull (every 6 hours) reads items changed since the last
   * pull. Up to PAGES_PER_JOB pages run in one job; the rest continues through `listing.pull_requested`.
   */
  async pull(ctx: RequestContext, input: PullInput, queueJobId?: string): Promise<PullOutcome | null> {
    if (!(await this.usable(ctx, input.storeId))) {
      await this.syncLog.skipped(
        ctx,
        { storeId: input.storeId, kind: "listings.pull", direction: "pull" },
        "Toko tidak terhubung.",
      );
      return null;
    }
    const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
    let mode = input.mode;
    let since = input.since ? new Date(input.since) : null;
    if (mode === "incremental" && !since) {
      const last = await this.stores.syncCursor(ctx, input.storeId, "listings");
      if (last) since = new Date(new Date(last).getTime() - OVERLAP_MS);
      else mode = "full";
    }
    if (mode === "full") since = null;

    let cursor: string | null = input.cursor ?? null;
    const outcome: PullOutcome = { pages: 0, listings: 0, done: false, closed: 0, autoMapped: 0 };
    while (outcome.pages < PAGES_PER_JOB) {
      const page = await this.gateway.call(
        ctx,
        input.storeId,
        { kind: "listings.pull", direction: "pull", request: { mode, cursor }, ...(queueJobId ? { queueJobId } : {}) },
        (connector, shop) => connector.catalog.listListings(shop, { cursor, updatedSince: since }),
        (p) => ({ items: p.itemCount, listings: p.listings.length, deleted: p.deletedItemIds.length }),
      );
      await this.apply(ctx, input.storeId, page, startedAt);
      outcome.pages++;
      outcome.listings += page.listings.length;
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    if (cursor) {
      await withTenantTx(this.db, ctx, (tx) =>
        this.outbox.enqueue(
          tx,
          ctx,
          listingPullRequested,
          {
            storeId: input.storeId,
            mode,
            cursor,
            startedAt: startedAt.toISOString(),
            ...(since ? { since: since.toISOString() } : {}),
          },
          input.storeId,
        ),
      );
      return outcome;
    }

    await withTenantTx(this.db, ctx, async (tx) => {
      if (mode === "full") outcome.closed = await this.repo.closeUnseen(tx, input.storeId, startedAt);
      outcome.autoMapped = await this.listings.autoMapIn(tx, ctx, input.storeId);
    });
    await this.stores.recordPull(ctx, input.storeId, "listings", startedAt.toISOString());
    outcome.done = true;
    log.info({ store_id: input.storeId, mode, ...outcome }, "listing pull finished");
    return outcome;
  }

  /** Upserts the page and closes deleted items and removed variants, in one transaction. */
  async apply(ctx: RequestContext, storeId: string, page: ListingPage, at: Date): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      await this.repo.upsertListings(
        tx,
        page.listings.map((l) => ({
          id: newId(),
          tenantId: ctx.tenantId,
          storeId,
          externalItemId: l.externalItemId,
          externalVariantId: l.externalVariantId,
          externalSku: l.sku,
          title: l.title,
          price: l.price,
          originalPrice: l.originalPrice,
          status: l.status,
          stockAtChannel: l.stock,
          channelData: channelData(l) as Record<string, unknown>,
          lastPulledAt: at,
        })),
      );
      await this.repo.markItemsDeleted(tx, storeId, page.deletedItemIds, at);
      const variantsByItem = new Map<string, string[]>();
      for (const l of page.listings) {
        variantsByItem.set(l.externalItemId, [...(variantsByItem.get(l.externalItemId) ?? []), l.externalVariantId]);
      }
      for (const [itemId, variantIds] of variantsByItem) {
        await this.repo.closeMissingVariants(tx, storeId, itemId, variantIds, at);
      }
    });
  }

  /** Re-reads specific items (after a webhook or a status change) and maps new SKUs. */
  async refreshItems(
    ctx: RequestContext,
    storeId: string,
    externalItemIds: string[],
    queueJobId?: string,
  ): Promise<number> {
    const ids = [...new Set(externalItemIds)].filter(Boolean);
    if (ids.length === 0 || !(await this.usable(ctx, storeId))) return 0;
    const page = await this.gateway.call(
      ctx,
      storeId,
      {
        kind: "listings.refresh",
        direction: "pull",
        request: { items: ids.length },
        ...(queueJobId ? { queueJobId } : {}),
      },
      (connector, shop) => connector.catalog.getListings(shop, ids),
      (p) => ({ listings: p.listings.length, deleted: p.deletedItemIds.length }),
    );
    await this.apply(ctx, storeId, page, new Date());
    await withTenantTx(this.db, ctx, (tx) => this.listings.autoMapIn(tx, ctx, storeId));
    return page.listings.length;
  }

  /** FR-PRD-10: activates or deactivates items, then reads them back to show the marketplace's answer. */
  async pushStatus(
    ctx: RequestContext,
    input: { storeId: string; externalItemIds: string[]; active: boolean },
    queueJobId?: string,
  ): Promise<ListingStatusResult[] | null> {
    if (!(await this.usable(ctx, input.storeId))) {
      await this.syncLog.skipped(
        ctx,
        { storeId: input.storeId, kind: "listings.status_push", direction: "push" },
        "Toko tidak terhubung.",
      );
      return null;
    }
    const results = await this.gateway.call(
      ctx,
      input.storeId,
      {
        kind: "listings.status_push",
        direction: "push",
        request: { active: input.active, items: input.externalItemIds.length },
        ...(queueJobId ? { queueJobId } : {}),
      },
      (connector, shop) => connector.catalog.setListingStatus(shop, input.externalItemIds, input.active),
      (r) => ({ ok: r.filter((x) => x.ok).length, failed: r.filter((x) => !x.ok) }),
    );
    await this.refreshItems(
      ctx,
      input.storeId,
      results.filter((r) => r.ok).map((r) => r.externalItemId),
      queueJobId,
    );
    return results;
  }
}
