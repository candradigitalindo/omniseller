import { Inject, Injectable } from "@nestjs/common";
import {
  type CategoryRules,
  type ImageUse,
  isConnectorError,
  type MarketplaceBrand,
  type SourceProduct,
} from "@omniseller/connector-core";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import type { DraftImage, DraftProblem, ListingCopyFailure, listingDraft } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import type { ListingRow } from "../catalog/catalog.repository";
import { ListingSyncService } from "../catalog/listing-sync.service";
import { ListingsService } from "../catalog/listings.service";
import type { StoreRow } from "../channel/channel.repository";
import { MarketplaceGateway } from "../channel/marketplace-gateway";
import { channelDisplayName, StoresService } from "../channel/stores.service";
import { StockComparisonService } from "../inventory/stock-comparison.service";
import { CategoriesService, rulesOf } from "./categories.service";
import { CategorySyncService } from "./category-sync.service";
import {
  draftFromSource,
  mapAttributes,
  normalizeName,
  problemsOf,
  sourceSnapshot,
  toProductToCreate,
} from "./copy-plan";
import { fetchImage, type ImageFetchConfig, ImageFetchError, imageProblem } from "./image-fetch";
import { listingCopyRequested } from "./listing-copy.events";
import { type CopyRow, type DraftRow, ListingCopyRepository } from "./listing-copy.repository";
import { contentOf, ListingCopyService } from "./listing-copy.service";
import { IMAGE_FETCH } from "./listing-copy.tokens";

const log = logger.forModule("listing_copy");

/** Items read and drafted per job; the rest continues in a new job (a whole store takes many). */
export const ITEMS_PER_JOB = 10;
/**
 * A publish run claims its draft and renews the claim at every step (each image, before creating the
 * product); a run that stopped (process killed) leaves it, and BullMQ's retry may take it over after
 * this long. Every step is bounded (rate limit wait 30 s, HTTP timeouts), so a live run renews in time.
 */
export const PUBLISH_LEASE_MS = 3 * 60_000;
/** Items that could not be drafted are listed on the copy up to this many. */
const MAX_FAILURES = 200;
const USABLE = new Set(["active", "token_expiring"]);

type ItemOutcome =
  | { kind: "draft"; row: typeof listingDraft.$inferInsert }
  | { kind: "skipped" }
  | { kind: "failed"; failure: ListingCopyFailure };

interface BatchContext {
  copy: CopyRow;
  source: StoreRow;
  target: StoreRow;
  sourceListings: ListingRow[];
  open: Set<string>;
  published: Map<string, string>;
  listed: Set<string>;
  brands: Map<string, MarketplaceBrand | null>;
  queueJobId: string | undefined;
}

/** Another run of the same publish holds the draft; thrown so that BullMQ tries again later. */
export class PublishBusyError extends Error {
  constructor(draftId: string) {
    super(`listing draft ${draftId} is being published by another run`);
    this.name = "PublishBusyError";
  }
}

const note = (code: string, field: string, message: string): DraftProblem => ({
  code,
  field,
  message,
  blocking: false,
});

/**
 * Worker side of copying listings (PRD FR-PRD-13, backend doc 8.25). Every marketplace call goes through
 * MarketplaceGateway; no transaction is open during one.
 *
 * - prepare: per copy, ten items per job: the source product, the target category (same marketplace:
 *   the same one; another: the seller's earlier choice, else the target's recommendation), its rules,
 *   the brand by name, and the draft with its problems
 * - recheck: drafts whose category the seller changed get that category's rules and attributes
 * - publish: images downloaded from the source's image host and uploaded to the target, the stock
 *   OmniSeller would push, the product created, and its new listings mapped to the source's variants
 */
@Injectable()
export class CopyWorkerService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ListingCopyRepository) private readonly repo: ListingCopyRepository,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(ListingSyncService) private readonly listingSync: ListingSyncService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
    @Inject(CategorySyncService) private readonly categorySync: CategorySyncService,
    @Inject(StockComparisonService) private readonly stock: StockComparisonService,
    @Inject(ListingCopyService) private readonly copies: ListingCopyService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(IMAGE_FETCH) private readonly images: ImageFetchConfig,
  ) {}

  // ---- preparing drafts ----

  /** Prepares the next items of a copy; continues through `listing_copy.requested` while items remain. */
  async prepare(ctx: RequestContext, copyId: string, queueJobId?: string): Promise<"done" | "continued" | "skipped"> {
    const loaded = await withTenantTx(this.db, ctx, async (tx) => {
      const copy = await this.repo.getCopy(tx, copyId);
      if (copy?.status !== "preparing") return null;
      return {
        copy,
        source: await this.stores.rowIn(tx, copy.sourceStoreId),
        target: await this.stores.rowIn(tx, copy.targetStoreId),
        items: await this.nextItems(tx, copy),
      };
    });
    if (!loaded) return "skipped";
    const { copy, source, target, items } = loaded;
    if (!source || !USABLE.has(source.status)) {
      await this.failCopy(ctx, copyId, "Toko asal tidak terhubung. Hubungkan ulang tokonya lalu salin lagi.");
      return "done";
    }
    if (!target || !USABLE.has(target.status)) {
      await this.failCopy(ctx, copyId, "Toko tujuan tidak terhubung. Hubungkan ulang tokonya lalu salin lagi.");
      return "done";
    }
    if (items.length === 0) {
      await this.finishCopy(ctx, copyId);
      return "done";
    }

    await this.categorySync.ensureTree(ctx, target.id, queueJobId);
    // the source's category names help the target recommend one
    if (source.channel !== target.channel) await this.categorySync.ensureTree(ctx, source.id, queueJobId);

    const batch: BatchContext = await withTenantTx(this.db, ctx, async (tx) => {
      const sourceListings = await this.listings.itemListingsIn(tx, source.id, items);
      const mapped = sourceListings.flatMap((l) => (l.variantId ? [l.variantId] : []));
      return {
        copy,
        source,
        target,
        sourceListings,
        open: await this.repo.openDraftItems(tx, target.id, source.id, items),
        published: await this.repo.publishedItems(tx, target.id, source.id, items),
        listed: await this.listings.listedVariantsIn(tx, target.id, mapped),
        brands: new Map(),
        queueJobId,
      };
    });

    for (const itemId of items) {
      const outcome = await this.prepareItem(ctx, batch, itemId);
      const stop = await withTenantTx(this.db, ctx, async (tx) => {
        const now = await this.repo.getCopy(tx, copyId, true);
        if (now?.status !== "preparing") return true;
        let drafted = 0;
        let skipped = 0;
        const failures = [...now.failures];
        if (outcome.kind === "draft") {
          if (await this.repo.insertDraft(tx, outcome.row)) drafted = 1;
          else skipped = 1;
        } else if (outcome.kind === "skipped") skipped = 1;
        else if (failures.length < MAX_FAILURES) failures.push(outcome.failure);
        await this.repo.updateCopy(tx, copyId, {
          cursor: itemId,
          itemsDrafted: now.itemsDrafted + drafted,
          itemsSkipped: now.itemsSkipped + skipped,
          itemsFailed: now.itemsFailed + (outcome.kind === "failed" ? 1 : 0),
          failures,
        });
        return false;
      });
      if (stop) return "done";
    }

    return withTenantTx(this.db, ctx, async (tx) => {
      const now = await this.repo.getCopy(tx, copyId, true);
      if (now?.status !== "preparing") return "done";
      if ((await this.nextItems(tx, now)).length === 0) {
        await this.repo.updateCopy(tx, copyId, { status: "ready", finishedAt: new Date() });
        log.info({ copy_id: copyId, drafted: now.itemsDrafted, failed: now.itemsFailed }, "listing copy prepared");
        return "done";
      }
      await this.outbox.enqueue(tx, ctx, listingCopyRequested, { copyId }, copyId);
      return "continued";
    });
  }

  private async nextItems(tx: Tx, copy: CopyRow): Promise<string[]> {
    if (copy.scope === "items") {
      const start = copy.cursor ? copy.externalItemIds.indexOf(copy.cursor) + 1 : 0;
      return copy.externalItemIds.slice(start, start + ITEMS_PER_JOB);
    }
    return this.listings.storeItemIdsIn(tx, copy.sourceStoreId, copy.cursor, ITEMS_PER_JOB);
  }

  private async prepareItem(ctx: RequestContext, b: BatchContext, itemId: string): Promise<ItemOutcome> {
    const job = b.queueJobId ? { queueJobId: b.queueJobId } : {};
    const titleOf = () => b.sourceListings.find((l) => l.externalItemId === itemId)?.title ?? null;
    if (b.open.has(itemId)) return { kind: "skipped" };
    let product: SourceProduct | null;
    try {
      product = await this.gateway.call(
        ctx,
        b.source.id,
        { kind: "products.get", direction: "pull", request: { item: itemId }, ...job },
        (connector, shop) => connector.products.get(shop, itemId),
        (p) => ({ found: p !== null, variants: p?.variants.length ?? 0, images: p?.images.length ?? 0 }),
      );
    } catch (err) {
      if (isConnectorError(err) && err.kind === "permanent") {
        return { kind: "failed", failure: { externalItemId: itemId, title: titleOf(), reason: err.detail } };
      }
      throw err;
    }
    if (!product) {
      return {
        kind: "failed",
        failure: { externalItemId: itemId, title: titleOf(), reason: "Produk ini tidak ada lagi di toko asal." },
      };
    }
    const variantIds = new Map(
      b.sourceListings.filter((l) => l.externalItemId === itemId).map((l) => [l.externalVariantId, l.variantId]),
    );
    const mapped = product.variants.flatMap((v) => {
      const id = variantIds.get(v.externalVariantId);
      return id ? [id] : [];
    });
    if (
      b.copy.options.skipListed &&
      mapped.length > 0 &&
      mapped.length === product.variants.length &&
      mapped.every((id) => b.listed.has(id))
    ) {
      return { kind: "skipped" };
    }

    const same = b.source.channel === b.target.channel;
    const sourceCategory = product.category.externalId
      ? await withTenantTx(this.db, ctx, (tx) =>
          this.categories.categoryIn(tx, b.source.id, product.category.externalId),
        )
      : undefined;
    const category = {
      externalId: product.category.externalId,
      name: product.category.name ?? sourceCategory?.name ?? null,
      path: product.category.path ?? sourceCategory?.path ?? null,
    };
    let categoryId: string | null = same ? category.externalId || null : null;
    if (!same && category.externalId) {
      const chosen = await withTenantTx(this.db, ctx, (tx) =>
        this.categories.mappedCategoryIn(tx, b.source.channel, category.externalId, b.target.channel),
      );
      categoryId = chosen?.externalTargetCategoryId ?? null;
    }
    if (!same && !categoryId) {
      const suggested = await this.gateway.call(
        ctx,
        b.target.id,
        { kind: "categories.recommend", direction: "pull", request: { item: itemId }, ...job },
        (connector, shop) =>
          connector.products.recommendCategory(shop, {
            title: product.title,
            description: product.description,
            source: {
              categoryId: category.externalId,
              categoryName: category.name,
              categoryPath: category.path,
              brand: product.brand?.name ?? null,
            },
          }),
        (ids) => ({ suggested: ids.length }),
      );
      const known = await withTenantTx(this.db, ctx, (tx) => this.categories.categoriesIn(tx, b.target.id, suggested));
      categoryId = suggested.find((id) => known.get(id)?.isLeaf && known.get(id)?.permitted) ?? null;
    }
    const categoryRow = categoryId
      ? await withTenantTx(this.db, ctx, (tx) => this.categories.categoryIn(tx, b.target.id, categoryId!))
      : undefined;
    const rules = categoryRow?.isLeaf
      ? ((await this.categorySync.rulesFor(ctx, b.target.id, [categoryRow.externalId], b.queueJobId)).get(
          categoryRow.externalId,
        ) ?? null)
      : null;

    const content = draftFromSource({
      source: product,
      sourceChannel: b.source.channel,
      targetChannel: b.target.channel,
      category: categoryId ? { externalId: categoryId, path: categoryRow?.path ?? null } : null,
      rules,
      variantIds,
      priceChangePercent: b.copy.options.priceChangePercent,
    });
    const notes: DraftProblem[] = [];
    if (content.brand?.name && !content.brand.externalId && categoryRow?.isLeaf) {
      const brand = await this.resolveBrand(
        ctx,
        b.target,
        categoryRow.externalId,
        content.brand.name,
        b.brands,
        b.queueJobId,
      );
      if (brand) content.brand = { externalId: brand.externalId, name: brand.name };
      else {
        notes.push(this.brandNote(content.brand.name, b.target.channel));
        content.brand = null;
      }
    }
    const published = b.published.get(itemId);
    if (published !== undefined) {
      notes.push(
        note(
          "already_published",
          "draft",
          `Produk ini sudah pernah diterbitkan ke toko tujuan${published ? ` (ID ${published})` : ""}.`,
        ),
      );
    }
    const listedCount = mapped.filter((id) => b.listed.has(id)).length;
    if (listedCount > 0) {
      notes.push(
        note("already_listed", "variants", `${listedCount} varian produk ini sudah punya listing di toko tujuan.`),
      );
    }
    const problems = problemsOf(content, {
      targetChannel: b.target.channel,
      category: categoryRow ? { isLeaf: categoryRow.isLeaf, permitted: categoryRow.permitted } : null,
      rules,
      readOnly: b.target.syncMode !== "live",
      notes,
    });
    return {
      kind: "draft",
      row: {
        id: newId(),
        tenantId: ctx.tenantId,
        copyId: b.copy.id,
        sourceStoreId: b.source.id,
        targetStoreId: b.target.id,
        externalSourceItemId: itemId,
        status: "draft",
        ...content,
        source: { ...sourceSnapshot(product, b.source.channel, notes), category },
        problems,
      },
    };
  }

  private brandNote(name: string, channel: string): DraftProblem {
    return note(
      "brand_unmatched",
      "brand",
      `Merek "${name}" tidak ditemukan di ${channelDisplayName(channel)} untuk kategori ini; produk dibuat tanpa merek.`,
    );
  }

  /** A selectable brand of the target category with the same name, or null. */
  private async resolveBrand(
    ctx: RequestContext,
    target: StoreRow,
    categoryId: string,
    name: string,
    cache: Map<string, MarketplaceBrand | null>,
    queueJobId?: string,
  ): Promise<MarketplaceBrand | null> {
    const wanted = normalizeName(name);
    const key = `${categoryId}|${wanted}`;
    if (cache.has(key)) return cache.get(key)!;
    let found: MarketplaceBrand | null = null;
    try {
      const list = await this.gateway.call(
        ctx,
        target.id,
        {
          kind: "brands.search",
          direction: "pull",
          request: { category: categoryId },
          ...(queueJobId ? { queueJobId } : {}),
        },
        (connector, shop) => connector.products.brands(shop, { categoryId, name }),
        (l) => ({ brands: l.length }),
      );
      found = list.find((x) => x.selectable && normalizeName(x.name) === wanted) ?? null;
    } catch (err) {
      // a category without a brand list is a brand not found, not a failed copy
      if (!isConnectorError(err) || err.kind !== "permanent") throw err;
    }
    cache.set(key, found);
    return found;
  }

  async failCopy(ctx: RequestContext, copyId: string, message: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const copy = await this.repo.getCopy(tx, copyId, true);
      if (copy?.status !== "preparing") return;
      await this.repo.updateCopy(tx, copyId, { status: "failed", error: message, finishedAt: new Date() });
    });
    log.warn({ copy_id: copyId }, "listing copy failed");
  }

  private async finishCopy(ctx: RequestContext, copyId: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const copy = await this.repo.getCopy(tx, copyId, true);
      if (copy?.status === "preparing")
        await this.repo.updateCopy(tx, copyId, { status: "ready", finishedAt: new Date() });
    });
  }

  // ---- another category ----

  /** Drafts moved to another category: its rules, the source's attributes mapped again, the brand checked. */
  async recheck(ctx: RequestContext, draftIds: string[], queueJobId?: string): Promise<number> {
    const drafts = (await withTenantTx(this.db, ctx, (tx) => this.repo.draftsByIds(tx, draftIds))).filter(
      (d) => d.status === "preparing",
    );
    const byStore = new Map<string, DraftRow[]>();
    for (const d of drafts) byStore.set(d.targetStoreId, [...(byStore.get(d.targetStoreId) ?? []), d]);
    let done = 0;
    for (const [storeId, group] of byStore) {
      const target = await withTenantTx(this.db, ctx, (tx) => this.stores.rowIn(tx, storeId));
      if (!target) continue;
      const ids = [...new Set(group.flatMap((d) => (d.externalCategoryId ? [d.externalCategoryId] : [])))];
      const rules = USABLE.has(target.status)
        ? await this.categorySync.rulesFor(ctx, storeId, ids, queueJobId)
        : new Map<string, CategoryRules>();
      const brands = new Map<string, MarketplaceBrand | null>();
      for (const d of group) {
        const r = d.externalCategoryId ? (rules.get(d.externalCategoryId) ?? null) : null;
        const same = d.source.channel === target.channel;
        const notes = (d.source.notes ?? []).filter((n) => n.code !== "brand_unmatched");
        let brand = d.brand;
        const name = d.brand?.name ?? d.source.brand?.name ?? null;
        if (!same && name && d.externalCategoryId && r && USABLE.has(target.status)) {
          const found = await this.resolveBrand(ctx, target, d.externalCategoryId, name, brands, queueJobId);
          brand = found ? { externalId: found.externalId, name: found.name } : null;
          if (!found) notes.push(this.brandNote(name, target.channel));
        }
        const attributes = r ? mapAttributes(d.source.attributes, r, same) : [];
        await withTenantTx(this.db, ctx, async (tx) => {
          const now = await this.repo.getDraft(tx, d.id, true);
          if (now?.status !== "preparing" || now.externalCategoryId !== d.externalCategoryId) return;
          const next: DraftRow = { ...now, attributes, brand, source: { ...now.source, notes } };
          const problems = await this.copies.problemsIn(tx, next, target);
          await this.repo.updateDraft(tx, d.id, { attributes, brand, source: next.source, problems, status: "draft" });
          done++;
        });
      }
    }
    return done;
  }

  /** The category's rules could not be read: the drafts go back to review with that problem. */
  async recheckGaveUp(ctx: RequestContext, draftIds: string[]): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      for (const d of await this.repo.draftsByIds(tx, draftIds, true)) {
        if (d.status !== "preparing") continue;
        const target = await this.stores.rowIn(tx, d.targetStoreId);
        if (!target) continue;
        const problems = await this.copies.problemsIn(tx, d, target);
        await this.repo.updateDraft(tx, d.id, { problems, status: "draft" });
      }
    });
  }

  // ---- publishing ----

  /**
   * Creates a draft's product in its target store. Permanent refusals fail the draft with the
   * marketplace's words; temporary ones are retried by BullMQ while `willRetry`.
   */
  async publish(
    ctx: RequestContext,
    draftId: string,
    attempt: number,
    queueJobId: string | undefined,
    willRetry: boolean,
  ): Promise<"published" | "failed" | "skipped"> {
    const loaded = await withTenantTx(this.db, ctx, async (tx) => {
      const draft = await this.repo.getDraft(tx, draftId);
      if (draft?.status !== "publishing" || draft.publishAttempt !== attempt) return null;
      // one run per draft; a claim is a column, not a lock held on a pool connection for minutes
      if (!(await this.repo.claimPublish(tx, draftId, attempt, PUBLISH_LEASE_MS))) return "busy" as const;
      return { draft, target: await this.stores.rowIn(tx, draft.targetStoreId) };
    });
    if (!loaded) return "skipped";
    if (loaded === "busy") {
      // another run is publishing it: BullMQ tries again later and then finds it done
      if (willRetry) throw new PublishBusyError(draftId);
      return "skipped";
    }
    const { draft, target } = loaded;
    if (!target || !USABLE.has(target.status)) {
      return this.failDraft(ctx, draftId, "Toko tujuan tidak terhubung. Hubungkan ulang tokonya lalu terbitkan lagi.");
    }
    return this.publishClaimed(ctx, draft, target, queueJobId, willRetry);
  }

  private async publishClaimed(
    ctx: RequestContext,
    draft: DraftRow,
    target: StoreRow,
    queueJobId: string | undefined,
    willRetry: boolean,
  ): Promise<"published" | "failed"> {
    const job = queueJobId ? { queueJobId } : {};
    const channel = channelDisplayName(target.channel);
    const warnings: string[] = [];
    let d = draft;
    try {
      if (target.channel === "tiktokshop") {
        const reasons = await this.gateway.call(
          ctx,
          target.id,
          { kind: "products.prerequisites", direction: "pull", request: {}, ...job },
          (connector, shop) => connector.products.prerequisites(shop),
          (r) => ({ failed: r.length }),
        );
        if (reasons.length > 0) {
          return this.failDraft(ctx, d.id, `Toko belum bisa menambah produk di ${channel}: ${reasons.join("; ")}`);
        }
      }
      d = await this.uploadImages(ctx, d, target, warnings, job);
      if (d.brand?.name && !d.brand.externalId && d.externalCategoryId) {
        const found = await this.resolveBrand(ctx, target, d.externalCategoryId, d.brand.name, new Map(), queueJobId);
        if (!found) warnings.push(this.brandNote(d.brand.name, target.channel).message);
        d = { ...d, brand: found ? { externalId: found.externalId, name: found.name } : null };
      }
      const stock = await withTenantTx(this.db, ctx, (tx) =>
        this.stock.initialStockIn(
          tx,
          target.id,
          d.variants.flatMap((v) => (v.variantId ? [v.variantId] : [])),
        ),
      );
      if (target.channel === "tiktokshop" && !stock.externalWarehouseId) {
        return this.failDraft(
          ctx,
          d.id,
          "Toko tujuan belum punya gudang penjual. Sinkronkan gudang tokonya lalu terbitkan lagi.",
        );
      }
      const quantities = new Map(
        d.variants.map((v) => [v.key, v.variantId ? (stock.quantities.get(v.variantId) ?? 0) : 0]),
      );
      const product = toProductToCreate(
        { ...contentOf(d), id: d.id, publishAttempt: d.publishAttempt, source: d.source },
        target.channel,
        { externalWarehouseId: stock.externalWarehouseId, quantities },
      );
      const resume = d.externalTargetItemId ? { externalItemId: d.externalTargetItemId } : undefined;
      await withTenantTx(this.db, ctx, (tx) => this.repo.updateDraft(tx, d.id, { publishingStartedAt: new Date() }));
      const created = await this.gateway.call(
        ctx,
        target.id,
        {
          kind: "products.create",
          direction: "push",
          request: { variants: product.variants.length, images: product.images.length, resume: resume !== undefined },
          ...job,
        },
        (connector, shop) =>
          connector.products.create(shop, product, resume, {
            // kept at once: a stop before the variants are added must not create the item twice. A
            // failed write does not stop the product half made; a failure after it carries the id too.
            itemCreated: (externalItemId) =>
              this.keepItem(ctx, d.id, externalItemId).catch(() =>
                log.warn({ draft_id: d.id }, "created item not kept yet; kept when the create finishes"),
              ),
          }),
        (r) => ({ item: r.externalItemId, variants: r.variants.length, warnings: r.warnings.length }),
      );
      await withTenantTx(this.db, ctx, async (tx) => {
        await this.repo.updateDraft(tx, d.id, {
          status: "published",
          externalTargetItemId: created.externalItemId,
          publishedAt: new Date(),
          brand: d.brand,
          error: null,
          problems: [...warnings, ...created.warnings].map((m) => note("marketplace_warning", "draft", m)),
        });
        if (d.externalCategoryId) {
          await this.categories.rememberIn(tx, ctx, {
            sourceChannel: d.source.channel,
            externalSourceCategoryId: d.source.category.externalId,
            targetChannel: target.channel,
            externalTargetCategoryId: d.externalCategoryId,
            targetCategoryPath: d.categoryPath,
          });
        }
      });
      const byKey = new Map(d.variants.map((v) => [v.key, v]));
      const pairs = created.variants.flatMap((c) => {
        const variantId = byKey.get(c.key)?.variantId;
        return variantId ? [{ externalVariantId: c.externalVariantId, variantId }] : [];
      });
      try {
        const read = await this.listingSync.refreshCopiedItem(
          ctx,
          target.id,
          created.externalItemId,
          pairs,
          queueJobId,
        );
        log.info({ draft_id: d.id, store_id: target.id, ...read }, "copied listing published");
      } catch (err) {
        // the product exists: the next listing pull reads it and maps it by SKU
        log.warn(
          { draft_id: d.id, store_id: target.id, err_code: isConnectorError(err) ? err.code : "unknown" },
          "published listing not read back yet",
        );
      }
      return "published";
    } catch (err) {
      if (err instanceof ImageFetchError) return this.failDraft(ctx, d.id, err.message);
      if (isConnectorError(err)) {
        if (err.externalItemId) await this.keepItem(ctx, d.id, err.externalItemId);
        if (err.kind === "transient" && willRetry) {
          await this.releaseClaim(ctx, d.id);
          throw err;
        }
        if (err.kind === "transient") {
          return this.failDraft(ctx, d.id, `${channel} sedang bermasalah (${err.detail}). Coba terbitkan lagi nanti.`);
        }
        if (err.kind === "auth_revoked" || err.kind === "auth_expired") {
          return this.failDraft(
            ctx,
            d.id,
            "Izin toko tujuan sudah tidak berlaku. Hubungkan ulang tokonya lalu terbitkan lagi.",
          );
        }
        return this.failDraft(
          ctx,
          d.id,
          err.externalItemId
            ? `${channel} membuat produknya tetapi menolak variasinya: ${err.detail}. Terbitkan lagi untuk melanjutkan.`
            : `${channel} menolak produk ini: ${err.detail}`,
        );
      }
      if (willRetry) {
        await this.releaseClaim(ctx, d.id);
        throw err;
      }
      log.error({ draft_id: d.id, err: (err as Error).message }, "listing draft publish failed");
      return this.failDraft(ctx, d.id, "Gagal menerbitkan. Coba lagi.");
    }
  }

  private async releaseClaim(ctx: RequestContext, draftId: string): Promise<void> {
    await withTenantTx(this.db, ctx, (tx) => this.repo.releasePublish(tx, draftId)).catch(() => undefined);
  }

  /** The item the marketplace already created for a draft (`external_target_item_id`). */
  private async keepItem(ctx: RequestContext, draftId: string, externalItemId: string): Promise<void> {
    await withTenantTx(this.db, ctx, (tx) =>
      this.repo.updateDraft(tx, draftId, { externalTargetItemId: externalItemId }),
    );
  }

  private async failDraft(ctx: RequestContext, draftId: string, message: string): Promise<"failed"> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const d = await this.repo.getDraft(tx, draftId, true);
      if (d?.status === "publishing") await this.repo.updateDraft(tx, draftId, { status: "failed", error: message });
    });
    log.warn({ draft_id: draftId }, "listing draft not published");
    return "failed";
  }

  /**
   * Uploads every image the draft has not uploaded yet, keeping each reference as soon as it is made:
   * gallery images (a refused one fails the draft), option images (a refused one is left out), and the
   * size chart (left out when refused and the category does not require one).
   */
  private async uploadImages(
    ctx: RequestContext,
    draft: DraftRow,
    target: StoreRow,
    warnings: string[],
    job: { queueJobId?: string },
  ): Promise<DraftRow> {
    let d = draft;
    const save = async (patch: Partial<Pick<DraftRow, "images" | "variants" | "sizeChart">>) => {
      d = { ...d, ...patch };
      // each saved upload also renews the publish claim
      await withTenantTx(this.db, ctx, (tx) =>
        this.repo.updateDraft(tx, d.id, { ...patch, publishingStartedAt: new Date() }),
      );
    };
    for (let i = 0; i < d.images.length; i++) {
      if (d.images[i]!.ref) continue;
      const up = await this.upload(ctx, target, d.images[i]!.sourceUrl, "main", `Foto ${i + 1}`, job);
      await save({ images: d.images.map((img, k) => (k === i ? { ...img, ...up } : img)) });
    }
    const urls = [...new Set(d.variants.flatMap((v) => (v.image && !v.image.ref ? [v.image.sourceUrl] : [])))];
    for (const url of urls) {
      let up: Pick<DraftImage, "ref" | "url"> | null = null;
      try {
        up = await this.upload(ctx, target, url, "variant", "Foto varian", job);
      } catch (err) {
        if (!(err instanceof ImageFetchError)) throw err;
        warnings.push(`${err.message} Foto varian ini tidak disertakan.`);
      }
      await save({
        variants: d.variants.map((v) =>
          v.image?.sourceUrl === url ? { ...v, image: up ? { ...v.image, ...up } : null } : v,
        ),
      });
    }
    if (d.sizeChart && !d.sizeChart.ref) {
      try {
        const up = await this.upload(ctx, target, d.sizeChart.sourceUrl, "size_chart", "Tabel ukuran", job);
        await save({ sizeChart: { ...d.sizeChart, ...up } });
      } catch (err) {
        const category = d.externalCategoryId
          ? await withTenantTx(this.db, ctx, (tx) =>
              this.categories.categoryIn(tx, d.targetStoreId, d.externalCategoryId!),
            )
          : undefined;
        if (!(err instanceof ImageFetchError) || rulesOf(category)?.sizeChart.required) throw err;
        warnings.push(`${err.message} Tabel ukuran tidak disertakan.`);
        await save({ sizeChart: null });
      }
    }
    return d;
  }

  private async upload(
    ctx: RequestContext,
    target: StoreRow,
    sourceUrl: string,
    use: ImageUse,
    label: string,
    job: { queueJobId?: string },
  ): Promise<Pick<DraftImage, "ref" | "url">> {
    let img: Awaited<ReturnType<typeof fetchImage>>;
    try {
      img = await fetchImage(sourceUrl, this.images);
    } catch (err) {
      if (err instanceof ImageFetchError) throw new ImageFetchError(err.problem, `${label}: ${err.message}`);
      throw err;
    }
    const problem = imageProblem(img, target.channel, use);
    if (problem) throw new ImageFetchError("format", `${label}: ${problem}`);
    const res = await this.gateway.call(
      ctx,
      target.id,
      { kind: "products.image_upload", direction: "push", request: { use, kind: img.kind }, ...job },
      (connector, shop) =>
        connector.products.uploadImage(shop, { bytes: img.bytes, contentType: img.contentType, use }),
      () => ({ uploaded: 1 }),
    );
    return { ref: res.ref, url: res.url };
  }
}
