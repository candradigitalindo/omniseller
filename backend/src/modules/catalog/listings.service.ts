import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import type { ListingStatus } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { storeNotActive } from "../channel/channel.errors";
import { channelDisplayName, StoresService } from "../channel/stores.service";
import { listingNotFound, variantUnavailable } from "./catalog.errors";
import { listingMapped, listingPullRequested, listingStatusPushRequested, listingUnmapped } from "./catalog.events";
import { CatalogRepository, type ListingRow, type ListingWithVariant, normSku } from "./catalog.repository";
import { ProductsService, type VariantInput } from "./products.service";

/** Shape of channel_listing.channel_data written by the listing pull. */
export interface ListingChannelData {
  itemSku?: string | null;
  variantName?: string | null;
  attributes?: Record<string, string>;
  imageUrl?: string | null;
  itemImageUrls?: string[];
  description?: string | null;
  brand?: string | null;
  categoryPath?: string | null;
  weightG?: number | null;
  dimensionsMm?: { length: number; width: number; height: number } | null;
  stockByWarehouse?: Record<string, number>;
  statusDetail?: Record<string, unknown>;
  updatedAt?: string | null;
}

export interface ListingView {
  listing: ListingWithVariant;
  store: { name: string; channel: string; channelName: string } | null;
}

export interface SuggestionView {
  variantId: string;
  sku: string;
  variantName: string;
  productId: string;
  productName: string;
  score: number;
  reason: "sku" | "name";
}

export interface CreateFromListingsResult {
  created: { productId: string; sku: string; listingIds: string[] }[];
  mappedToExisting: { listingId: string; variantId: string }[];
  failed: { listingIds: string[]; message: string }[];
}

const USABLE = new Set(["active", "token_expiring"]);
const DEFAULT_WEIGHT_G = 100;
const SKU_PREFIX: Record<string, string> = { shopee: "SP", tiktokshop: "TTS" };

export function dataOf(l: Pick<ListingRow, "channelData">): ListingChannelData {
  return (l.channelData ?? {}) as ListingChannelData;
}

/**
 * Marketplace listings and their mapping to master variants (FR-PRD-02, 03, 09, 10). Reads respect
 * the caller's store scope. Changes on the marketplace (status, pull) go through the outbox to the
 * worker; mapping changes emit listing.mapped / listing.unmapped for stock and order consumers.
 */
@Injectable()
export class ListingsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(CatalogRepository) private readonly repo: CatalogRepository,
    @Inject(ProductsService) private readonly products: ProductsService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  private async storeIndex(ctx: RequestContext) {
    const views = await this.stores.list(ctx);
    return new Map(views.map((v) => [v.store.id, v.store]));
  }

  async list(
    ctx: RequestContext,
    filter: {
      storeId?: string | undefined;
      status?: ListingStatus | undefined;
      mapped?: boolean | undefined;
      variantId?: string | undefined;
      q?: string | undefined;
    },
    before: string | undefined,
    limit: number,
  ): Promise<{ items: ListingView[]; more: boolean }> {
    if (filter.storeId && !this.stores.inScope(ctx, filter.storeId)) return { items: [], more: false };
    const stores = await this.storeIndex(ctx);
    return withTenantTx(this.db, ctx, async (tx) => {
      const rows = await this.repo.listListings(tx, { ...filter, scope: ctx.storeScope }, before, limit);
      return {
        more: rows.length > limit,
        items: rows.slice(0, limit).map((l) => ({ listing: l, store: storeInfo(stores.get(l.storeId)) })),
      };
    });
  }

  async get(ctx: RequestContext, id: string): Promise<ListingView> {
    const stores = await this.storeIndex(ctx);
    const listing = await withTenantTx(this.db, ctx, (tx) => this.listingWithVariant(tx, ctx, id));
    return { listing, store: storeInfo(stores.get(listing.storeId)) };
  }

  private async listingWithVariant(tx: Tx, ctx: RequestContext, id: string): Promise<ListingWithVariant> {
    const [l] = await this.repo.listingsByIds(tx, [id]);
    if (!l || !this.stores.inScope(ctx, l.storeId)) throw listingNotFound();
    let variant: ListingWithVariant["variant"] = null;
    if (l.variantId) {
      const [v] = await this.repo.variantsWithProduct(tx, [l.variantId]);
      if (v)
        variant = {
          id: v.variant.id,
          sku: v.variant.sku,
          name: v.variant.name,
          productId: v.variant.productId,
          productName: v.productName,
        };
    }
    return { ...l, variant };
  }

  /**
   * FR-PRD-03: unmapped listings with suggestions. A variant whose SKU matches (ignoring case) comes
   * first; then up to three variants whose product name resembles the listing title (trigram).
   */
  async unmappedWithSuggestions(
    ctx: RequestContext,
    filter: { storeId?: string | undefined; q?: string | undefined },
    before: string | undefined,
    limit: number,
  ): Promise<{ items: (ListingView & { suggestions: SuggestionView[] })[]; more: boolean }> {
    const page = await this.list(ctx, { ...filter, mapped: false }, before, limit);
    return withTenantTx(this.db, ctx, async (tx) => {
      const ids = page.items.map((i) => i.listing.id);
      const byName = await this.repo.nameSuggestions(tx, ids);
      const bySku = await this.repo.variantsByNormSku(
        tx,
        page.items.map((i) => i.listing.externalSku ?? ""),
      );
      const variantIds = [
        ...new Set([...byName.map((s) => s.variantId), ...[...bySku.values()].flat().map((v) => v.id)]),
      ];
      const info = new Map((await this.repo.variantsWithProduct(tx, variantIds)).map((r) => [r.variant.id, r]));
      return {
        more: page.more,
        items: page.items.map((item) => {
          const suggestions: SuggestionView[] = [];
          const add = (variantId: string, score: number, reason: "sku" | "name") => {
            const v = info.get(variantId);
            if (!v || suggestions.some((s) => s.variantId === variantId)) return;
            suggestions.push({
              variantId,
              sku: v.variant.sku,
              variantName: v.variant.name,
              productId: v.variant.productId,
              productName: v.productName,
              score,
              reason,
            });
          };
          for (const v of bySku.get(normSku(item.listing.externalSku) ?? "") ?? []) add(v.id, 1, "sku");
          for (const s of byName.filter((x) => x.listingId === item.listing.id)) add(s.variantId, s.score, "name");
          return { ...item, suggestions };
        }),
      };
    });
  }

  /** Manual mapping (FR-PRD-02), or removing a mapping with `variantId = null`. */
  async map(ctx: RequestContext, listingId: string, variantId: string | null): Promise<ListingView> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const [l] = await this.repo.listingsByIds(tx, [listingId], true);
      if (!l || !this.stores.inScope(ctx, l.storeId)) throw listingNotFound();
      if (variantId) {
        const v = await this.repo.getVariant(tx, variantId);
        if (v?.status !== "active") throw variantUnavailable("variantId");
        if (l.variantId === variantId) return;
        await this.repo.setMapping(tx, l.id, variantId, "manual");
        await this.outbox.enqueue(tx, ctx, listingMapped, { listingId: l.id, variantId, source: "manual" }, l.id);
      } else if (l.variantId) {
        await this.repo.setMapping(tx, l.id, null, null);
        await this.outbox.enqueue(tx, ctx, listingUnmapped, { listingId: l.id, previousVariantId: l.variantId }, l.id);
      }
    });
    return this.get(ctx, listingId);
  }

  /** Maps every unmapped listing whose SKU matches exactly one live variant. */
  async autoMap(ctx: RequestContext, storeId?: string): Promise<number> {
    if (storeId) await this.stores.get(ctx, storeId); // 404 for a store of another tenant or out of scope
    return withTenantTx(this.db, ctx, (tx) => this.autoMapIn(tx, ctx, storeId));
  }

  async autoMapIn(tx: Tx, ctx: RequestContext, storeId?: string): Promise<number> {
    const mapped = await this.repo.autoMapBySku(tx, storeId);
    for (const m of mapped) {
      await this.outbox.enqueue(
        tx,
        ctx,
        listingMapped,
        { listingId: m.listingId, variantId: m.variantId, source: "auto_sku" },
        m.listingId,
      );
    }
    return mapped.length;
  }

  /**
   * Creates master products from unmapped listings: one product per marketplace item, one variant per
   * listing, with the listing's SKU, price, weight, attributes, and images. A listing whose SKU already
   * belongs to a variant is mapped to it instead. Each item is created in its own savepoint, so one
   * conflicting item does not stop the others.
   */
  async createProductsFromListings(ctx: RequestContext, listingIds: string[]): Promise<CreateFromListingsResult> {
    const result: CreateFromListingsResult = { created: [], mappedToExisting: [], failed: [] };
    const stores = await this.storeIndex(ctx);
    await withTenantTx(this.db, ctx, async (tx) => {
      const found = (await this.repo.listingsByIds(tx, listingIds, true)).filter((l) =>
        this.stores.inScope(ctx, l.storeId),
      );
      if (found.length !== new Set(listingIds).size) throw listingNotFound();
      // Already mapped or deleted listings are left alone.
      const rows = found.filter((l) => !l.variantId && l.status !== "deleted");
      const groups = new Map<string, ListingRow[]>();
      for (const l of rows) {
        const key = `${l.storeId}|${l.externalItemId}`;
        groups.set(key, [...(groups.get(key) ?? []), l]);
      }
      const existing = await this.repo.variantsByNormSku(
        tx,
        rows.map((l) => l.externalSku ?? ""),
      );
      for (const group of groups.values()) {
        const toCreate: ListingRow[] = [];
        for (const l of group) {
          const matches = existing.get(normSku(l.externalSku) ?? "") ?? [];
          if (matches.length === 1 && matches[0]!.status === "active") {
            await this.repo.setMapping(tx, l.id, matches[0]!.id, "auto_sku");
            await this.outbox.enqueue(
              tx,
              ctx,
              listingMapped,
              { listingId: l.id, variantId: matches[0]!.id, source: "auto_sku" },
              l.id,
            );
            result.mappedToExisting.push({ listingId: l.id, variantId: matches[0]!.id });
          } else {
            toCreate.push(l);
          }
        }
        if (toCreate.length === 0) continue;
        const channel = stores.get(toCreate[0]!.storeId)?.channel ?? "";
        try {
          await tx.transaction(async (sp) => {
            const input = await this.productInputFrom(sp, toCreate, channel);
            const { productId, variantIds } = await this.products.createIn(sp, ctx, input);
            for (const [i, l] of toCreate.entries()) {
              await this.repo.setMapping(sp, l.id, variantIds[i]!, "created");
              await this.outbox.enqueue(
                sp,
                ctx,
                listingMapped,
                { listingId: l.id, variantId: variantIds[i]!, source: "created" },
                l.id,
              );
            }
            result.created.push({ productId, sku: input.sku, listingIds: toCreate.map((l) => l.id) });
          });
        } catch (err) {
          const detail = (err as { detail?: string }).detail ?? (err as Error).message;
          result.failed.push({ listingIds: toCreate.map((l) => l.id), message: detail });
        }
      }
    });
    return result;
  }

  /** Product SKU: the item's parent SKU, else a channel prefix and the item id; variant SKUs likewise. */
  private async productInputFrom(tx: Tx, listings: ListingRow[], channel: string) {
    const first = listings[0]!;
    const d0 = dataOf(first);
    const fallback = `${SKU_PREFIX[channel] ?? "MP"}-${first.externalItemId}`;
    let sku = d0.itemSku?.trim() || fallback;
    if (await this.repo.productBySku(tx, sku)) sku = fallback;

    const keySets = listings.map((l) => Object.keys(dataOf(l).attributes ?? {}).join("\u0000"));
    const sameKeys = keySets.every((k) => k === keySets[0]);
    const attributeNames = sameKeys ? Object.keys(dataOf(first).attributes ?? {}) : [];
    const combos = new Set(listings.map((l) => JSON.stringify(dataOf(l).attributes ?? {})));
    const useAttributes = attributeNames.length > 0 && combos.size === listings.length;

    const taken = await this.repo.variantsByNormSku(
      tx,
      listings.map((l) => l.externalSku ?? ""),
    );
    const usedInGroup = new Set<string>();
    const variants: VariantInput[] = listings.map((l, i) => {
      const d = dataOf(l);
      let vsku = l.externalSku?.trim() || "";
      const norm = normSku(vsku);
      if (!norm || taken.has(norm) || usedInGroup.has(norm)) vsku = listings.length === 1 ? sku : `${sku}-${i + 1}`;
      usedInGroup.add(normSku(vsku)!);
      return {
        sku: vsku,
        name: d.variantName ?? undefined,
        attributes: useAttributes ? (d.attributes ?? {}) : {},
        basePrice: l.price ?? 0,
        weightG: d.weightG && d.weightG > 0 ? d.weightG : DEFAULT_WEIGHT_G,
        lengthMm: d.dimensionsMm?.length ?? null,
        widthMm: d.dimensionsMm?.width ?? null,
        heightMm: d.dimensionsMm?.height ?? null,
        imageUrl: d.imageUrl && d.imageUrl !== d0.itemImageUrls?.[0] ? d.imageUrl : null,
      };
    });
    return {
      sku,
      name: first.title,
      description: d0.description ?? null,
      brand: d0.brand ?? null,
      categoryPath: d0.categoryPath ?? null,
      attributeNames: useAttributes ? attributeNames : [],
      imageUrls: (d0.itemImageUrls ?? []).slice(0, 9),
      variants,
    };
  }

  /** FR-PRD-10: activate or deactivate whole marketplace items, in bulk, through the worker. */
  async requestStatus(
    ctx: RequestContext,
    listingIds: string[],
    active: boolean,
  ): Promise<{ stores: number; items: number }> {
    const views = await this.storeIndex(ctx);
    return withTenantTx(this.db, ctx, async (tx) => {
      const found = (await this.repo.listingsByIds(tx, listingIds)).filter((l) => this.stores.inScope(ctx, l.storeId));
      if (found.length !== new Set(listingIds).size) throw listingNotFound();
      const rows = found.filter((l) => l.status !== "deleted");
      if (rows.length === 0) throw listingNotFound();
      const byStore = new Map<string, Set<string>>();
      for (const l of rows) {
        const s = views.get(l.storeId);
        if (!s || !USABLE.has(s.status)) throw storeNotActive();
        byStore.set(l.storeId, (byStore.get(l.storeId) ?? new Set()).add(l.externalItemId));
      }
      let items = 0;
      for (const [storeId, set] of byStore) {
        const ids = [...set];
        items += ids.length;
        for (let i = 0; i < ids.length; i += 500) {
          await this.outbox.enqueue(
            tx,
            ctx,
            listingStatusPushRequested,
            { storeId, externalItemIds: ids.slice(i, i + 500), active },
            storeId,
          );
        }
      }
      return { stores: byStore.size, items };
    });
  }

  // ---- for the stock module, inside its transaction (backend doc 9.4) ----

  /** Mapped, not deleted listings of these variants. */
  mappedForVariantsIn(tx: Tx, variantIds: string[]): Promise<ListingRow[]> {
    return this.repo.mappedListings(tx, { variantIds: [...new Set(variantIds)] });
  }

  /** Mapped, not deleted listings of a store, optionally only of some variants. */
  mappedInStoreIn(tx: Tx, storeId: string, variantIds?: string[]): Promise<ListingRow[]> {
    return this.repo.mappedListings(tx, { storeId, ...(variantIds ? { variantIds } : {}) });
  }

  listingsByIdsIn(tx: Tx, ids: string[]): Promise<ListingRow[]> {
    return this.repo.listingsByIds(tx, [...new Set(ids)]);
  }

  /** Pulls listings again: incremental by default, everything (and closing deleted ones) with `full`. */
  async requestPull(ctx: RequestContext, storeId: string, full: boolean): Promise<void> {
    const view = await this.stores.get(ctx, storeId);
    if (!USABLE.has(view.store.status)) throw storeNotActive();
    await withTenantTx(this.db, ctx, (tx) =>
      this.outbox.enqueue(tx, ctx, listingPullRequested, { storeId, mode: full ? "full" : "incremental" }, storeId),
    );
  }
}

function storeInfo(s: { name: string; channel: string } | undefined): ListingView["store"] {
  return s ? { name: s.name, channel: s.channel, channelName: channelDisplayName(s.channel) } : null;
}
