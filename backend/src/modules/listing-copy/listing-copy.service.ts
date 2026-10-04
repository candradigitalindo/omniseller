import { Inject, Injectable } from "@nestjs/common";
import type { CategoryRules } from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import { claimIdempotencyKey, requestHash } from "../../common/idempotency";
import type { DbHandle, Tx } from "../../db/client";
import type { DraftAttribute, DraftProblem, ListingCopyOptions } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { listingNotFound } from "../catalog/catalog.errors";
import { ListingsService } from "../catalog/listings.service";
import { storeIsManual, storeNotActive } from "../channel/channel.errors";
import type { StoreRow } from "../channel/channel.repository";
import { isManualChannel, StoresService } from "../channel/stores.service";
import { CategoriesService, rulesOf } from "./categories.service";
import { type DraftContent, hasBlocking, problemsOf } from "./copy-plan";
import {
  attributeNotInCategory,
  categoryUnusable,
  copyNotFound,
  copyNotPreparing,
  draftNotEditable,
  draftNotFound,
  draftStale,
  imageNotInDraft,
  listingsOfAnotherStore,
  sameStore,
  variantKeyUnknown,
  variationsFixed,
} from "./listing-copy.errors";
import {
  listingCopyRequested,
  listingDraftPublishRequested,
  listingDraftRecheckRequested,
} from "./listing-copy.events";
import { type CopyRow, type DraftRow, ListingCopyRepository } from "./listing-copy.repository";

const USABLE = new Set(["active", "token_expiring"]);
const EDITABLE = new Set(["draft", "failed"]);

export interface CopyInput {
  sourceStoreId: string;
  listingIds?: string[] | undefined;
  targetStoreIds: string[];
  priceChangePercent: number;
  skipListed: boolean;
}

export interface CopyView {
  copy: CopyRow;
  drafts: Record<string, number>;
}

export interface DraftPatch {
  title?: string | undefined;
  description?: string | undefined;
  brand?: { name: string } | null | undefined;
  attributes?:
    | {
        attributeId: string;
        values: {
          valueId?: string | null | undefined;
          name?: string | null | undefined;
          unit?: string | null | undefined;
        }[];
      }[]
    | undefined;
  images?: string[] | undefined;
  weightG?: number | undefined;
  dimensionsMm?: { length: number; width: number; height: number } | null | undefined;
  condition?: "new" | "used" | undefined;
  preOrderDays?: number | null | undefined;
  itemSku?: string | null | undefined;
  variationNames?: string[] | undefined;
  variants?:
    | { key: string; sku?: string | null | undefined; price?: number | undefined; options?: string[] | undefined }[]
    | undefined;
}

export interface PublishOutcome {
  queued: string[];
  refused: { draftId: string; code: string; message: string }[];
}

/** The draft's editable content, as the plan sees it. */
export function contentOf(d: DraftRow): DraftContent {
  return {
    title: d.title,
    description: d.description,
    descriptionHtml: d.descriptionHtml,
    externalCategoryId: d.externalCategoryId,
    categoryPath: d.categoryPath,
    brand: d.brand,
    attributes: d.attributes,
    images: d.images,
    sizeChart: d.sizeChart,
    weightG: d.weightG,
    dimensionsMm: d.dimensionsMm,
    condition: d.condition,
    preOrderDays: d.preOrderDays,
    itemSku: d.itemSku,
    variationNames: d.variationNames,
    variants: d.variants,
  };
}

/**
 * Copying listings between the seller's own stores (PRD FR-PRD-13, backend doc 8.25), api side: a copy
 * of some listings or of a whole store into drafts for each target store, prepared by the worker; the
 * drafts are reviewed and edited here and published through the worker. Copies and drafts exist for a
 * user only while both their stores are in the user's scope.
 */
@Injectable()
export class ListingCopyService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ListingCopyRepository) private readonly repo: ListingCopyRepository,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(CategoriesService) private readonly categories: CategoriesService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  private visible(ctx: RequestContext, row: { sourceStoreId: string; targetStoreId: string }): boolean {
    return this.stores.inScope(ctx, row.sourceStoreId) && this.stores.inScope(ctx, row.targetStoreId);
  }

  /** A connected marketplace store in the caller's scope. */
  private async usableStore(ctx: RequestContext, storeId: string): Promise<StoreRow> {
    const { store } = await this.stores.get(ctx, storeId);
    if (isManualChannel(store.channel)) throw storeIsManual();
    if (!USABLE.has(store.status)) throw storeNotActive();
    return store;
  }

  // ---- copies ----

  /**
   * One copy per target store, prepared by the worker. Without `listingIds` the whole source store is
   * copied. With an Idempotency-Key a repeated request returns the copies of the first one.
   */
  async create(
    ctx: RequestContext,
    input: CopyInput,
    idempotencyKey?: string,
  ): Promise<{ copies: CopyView[]; created: boolean }> {
    const targets = [...new Set(input.targetStoreIds)];
    if (targets.includes(input.sourceStoreId)) throw sameStore();
    await this.usableStore(ctx, input.sourceStoreId);
    for (const id of targets) await this.usableStore(ctx, id);
    const options: ListingCopyOptions = { priceChangePercent: input.priceChangePercent, skipListed: input.skipListed };
    const ids = targets.map(() => newId()).sort();
    const result = await withTenantTx(this.db, ctx, async (tx) => {
      if (idempotencyKey) {
        const earlier = await claimIdempotencyKey(tx, ctx, {
          scope: "listing_copy.create",
          key: idempotencyKey,
          hash: requestHash(input),
          resourceId: ids[0]!,
        });
        if (earlier) {
          const first = await this.repo.getCopy(tx, earlier);
          if (!first) throw copyNotFound();
          return { rows: await this.repo.copiesMadeWith(tx, first), created: false };
        }
      }
      let itemIds: string[] = [];
      if (input.listingIds) {
        const found = await this.listings.listingsByIdsIn(tx, input.listingIds);
        if (
          found.length !== new Set(input.listingIds).size ||
          found.some((l) => !this.stores.inScope(ctx, l.storeId))
        ) {
          throw listingNotFound();
        }
        if (found.some((l) => l.storeId !== input.sourceStoreId)) throw listingsOfAnotherStore();
        itemIds = [...new Set(found.filter((l) => l.status !== "deleted").map((l) => l.externalItemId))];
        if (itemIds.length === 0) throw listingNotFound();
      }
      const total = input.listingIds ? itemIds.length : await this.listings.storeItemCountIn(tx, input.sourceStoreId);
      const rows = targets.map((targetStoreId, i) => ({
        id: ids[i]!,
        tenantId: ctx.tenantId,
        sourceStoreId: input.sourceStoreId,
        targetStoreId,
        scope: (input.listingIds ? "items" : "store") as "items" | "store",
        externalItemIds: itemIds,
        options,
        itemsTotal: total,
        createdBy: ctx.actor.type === "user" ? ctx.actor.id : null,
      }));
      await this.repo.insertCopies(tx, rows);
      for (const r of rows) await this.outbox.enqueue(tx, ctx, listingCopyRequested, { copyId: r.id }, r.id);
      const created = await this.repo.copiesMadeWith(tx, (await this.repo.getCopy(tx, ids[0]!))!);
      return { rows: created, created: true };
    });
    const counts = await withTenantTx(this.db, ctx, (tx) =>
      this.repo.draftCounts(
        tx,
        result.rows.map((c) => c.id),
      ),
    );
    return {
      copies: result.rows.map((copy) => ({ copy, drafts: counts.get(copy.id) ?? {} })),
      created: result.created,
    };
  }

  async list(
    ctx: RequestContext,
    f: { targetStoreId?: string | undefined; sourceStoreId?: string | undefined; status?: string | undefined },
    before: string | undefined,
    limit: number,
  ): Promise<{ items: CopyView[]; more: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const rows = await this.repo.listCopies(tx, { ...f, scope: ctx.storeScope }, before, limit);
      const page = rows.slice(0, limit);
      const counts = await this.repo.draftCounts(
        tx,
        page.map((c) => c.id),
      );
      return { items: page.map((copy) => ({ copy, drafts: counts.get(copy.id) ?? {} })), more: rows.length > limit };
    });
  }

  async get(ctx: RequestContext, id: string): Promise<CopyView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const copy = await this.repo.getCopy(tx, id);
      if (!copy || !this.visible(ctx, copy)) throw copyNotFound();
      return { copy, drafts: (await this.repo.draftCounts(tx, [id])).get(id) ?? {} };
    });
  }

  /** Stops preparing a copy (a whole store takes a while); drafts made so far stay. */
  async cancel(ctx: RequestContext, id: string): Promise<CopyView> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const copy = await this.repo.getCopy(tx, id, true);
      if (!copy || !this.visible(ctx, copy)) throw copyNotFound();
      if (copy.status !== "preparing") throw copyNotPreparing();
      await this.repo.updateCopy(tx, id, { status: "cancelled", finishedAt: new Date() });
    });
    return this.get(ctx, id);
  }

  // ---- drafts ----

  async listDrafts(
    ctx: RequestContext,
    f: {
      copyId?: string | undefined;
      targetStoreId?: string | undefined;
      status?: string | undefined;
      q?: string | undefined;
      blocking?: boolean | undefined;
    },
    before: string | undefined,
    limit: number,
  ): Promise<{ items: DraftRow[]; more: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const rows = await this.repo.listDrafts(tx, { ...f, scope: ctx.storeScope }, before, limit);
      return { items: rows.slice(0, limit), more: rows.length > limit };
    });
  }

  async getDraft(ctx: RequestContext, id: string): Promise<DraftRow> {
    return withTenantTx(this.db, ctx, (tx) => this.draftIn(tx, ctx, id));
  }

  private async draftIn(tx: Tx, ctx: RequestContext, id: string, forUpdate = false): Promise<DraftRow> {
    const d = await this.repo.getDraft(tx, id, forUpdate);
    if (!d || !this.visible(ctx, d)) throw draftNotFound();
    return d;
  }

  /**
   * The draft's problems against its category and the target store, in the caller's transaction (also
   * used by the worker after preparing).
   */
  async problemsIn(tx: Tx, d: DraftRow, target: StoreRow): Promise<DraftProblem[]> {
    const category = d.externalCategoryId
      ? await this.categories.categoryIn(tx, d.targetStoreId, d.externalCategoryId)
      : undefined;
    return problemsOf(contentOf(d), {
      targetChannel: target.channel,
      category: category ? { isLeaf: category.isLeaf, permitted: category.permitted } : null,
      rules: rulesOf(category),
      readOnly: target.syncMode !== "live",
      notes: d.source.notes ?? [],
    });
  }

  /** Edits a reviewed draft (UI "Tinjau draf"); a failed draft becomes a draft again. */
  async updateDraft(ctx: RequestContext, id: string, patch: DraftPatch, ifMatch?: number): Promise<DraftRow> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const d = await this.draftIn(tx, ctx, id, true);
      if (!EDITABLE.has(d.status)) throw draftNotEditable(d.status);
      if (ifMatch !== undefined && ifMatch !== d.rowVersion) throw draftStale();
      const category = d.externalCategoryId
        ? await this.categories.categoryIn(tx, d.targetStoreId, d.externalCategoryId)
        : undefined;
      const next = applyPatch(d, patch, rulesOf(category));
      const target = (await this.stores.rowIn(tx, d.targetStoreId))!;
      const updated: DraftRow = { ...d, ...next };
      const problems = await this.problemsIn(tx, updated, target);
      await this.repo.updateDraft(tx, id, { ...next, problems, ...(d.status === "failed" ? { status: "draft" } : {}) });
      return (await this.repo.getDraft(tx, id))!;
    });
  }

  /** Deletes a draft that is not being worked on; a published one only leaves the list. */
  async deleteDraft(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const d = await this.draftIn(tx, ctx, id, true);
      if (d.status === "preparing" || d.status === "publishing") throw draftNotEditable(d.status);
      await this.repo.deleteDraft(tx, id);
    });
  }

  /**
   * Moves drafts of one target store to another category (UI "Ubah kategori massal"). The worker reads
   * the category's rules and maps each source's attributes to it again; the choice is remembered for the
   * next copy from the same source category.
   */
  async setCategory(ctx: RequestContext, draftIds: string[], categoryId: string): Promise<{ updated: number }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const drafts = await this.repo.draftsByIds(tx, draftIds, true);
      if (drafts.length !== new Set(draftIds).size || drafts.some((d) => !this.visible(ctx, d))) throw draftNotFound();
      const stores = new Set(drafts.map((d) => d.targetStoreId));
      if (stores.size !== 1) {
        throw categoryUnusable("Draf yang dipilih harus untuk toko tujuan yang sama.");
      }
      const targetStoreId = drafts[0]!.targetStoreId;
      const category = await this.categories.categoryIn(tx, targetStoreId, categoryId);
      if (!category) throw categoryUnusable("Kategori tidak ditemukan di toko tujuan. Muat ulang daftar kategori.");
      if (!category.isLeaf) throw categoryUnusable("Pilih kategori paling akhir (tanpa subkategori).");
      if (!category.permitted) throw categoryUnusable("Toko tujuan belum diizinkan berjualan di kategori ini.");
      const target = (await this.stores.rowIn(tx, targetStoreId))!;
      for (const d of drafts) {
        if (!EDITABLE.has(d.status)) throw draftNotEditable(d.status);
      }
      for (const d of drafts) {
        await this.repo.updateDraft(tx, d.id, {
          externalCategoryId: categoryId,
          categoryPath: category.path,
          attributes: [],
          status: "preparing",
        });
        await this.categories.rememberIn(tx, ctx, {
          sourceChannel: d.source.channel,
          externalSourceCategoryId: d.source.category.externalId,
          targetChannel: target.channel,
          externalTargetCategoryId: categoryId,
          targetCategoryPath: category.path,
        });
      }
      const ids = drafts.map((d) => d.id);
      for (let i = 0; i < ids.length; i += 100) {
        await this.outbox.enqueue(tx, ctx, listingDraftRecheckRequested, { draftIds: ids.slice(i, i + 100) }, ids[i]!);
      }
      return { updated: drafts.length };
    });
  }

  /**
   * Sets one attribute on many drafts at once (TikTok Shop's "Barang Impor", for example). Drafts whose
   * category has no such attribute, or that are not editable, are skipped with the reason.
   */
  async setAttribute(
    ctx: RequestContext,
    input: {
      draftIds: string[];
      attributeId: string;
      values: {
        valueId?: string | null | undefined;
        name?: string | null | undefined;
        unit?: string | null | undefined;
      }[];
    },
  ): Promise<{ updated: string[]; skipped: { draftId: string; reason: string }[] }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const drafts = await this.repo.draftsByIds(tx, input.draftIds, true);
      if (drafts.length !== new Set(input.draftIds).size || drafts.some((d) => !this.visible(ctx, d))) {
        throw draftNotFound();
      }
      const updated: string[] = [];
      const skipped: { draftId: string; reason: string }[] = [];
      const targets = new Map<string, StoreRow>();
      for (const d of drafts) {
        if (!EDITABLE.has(d.status)) {
          skipped.push({ draftId: d.id, reason: "Draf sedang diproses atau sudah diterbitkan." });
          continue;
        }
        const category = d.externalCategoryId
          ? await this.categories.categoryIn(tx, d.targetStoreId, d.externalCategoryId)
          : undefined;
        const rules = rulesOf(category);
        if (!rules?.attributes.some((a) => a.externalId === input.attributeId)) {
          skipped.push({ draftId: d.id, reason: "Kategori draf ini tidak punya atribut tersebut." });
          continue;
        }
        let attributes: DraftAttribute[];
        try {
          attributes = withAttribute(d.attributes, rules, input.attributeId, input.values, "values");
        } catch (err) {
          const issue = (err as { errors?: { message: string }[] }).errors?.[0]?.message;
          skipped.push({ draftId: d.id, reason: issue ?? "Nilai atribut tidak valid." });
          continue;
        }
        if (!targets.has(d.targetStoreId))
          targets.set(d.targetStoreId, (await this.stores.rowIn(tx, d.targetStoreId))!);
        const problems = await this.problemsIn(tx, { ...d, attributes }, targets.get(d.targetStoreId)!);
        await this.repo.updateDraft(tx, d.id, {
          attributes,
          problems,
          ...(d.status === "failed" ? { status: "draft" } : {}),
        });
        updated.push(d.id);
      }
      return { updated, skipped };
    });
  }

  /**
   * Queues drafts to be created in their target stores (FR-PRD-13 "Terbitkan"). A draft is refused while
   * it has blocking problems, is not reviewed yet, or its target store is not connected.
   */
  async publish(ctx: RequestContext, draftIds: string[]): Promise<PublishOutcome> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const drafts = await this.repo.draftsByIds(tx, draftIds, true);
      if (drafts.length !== new Set(draftIds).size || drafts.some((d) => !this.visible(ctx, d))) throw draftNotFound();
      const out: PublishOutcome = { queued: [], refused: [] };
      const targets = new Map<string, StoreRow | undefined>();
      for (const d of drafts) {
        if (!targets.has(d.targetStoreId)) targets.set(d.targetStoreId, await this.stores.rowIn(tx, d.targetStoreId));
        const target = targets.get(d.targetStoreId);
        if (!EDITABLE.has(d.status)) {
          out.refused.push({
            draftId: d.id,
            code: "listing_draft.not_editable",
            message: d.status === "published" ? "Sudah diterbitkan." : "Sedang diproses.",
          });
          continue;
        }
        if (!target || !USABLE.has(target.status)) {
          out.refused.push({ draftId: d.id, code: "store.not_active", message: "Toko tujuan tidak terhubung." });
          continue;
        }
        const problems = await this.problemsIn(tx, d, target);
        if (hasBlocking(problems)) {
          await this.repo.updateDraft(tx, d.id, { problems });
          out.refused.push({
            draftId: d.id,
            code: "listing_draft.has_problems",
            message: `Perbaiki dulu: ${problems.find((p) => p.blocking)!.message}`,
          });
          continue;
        }
        const attempt = d.publishAttempt + 1;
        await this.repo.updateDraft(tx, d.id, {
          status: "publishing",
          problems,
          publishAttempt: attempt,
          // the worker claims the draft when it starts (CopyWorkerService.publish)
          publishingStartedAt: null,
          publishedBy: ctx.actor.type === "user" ? ctx.actor.id : null,
          error: null,
        });
        await this.outbox.enqueue(tx, ctx, listingDraftPublishRequested, { draftId: d.id, attempt }, d.id);
        out.queued.push(d.id);
      }
      return out;
    });
  }

  // ---- other modules ----

  /** FR-INT-07: copies from or to a store disconnected without its data, with their drafts. */
  deleteStoreCopiesIn(tx: Tx, storeId: string, limit: number): Promise<number> {
    return this.repo.deleteStoreCopies(tx, storeId, limit);
  }

  /** Full data export (FR-MIG-09): drafts and the seller's category choices. */
  exportSheets(): ExportSheet[] {
    return [
      {
        file: "draf_listing.csv",
        description: "Draf salinan listing ke toko lain beserta statusnya (FR-PRD-13).",
        columns: [
          "toko_asal",
          "toko_tujuan",
          "id_produk_asal",
          "judul",
          "status",
          "kategori",
          "jumlah_varian",
          "harga_terendah",
          "harga_tertinggi",
          "id_produk_tujuan",
          "diterbitkan_pada",
          "galat",
          "dibuat_pada",
          "id",
          "id_salinan",
        ],
        pages: (tx, l) =>
          keysetPages(
            (after) => this.repo.draftsPage(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((d) => {
                const prices = d.variants.map((v) => v.price);
                return [
                  l.storeName(d.sourceStoreId),
                  l.storeName(d.targetStoreId),
                  d.externalSourceItemId,
                  d.title,
                  d.status,
                  d.categoryPath,
                  d.variants.length,
                  prices.length ? Math.min(...prices) : null,
                  prices.length ? Math.max(...prices) : null,
                  d.externalTargetItemId,
                  d.publishedAt,
                  d.error,
                  d.createdAt,
                  d.id,
                  d.copyId,
                ];
              }),
          ),
      },
      {
        file: "pemetaan_kategori.csv",
        description: "Kategori tujuan yang dipilih untuk kategori marketplace asal saat menyalin listing.",
        columns: [
          "marketplace_asal",
          "id_kategori_asal",
          "marketplace_tujuan",
          "id_kategori_tujuan",
          "kategori_tujuan",
          "dipakai",
          "terakhir_dipakai",
          "id",
        ],
        pages: (tx) =>
          keysetPages(
            (after) => this.repo.mappingsPage(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((m) => [
                m.sourceChannel,
                m.externalSourceCategoryId,
                m.targetChannel,
                m.externalTargetCategoryId,
                m.targetCategoryPath,
                m.uses,
                m.lastUsedAt,
                m.id,
              ]),
          ),
      },
    ];
  }
}

/**
 * One attribute set to these values, checked against the category's rules: a listed value by id, a
 * typed one only where the attribute takes text. Empty values remove the attribute.
 */
export function withAttribute(
  current: DraftAttribute[],
  rules: CategoryRules | null,
  attributeId: string,
  values: { valueId?: string | null | undefined; name?: string | null | undefined; unit?: string | null | undefined }[],
  path: string,
): DraftAttribute[] {
  const rest = current.filter((a) => a.attributeId !== attributeId);
  if (values.length === 0) return rest;
  const def = rules?.attributes.find((a) => a.externalId === attributeId);
  if (!def) throw attributeNotInCategory(path);
  const mapped = values.map((v, i) => {
    if (v.valueId) {
      const listed = def.values.find((x) => x.externalId === v.valueId);
      if (!listed) throw attributeNotInCategory(`${path}.${i}.valueId`);
      return { externalId: listed.externalId, name: listed.name };
    }
    const name = v.name?.trim();
    if (!name || def.input === "select" || def.input === "multi_select") throw attributeNotInCategory(`${path}.${i}`);
    return { externalId: null, name, ...(v.unit ? { unit: v.unit } : {}) };
  });
  return [...rest, { attributeId, name: def.name, values: mapped }];
}

/** The draft columns a patch changes; content checks against the target are left to `problemsOf`. */
function applyPatch(d: DraftRow, p: DraftPatch, rules: CategoryRules | null): Partial<DraftRow> {
  const next: Partial<DraftRow> = {};
  if (p.title !== undefined) next.title = p.title.trim();
  if (p.description !== undefined) {
    next.description = p.description;
    // the seller's own words replace the copied HTML
    next.descriptionHtml = null;
  }
  if (p.brand !== undefined) {
    const name = p.brand?.name.trim() ?? "";
    next.brand = !name
      ? null
      : d.brand?.name && d.brand.name.toLowerCase() === name.toLowerCase()
        ? d.brand
        : { externalId: null, name };
  }
  if (p.attributes !== undefined) {
    let attributes: DraftAttribute[] = [];
    p.attributes.forEach((a, i) => {
      attributes = withAttribute(attributes, rules, a.attributeId, a.values, `attributes.${i}.values`);
    });
    next.attributes = attributes;
  }
  if (p.images !== undefined) {
    const byUrl = new Map(d.images.map((img) => [img.sourceUrl, img]));
    next.images = p.images.map((url, i) => {
      const img = byUrl.get(url);
      if (!img) throw imageNotInDraft(`images.${i}`);
      return img;
    });
  }
  if (p.weightG !== undefined) next.weightG = p.weightG;
  if (p.dimensionsMm !== undefined) next.dimensionsMm = p.dimensionsMm;
  if (p.condition !== undefined) next.condition = p.condition;
  if (p.preOrderDays !== undefined) next.preOrderDays = p.preOrderDays;
  if (p.itemSku !== undefined) next.itemSku = p.itemSku?.trim() || null;
  const names = p.variationNames ?? d.variationNames;
  if (p.variationNames !== undefined) {
    if (p.variationNames.length !== d.variationNames.length) throw variationsFixed();
    next.variationNames = p.variationNames.map((n) => n.trim());
  }
  if (p.variants !== undefined) {
    const byKey = new Map(d.variants.map((v) => [v.key, v]));
    next.variants = p.variants.map((v, i) => {
      const was = byKey.get(v.key);
      if (!was) throw variantKeyUnknown(`variants.${i}.key`);
      if (v.options && v.options.length !== names.length) throw variantKeyUnknown(`variants.${i}.options`);
      return {
        ...was,
        ...(v.sku !== undefined ? { sku: v.sku?.trim() || null } : {}),
        ...(v.price !== undefined ? { price: v.price } : {}),
        ...(v.options ? { options: v.options.map((o) => o.trim()) } : {}),
      };
    });
  }
  return next;
}
