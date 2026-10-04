import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { internalEan13 } from "../../common/barcode";
import type { RequestContext } from "../../common/context/request-context";
import { nextDocumentNumber } from "../../common/document-number";
import { ConflictError } from "../../common/errors/domain-errors";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { AuditService } from "../audit/audit.module";
import { UsersService } from "../identity/users.service";
import {
  attributesInvalid,
  barcodeTaken,
  productHasListings,
  productNotFound,
  skuTaken,
  variantNotFound,
} from "./catalog.errors";
import { CatalogRepository, normSku, type ProductRow, type VariantRow } from "./catalog.repository";
import { type HistoryEntry, historyEntry } from "./product-history";

export interface VariantInput {
  sku: string;
  name?: string | undefined;
  attributes?: Record<string, string> | undefined;
  barcode?: string | null | undefined;
  basePrice: number;
  costPrice?: number | undefined;
  weightG: number;
  lengthMm?: number | null | undefined;
  widthMm?: number | null | undefined;
  heightMm?: number | null | undefined;
  imageUrl?: string | null | undefined;
  status?: "active" | "archived" | undefined;
}

export interface ProductInput {
  sku: string;
  name: string;
  description?: string | null | undefined;
  brand?: string | null | undefined;
  categoryPath?: string | null | undefined;
  attributeNames?: string[] | undefined;
  imageUrls?: string[] | undefined;
  variants: VariantInput[];
}

export interface ProductPatch {
  sku?: string | undefined;
  name?: string | undefined;
  description?: string | null | undefined;
  brand?: string | null | undefined;
  categoryPath?: string | null | undefined;
  attributeNames?: string[] | undefined;
  imageUrls?: string[] | undefined;
  status?: "active" | "archived" | undefined;
}

export type VariantPatch = Partial<VariantInput>;

export interface VariantView extends VariantRow {
  imageUrl: string | null;
  listingCount: number;
}

export interface ProductView {
  product: ProductRow;
  variants: VariantView[];
  imageUrls: string[];
}

export const MAX_ATTRIBUTES = 3;

/** A product history entry with the name of whoever made it (FR-PRD-11). */
export interface ProductHistoryEntry extends HistoryEntry {
  actorName: string | null;
}

/** What a scanned code found (FR-PRD-12): the variant and its product. */
export interface ScanMatch {
  matchedBy: "barcode" | "sku";
  variant: VariantRow;
  product: ProductRow;
}

function variantName(
  input: { name?: string | undefined; attributes?: Record<string, string> | undefined },
  fallback: string,
) {
  const fromAttrs = Object.values(input.attributes ?? {}).join(", ");
  return input.name?.trim() || fromAttrs || fallback;
}

/**
 * Attribute rules (backend doc 7.8.3): variant attribute keys are exactly the product's attribute
 * names (none when the product has none), values are not empty, and no two variants share a combination.
 */
export function checkAttributes(
  attributeNames: string[],
  variants: { attributes?: Record<string, string> | undefined }[],
  pathOf: (i: number) => string,
): void {
  if (new Set(attributeNames).size !== attributeNames.length)
    throw attributesInvalid("attributeNames", "Nama atribut tidak boleh ganda.");
  if (attributeNames.length > MAX_ATTRIBUTES) {
    throw attributesInvalid("attributeNames", `Maksimal ${MAX_ATTRIBUTES} atribut varian.`);
  }
  const combos = new Set<string>();
  variants.forEach((v, i) => {
    const attrs = v.attributes ?? {};
    const keys = Object.keys(attrs);
    const extra = keys.filter((k) => !attributeNames.includes(k));
    if (extra.length) throw attributesInvalid(pathOf(i), `Atribut tidak dikenal: ${extra.join(", ")}.`);
    const missing = attributeNames.filter((n) => !attrs[n]?.trim());
    if (missing.length) throw attributesInvalid(pathOf(i), `Nilai atribut wajib diisi: ${missing.join(", ")}.`);
    const combo = attributeNames.map((n) => attrs[n]!.trim().toLowerCase()).join("\u0000");
    if (attributeNames.length && combos.has(combo))
      throw attributesInvalid(pathOf(i), "Kombinasi atribut ini sudah ada.");
    combos.add(combo);
  });
}

/**
 * Master products and variants (FR-PRD-01). SKUs are unique per business ignoring case and spaces,
 * so that matching marketplace listings by SKU (FR-PRD-02) is never ambiguous for new data.
 */
@Injectable()
export class ProductsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(CatalogRepository) private readonly repo: CatalogRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  async view(tx: Tx, products: ProductRow[]): Promise<ProductView[]> {
    const ids = products.map((p) => p.id);
    const [variants, images] = await Promise.all([this.repo.variantsOf(tx, ids), this.repo.imagesOf(tx, ids)]);
    const counts = await this.repo.listingsPerVariant(
      tx,
      variants.map((v) => v.id),
    );
    return products.map((p) => ({
      product: p,
      imageUrls: images
        .filter((i) => i.productId === p.id && !i.variantId)
        .map((i) => i.sourceUrl)
        .filter((u): u is string => !!u),
      variants: variants
        .filter((v) => v.productId === p.id)
        .map((v) => ({
          ...v,
          imageUrl: images.find((i) => i.variantId === v.id)?.sourceUrl ?? null,
          listingCount: counts.get(v.id) ?? 0,
        })),
    }));
  }

  async list(
    ctx: RequestContext,
    filter: { q?: string | undefined; status?: "active" | "archived" | undefined },
    before: string | undefined,
    limit: number,
  ): Promise<{ items: ProductView[]; more: boolean }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const rows = await this.repo.listProducts(tx, filter, before, limit);
      const more = rows.length > limit;
      return { items: await this.view(tx, rows.slice(0, limit)), more };
    });
  }

  async get(ctx: RequestContext, id: string): Promise<ProductView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const p = await this.repo.getProduct(tx, id);
      if (!p) throw productNotFound();
      return (await this.view(tx, [p]))[0]!;
    });
  }

  /**
   * FR-PRD-11: who changed the product or its variants, what, and when, newest first. The audit log
   * keeps every change of a product or variant column (drizzle/sql/20_triggers.sql). A page may hold
   * fewer entries than `limit`: writes that changed nothing visible are left out.
   */
  async history(
    ctx: RequestContext,
    productId: string,
    before: string | undefined,
    limit: number,
  ): Promise<{ items: ProductHistoryEntry[]; next: string | null }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const p = await this.repo.getProduct(tx, productId);
      if (!p) throw productNotFound();
      const rows = await this.audit.entriesIn(
        tx,
        [
          { entityType: "product", entityIds: [p.id] },
          { entityType: "variant", entityIds: await this.repo.variantIdsEver(tx, p.id) },
        ],
        before,
        limit + 1,
      );
      const names = await this.users.namesIn(tx);
      const page = rows.slice(0, limit);
      return {
        items: page.flatMap((r) => {
          const e = historyEntry(r);
          return e
            ? [{ ...e, actorName: e.actor.type === "user" && e.actor.id ? (names.get(e.actor.id) ?? null) : null }]
            : [];
        }),
        next: rows.length > limit ? page[page.length - 1]!.id : null,
      };
    });
  }

  /**
   * FR-PRD-12: an internal EAN-13 (prefix 20) for each of these variants that has no barcode, numbered
   * per business. Variants with a barcode keep it. A number someone already typed in is skipped.
   */
  async generateBarcodes(
    ctx: RequestContext,
    variantIds: string[],
  ): Promise<{ variant: VariantRow; generated: boolean }[]> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const variants = await this.repo.variantsByIds(tx, variantIds, true);
      if (variants.length !== new Set(variantIds).size) throw variantNotFound();
      const out: { variant: VariantRow; generated: boolean }[] = [];
      for (const v of [...variants].sort((a, b) => a.sku.localeCompare(b.sku))) {
        if (v.barcode) {
          out.push({ variant: v, generated: false });
          continue;
        }
        let code: string;
        do {
          code = internalEan13(await nextDocumentNumber(tx, ctx.tenantId, "barcode", "0000"));
        } while ((await this.repo.variantsByBarcode(tx, [code])).length > 0);
        await this.repo.updateVariant(tx, v.id, { barcode: code });
        out.push({ variant: { ...v, barcode: code }, generated: true });
      }
      return out;
    });
  }

  /**
   * FR-PRD-12: the variant a scanner read, by its barcode (exactly) or else its SKU (ignoring case and
   * spaces at the ends). Archived variants are found too; deleted ones are not.
   */
  async lookup(ctx: RequestContext, code: string): Promise<ScanMatch> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const [byBarcode] = await this.repo.variantsByBarcode(tx, [code]);
      const bySku = byBarcode ? [] : ((await this.repo.variantsByNormSku(tx, [code])).get(normSku(code)!) ?? []);
      const v = byBarcode ?? (bySku.length === 1 ? bySku[0] : undefined);
      if (!v) throw variantNotFound();
      const p = await this.repo.getProduct(tx, v.productId);
      if (!p) throw variantNotFound();
      return { matchedBy: byBarcode ? "barcode" : "sku", variant: v, product: p };
    });
  }

  /** Throws catalog.sku_taken when a live product (or variant) already uses the SKU, other than `self`. */
  private async assertProductSkuFree(tx: Tx, sku: string, self?: string): Promise<void> {
    const other = await this.repo.productBySku(tx, sku);
    if (other && other.id !== self) throw skuTaken("sku", sku);
  }

  private async assertVariantSkusFree(tx: Tx, skus: { sku: string; path: string; self?: string }[]): Promise<void> {
    const seen = new Map<string, string>();
    for (const s of skus) {
      const k = normSku(s.sku)!;
      if (seen.has(k)) throw skuTaken(s.path, s.sku);
      seen.set(k, s.path);
    }
    const taken = await this.repo.variantsByNormSku(
      tx,
      skus.map((s) => s.sku),
    );
    for (const s of skus) {
      const owners = (taken.get(normSku(s.sku)!) ?? []).filter((v) => v.id !== s.self);
      if (owners.length) throw skuTaken(s.path, s.sku);
    }
  }

  private async assertBarcodesFree(
    tx: Tx,
    items: { barcode: string | null | undefined; path: string; self?: string }[],
  ): Promise<void> {
    const wanted = items.map((i) => ({ ...i, barcode: i.barcode?.trim() || "" })).filter((i) => i.barcode);
    const seen = new Set<string>();
    for (const i of wanted) {
      if (seen.has(i.barcode)) throw barcodeTaken(i.path, i.barcode);
      seen.add(i.barcode);
    }
    const owners = await this.repo.variantsByBarcode(
      tx,
      wanted.map((i) => i.barcode),
    );
    for (const i of wanted) {
      if (owners.some((v) => v.barcode === i.barcode && v.id !== i.self)) throw barcodeTaken(i.path, i.barcode);
    }
  }

  /** Inside an existing transaction: used by create and by CSV import and listing conversion. */
  async createIn(
    tx: Tx,
    ctx: RequestContext,
    input: ProductInput,
  ): Promise<{ productId: string; variantIds: string[] }> {
    const attributeNames = (input.attributeNames ?? []).map((n) => n.trim()).filter(Boolean);
    checkAttributes(attributeNames, input.variants, (i) => `variants.${i}.attributes`);
    await this.assertProductSkuFree(tx, input.sku.trim());
    await this.assertVariantSkusFree(
      tx,
      input.variants.map((v, i) => ({ sku: v.sku.trim(), path: `variants.${i}.sku` })),
    );
    await this.assertBarcodesFree(
      tx,
      input.variants.map((v, i) => ({ barcode: v.barcode, path: `variants.${i}.barcode` })),
    );
    const productId = newId();
    await this.repo.insertProduct(tx, {
      id: productId,
      tenantId: ctx.tenantId,
      sku: input.sku.trim(),
      name: input.name.trim(),
      description: input.description ?? null,
      brand: input.brand?.trim() || null,
      categoryPath: input.categoryPath?.trim() || null,
      attributeNames,
      status: "active",
    });
    const variantIds: string[] = [];
    for (const v of input.variants) {
      const id = newId();
      variantIds.push(id);
      await this.repo.insertVariant(tx, {
        id,
        tenantId: ctx.tenantId,
        productId,
        sku: v.sku.trim(),
        name: variantName(v, input.name.trim()),
        attributes: Object.fromEntries(Object.entries(v.attributes ?? {}).map(([k, val]) => [k.trim(), val.trim()])),
        barcode: v.barcode?.trim() || null,
        basePrice: v.basePrice,
        costPrice: v.costPrice ?? 0,
        weightG: v.weightG,
        lengthMm: v.lengthMm ?? null,
        widthMm: v.widthMm ?? null,
        heightMm: v.heightMm ?? null,
        status: v.status ?? "active",
      });
      if (v.imageUrl) await this.repo.setVariantImage(tx, ctx.tenantId, productId, id, v.imageUrl);
    }
    await this.repo.replaceProductImages(tx, ctx.tenantId, productId, input.imageUrls ?? []);
    return { productId, variantIds };
  }

  async create(ctx: RequestContext, input: ProductInput): Promise<ProductView> {
    return this.unique(() =>
      withTenantTx(this.db, ctx, async (tx) => {
        const { productId } = await this.createIn(tx, ctx, input);
        return (await this.view(tx, [(await this.repo.getProduct(tx, productId))!]))[0]!;
      }),
    );
  }

  async update(ctx: RequestContext, id: string, patch: ProductPatch, ifMatch?: number): Promise<ProductView> {
    return this.unique(() =>
      withTenantTx(this.db, ctx, async (tx) => {
        const p = await this.repo.getProduct(tx, id, true);
        if (!p) throw productNotFound();
        await this.updateIn(tx, ctx, p, patch, ifMatch);
        return (await this.view(tx, [(await this.repo.getProduct(tx, id))!]))[0]!;
      }),
    );
  }

  async updateIn(tx: Tx, ctx: RequestContext, p: ProductRow, patch: ProductPatch, ifMatch?: number): Promise<void> {
    if (patch.sku !== undefined && patch.sku.trim() !== p.sku)
      await this.assertProductSkuFree(tx, patch.sku.trim(), p.id);
    if (patch.attributeNames !== undefined) {
      const names = patch.attributeNames.map((n) => n.trim()).filter(Boolean);
      const live = await this.repo.variantsOf(tx, [p.id]);
      checkAttributes(names, live, (i) => `variants.${i}.attributes`);
    }
    const ok = await this.repo.updateProduct(
      tx,
      p.id,
      {
        ...(patch.sku !== undefined ? { sku: patch.sku.trim() } : {}),
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.brand !== undefined ? { brand: patch.brand?.trim() || null } : {}),
        ...(patch.categoryPath !== undefined ? { categoryPath: patch.categoryPath?.trim() || null } : {}),
        ...(patch.attributeNames !== undefined
          ? { attributeNames: patch.attributeNames.map((n) => n.trim()).filter(Boolean) }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
      },
      ifMatch,
    );
    if (!ok) throw new ConflictError("row.stale", "Data sudah diubah orang lain. Muat ulang lalu coba lagi.");
    if (patch.imageUrls !== undefined) await this.repo.replaceProductImages(tx, ctx.tenantId, p.id, patch.imageUrls);
  }

  async addVariant(ctx: RequestContext, productId: string, input: VariantInput): Promise<ProductView> {
    return this.unique(() =>
      withTenantTx(this.db, ctx, async (tx) => {
        const p = await this.repo.getProduct(tx, productId, true);
        if (!p) throw productNotFound();
        await this.addVariantIn(tx, ctx, p, input);
        return (await this.view(tx, [p]))[0]!;
      }),
    );
  }

  async addVariantIn(tx: Tx, ctx: RequestContext, p: ProductRow, input: VariantInput): Promise<string> {
    const live = await this.repo.variantsOf(tx, [p.id]);
    checkAttributes(p.attributeNames, [...live, input], () => "attributes");
    await this.assertVariantSkusFree(tx, [{ sku: input.sku.trim(), path: "sku" }]);
    await this.assertBarcodesFree(tx, [{ barcode: input.barcode, path: "barcode" }]);
    const id = newId();
    await this.repo.insertVariant(tx, {
      id,
      tenantId: ctx.tenantId,
      productId: p.id,
      sku: input.sku.trim(),
      name: variantName(input, p.name),
      attributes: input.attributes ?? {},
      barcode: input.barcode?.trim() || null,
      basePrice: input.basePrice,
      costPrice: input.costPrice ?? 0,
      weightG: input.weightG,
      lengthMm: input.lengthMm ?? null,
      widthMm: input.widthMm ?? null,
      heightMm: input.heightMm ?? null,
      status: input.status ?? "active",
    });
    if (input.imageUrl) await this.repo.setVariantImage(tx, ctx.tenantId, p.id, id, input.imageUrl);
    return id;
  }

  async updateVariant(
    ctx: RequestContext,
    productId: string,
    variantId: string,
    patch: VariantPatch,
  ): Promise<ProductView> {
    return this.unique(() =>
      withTenantTx(this.db, ctx, async (tx) => {
        const p = await this.repo.getProduct(tx, productId, true);
        if (!p) throw productNotFound();
        const v = await this.repo.getVariant(tx, variantId, true);
        if (!v || v.productId !== p.id) throw variantNotFound();
        await this.updateVariantIn(tx, ctx, p, v, patch);
        return (await this.view(tx, [p]))[0]!;
      }),
    );
  }

  async updateVariantIn(tx: Tx, ctx: RequestContext, p: ProductRow, v: VariantRow, patch: VariantPatch): Promise<void> {
    if (patch.attributes !== undefined) {
      const live = (await this.repo.variantsOf(tx, [p.id])).map((x) =>
        x.id === v.id ? { ...x, attributes: patch.attributes! } : x,
      );
      checkAttributes(p.attributeNames, live, () => "attributes");
    }
    if (patch.sku !== undefined && patch.sku.trim() !== v.sku) {
      await this.assertVariantSkusFree(tx, [{ sku: patch.sku.trim(), path: "sku", self: v.id }]);
    }
    if (patch.barcode && patch.barcode.trim() !== v.barcode) {
      await this.assertBarcodesFree(tx, [{ barcode: patch.barcode, path: "barcode", self: v.id }]);
    }
    await this.repo.updateVariant(tx, v.id, {
      ...(patch.sku !== undefined ? { sku: patch.sku.trim() } : {}),
      ...(patch.attributes !== undefined ? { attributes: patch.attributes } : {}),
      ...(patch.name !== undefined || patch.attributes !== undefined
        ? { name: variantName({ name: patch.name ?? undefined, attributes: patch.attributes ?? v.attributes }, p.name) }
        : {}),
      ...(patch.barcode !== undefined ? { barcode: patch.barcode?.trim() || null } : {}),
      ...(patch.basePrice !== undefined ? { basePrice: patch.basePrice } : {}),
      ...(patch.costPrice !== undefined ? { costPrice: patch.costPrice } : {}),
      ...(patch.weightG !== undefined ? { weightG: patch.weightG } : {}),
      ...(patch.lengthMm !== undefined ? { lengthMm: patch.lengthMm } : {}),
      ...(patch.widthMm !== undefined ? { widthMm: patch.widthMm } : {}),
      ...(patch.heightMm !== undefined ? { heightMm: patch.heightMm } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
    if (patch.imageUrl !== undefined) await this.repo.setVariantImage(tx, ctx.tenantId, p.id, v.id, patch.imageUrl);
  }

  /** Soft delete, refused while listings still point at the product's variants (archive instead). */
  async remove(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const p = await this.repo.getProduct(tx, id, true);
      if (!p) throw productNotFound();
      if ((await this.repo.mappedListingCount(tx, id)) > 0) throw productHasListings();
      await this.repo.softDeleteProduct(tx, id);
    });
  }

  /** A concurrent insert with the same SKU or barcode surfaces as a unique violation; report it as taken. */
  private async unique<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
      if ((e.code ?? e.cause?.code) !== "23505") throw err;
      const constraint = e.constraint ?? e.cause?.constraint ?? "";
      throw constraint.includes("barcode") ? barcodeTaken("barcode", "?") : skuTaken("sku", "?");
    }
  }
}
