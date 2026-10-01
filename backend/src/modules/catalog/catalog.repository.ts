import { Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import {
  channelListing,
  type ListingStatus,
  type MappingSource,
  product,
  productImage,
  variant,
} from "../../db/schema";

export type ProductRow = typeof product.$inferSelect;
export type VariantRow = typeof variant.$inferSelect;
export type ListingRow = typeof channelListing.$inferSelect;
export type ImageRow = typeof productImage.$inferSelect;

export interface ListingWithVariant extends ListingRow {
  variant: { id: string; sku: string; name: string; productId: string; productName: string } | null;
}

export interface Suggestion {
  listingId: string;
  variantId: string;
  score: number;
}

/** Normalized SKU for matching: case-insensitive, surrounding spaces ignored (same as the SQL indexes). */
export function normSku(sku: string | null | undefined): string | null {
  const t = sku?.trim().toLowerCase();
  return t ? t : null;
}

const notDeleted = isNull(variant.deletedAt);

/** Tables owned by the catalog module (backend doc 11): product, variant, product_image, channel_listing. */
@Injectable()
export class CatalogRepository {
  // ---- products ----

  async listProducts(
    tx: Tx,
    filter: { q?: string | undefined; status?: "active" | "archived" | undefined },
    before: string | undefined,
    limit: number,
  ): Promise<ProductRow[]> {
    const conds: (SQL | undefined)[] = [isNull(product.deletedAt)];
    if (filter.status) conds.push(eq(product.status, filter.status));
    if (before) conds.push(lt(product.id, before));
    if (filter.q) {
      const like = `%${filter.q.replace(/[%_\\]/g, "\\$&")}%`;
      conds.push(
        or(
          ilike(product.name, like),
          ilike(product.sku, like),
          sql`EXISTS (SELECT 1 FROM variant v WHERE v.product_id = ${sql.raw('"product"."id"')} AND v.deleted_at IS NULL AND v.sku ILIKE ${like})`,
        ),
      );
    }
    return tx
      .select()
      .from(product)
      .where(and(...conds))
      .orderBy(desc(product.id))
      .limit(limit + 1);
  }

  async getProduct(tx: Tx, id: string, forUpdate = false): Promise<ProductRow | undefined> {
    const q = tx
      .select()
      .from(product)
      .where(and(eq(product.id, id), isNull(product.deletedAt)));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  async productBySku(tx: Tx, sku: string): Promise<ProductRow | undefined> {
    const [row] = await tx
      .select()
      .from(product)
      .where(and(sql`lower(btrim(${product.sku})) = ${normSku(sku)}`, isNull(product.deletedAt)));
    return row;
  }

  async insertProduct(tx: Tx, row: typeof product.$inferInsert): Promise<void> {
    await tx.insert(product).values(row);
  }

  async updateProduct(
    tx: Tx,
    id: string,
    patch: Partial<typeof product.$inferInsert>,
    ifMatch?: number,
  ): Promise<boolean> {
    const where = ifMatch === undefined ? eq(product.id, id) : and(eq(product.id, id), eq(product.rowVersion, ifMatch));
    const res = await tx
      .update(product)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${product.rowVersion} + 1` })
      .where(where)
      .returning({ id: product.id });
    return res.length > 0;
  }

  // ---- variants ----

  async variantsOf(tx: Tx, productIds: string[], includeArchived = true): Promise<VariantRow[]> {
    if (productIds.length === 0) return [];
    return tx
      .select()
      .from(variant)
      .where(
        and(
          inArray(variant.productId, productIds),
          notDeleted,
          includeArchived ? undefined : eq(variant.status, "active"),
        ),
      )
      .orderBy(asc(variant.id));
  }

  async getVariant(tx: Tx, id: string, forUpdate = false): Promise<VariantRow | undefined> {
    const q = tx
      .select()
      .from(variant)
      .where(and(eq(variant.id, id), notDeleted));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  /** Variants by normalized SKU, among live variants of the tenant. */
  async variantsByNormSku(tx: Tx, skus: string[]): Promise<Map<string, VariantRow[]>> {
    const norm = [...new Set(skus.map(normSku).filter((s): s is string => !!s))];
    const out = new Map<string, VariantRow[]>();
    if (norm.length === 0) return out;
    const rows = await tx
      .select()
      .from(variant)
      .where(and(notDeleted, inArray(sql<string>`lower(btrim(${variant.sku}))`, norm)));
    for (const r of rows) {
      const k = normSku(r.sku)!;
      out.set(k, [...(out.get(k) ?? []), r]);
    }
    return out;
  }

  /** Live variants holding any of these barcodes (exact match, like the unique index). */
  async variantsByBarcode(tx: Tx, barcodes: string[]): Promise<VariantRow[]> {
    const wanted = [...new Set(barcodes.filter(Boolean))];
    if (wanted.length === 0) return [];
    return tx
      .select()
      .from(variant)
      .where(and(notDeleted, inArray(variant.barcode, wanted)));
  }

  async insertVariant(tx: Tx, row: typeof variant.$inferInsert): Promise<void> {
    await tx.insert(variant).values(row);
  }

  async updateVariant(tx: Tx, id: string, patch: Partial<typeof variant.$inferInsert>): Promise<void> {
    await tx
      .update(variant)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${variant.rowVersion} + 1` })
      .where(eq(variant.id, id));
  }

  async softDeleteProduct(tx: Tx, productId: string): Promise<void> {
    const now = new Date();
    await tx
      .update(variant)
      .set({ deletedAt: now, updatedAt: now, rowVersion: sql`${variant.rowVersion} + 1` })
      .where(and(eq(variant.productId, productId), notDeleted));
    await tx
      .update(product)
      .set({ deletedAt: now, updatedAt: now, rowVersion: sql`${product.rowVersion} + 1` })
      .where(eq(product.id, productId));
  }

  // ---- images ----

  async imagesOf(tx: Tx, productIds: string[]): Promise<ImageRow[]> {
    if (productIds.length === 0) return [];
    return tx
      .select()
      .from(productImage)
      .where(inArray(productImage.productId, productIds))
      .orderBy(asc(productImage.position));
  }

  /** Replaces the product-level images (variant images are kept). */
  async replaceProductImages(tx: Tx, tenantId: string, productId: string, urls: string[]): Promise<void> {
    await tx.delete(productImage).where(and(eq(productImage.productId, productId), isNull(productImage.variantId)));
    if (urls.length === 0) return;
    await tx
      .insert(productImage)
      .values(
        urls.map((url, position) => ({ id: newId(), tenantId, productId, variantId: null, sourceUrl: url, position })),
      );
  }

  async setVariantImage(
    tx: Tx,
    tenantId: string,
    productId: string,
    variantId: string,
    url: string | null,
  ): Promise<void> {
    await tx.delete(productImage).where(eq(productImage.variantId, variantId));
    if (url) {
      await tx
        .insert(productImage)
        .values({ id: newId(), tenantId, productId, variantId, sourceUrl: url, position: 0 });
    }
  }

  // ---- listings ----

  async mappedListingCount(tx: Tx, productId: string): Promise<number> {
    const [row] = await tx
      .select({ n: count() })
      .from(channelListing)
      .innerJoin(variant, eq(variant.id, channelListing.variantId))
      .where(and(eq(variant.productId, productId), ne(channelListing.status, "deleted")));
    return Number(row?.n ?? 0);
  }

  async listingsPerVariant(tx: Tx, variantIds: string[]): Promise<Map<string, number>> {
    if (variantIds.length === 0) return new Map();
    const rows = await tx
      .select({ variantId: channelListing.variantId, n: count() })
      .from(channelListing)
      .where(and(inArray(channelListing.variantId, variantIds), ne(channelListing.status, "deleted")))
      .groupBy(channelListing.variantId);
    return new Map(rows.map((r) => [r.variantId!, Number(r.n)]));
  }

  async listListings(
    tx: Tx,
    filter: {
      scope: ReadonlySet<string> | null;
      storeId?: string | undefined;
      status?: ListingStatus | undefined;
      mapped?: boolean | undefined;
      variantId?: string | undefined;
      q?: string | undefined;
    },
    before: string | undefined,
    limit: number,
  ): Promise<ListingWithVariant[]> {
    if (filter.scope && filter.scope.size === 0) return [];
    const conds: (SQL | undefined)[] = [];
    if (filter.scope) conds.push(inArray(channelListing.storeId, [...filter.scope]));
    if (filter.storeId) conds.push(eq(channelListing.storeId, filter.storeId));
    if (filter.status) conds.push(eq(channelListing.status, filter.status));
    else conds.push(ne(channelListing.status, "deleted"));
    if (filter.mapped === true) conds.push(isNotNull(channelListing.variantId));
    if (filter.mapped === false) conds.push(isNull(channelListing.variantId));
    if (filter.variantId) conds.push(eq(channelListing.variantId, filter.variantId));
    if (before) conds.push(lt(channelListing.id, before));
    if (filter.q) {
      const like = `%${filter.q.replace(/[%_\\]/g, "\\$&")}%`;
      conds.push(or(ilike(channelListing.title, like), ilike(channelListing.externalSku, like)));
    }
    const rows = await tx
      .select({
        listing: channelListing,
        variantId: variant.id,
        variantSku: variant.sku,
        variantName: variant.name,
        productId: product.id,
        productName: product.name,
      })
      .from(channelListing)
      .leftJoin(variant, eq(variant.id, channelListing.variantId))
      .leftJoin(product, eq(product.id, variant.productId))
      .where(and(...conds))
      .orderBy(desc(channelListing.id))
      .limit(limit + 1);
    return rows.map((r) => ({
      ...r.listing,
      variant:
        r.variantId && r.productId
          ? {
              id: r.variantId,
              sku: r.variantSku!,
              name: r.variantName!,
              productId: r.productId,
              productName: r.productName!,
            }
          : null,
    }));
  }

  async listingsByIds(tx: Tx, ids: string[], forUpdate = false): Promise<ListingRow[]> {
    if (ids.length === 0) return [];
    const q = tx.select().from(channelListing).where(inArray(channelListing.id, ids));
    return forUpdate ? q.for("update") : q;
  }

  /** Inserts new listings and refreshes known ones; mappings are never touched here. */
  async upsertListings(
    tx: Tx,
    rows: (typeof channelListing.$inferInsert)[],
  ): Promise<{ id: string; inserted: boolean }[]> {
    if (rows.length === 0) return [];
    return tx
      .insert(channelListing)
      .values(rows)
      .onConflictDoUpdate({
        target: [channelListing.storeId, channelListing.externalItemId, channelListing.externalVariantId],
        set: {
          externalSku: sql`excluded.external_sku`,
          title: sql`excluded.title`,
          price: sql`excluded.price`,
          originalPrice: sql`excluded.original_price`,
          status: sql`excluded.status`,
          stockAtChannel: sql`excluded.stock_at_channel`,
          channelData: sql`excluded.channel_data`,
          lastPulledAt: sql`excluded.last_pulled_at`,
          updatedAt: sql`now()`,
          rowVersion: sql`${channelListing.rowVersion} + 1`,
        },
      })
      .returning({ id: channelListing.id, inserted: sql<boolean>`(xmax = 0)` });
  }

  async markItemsDeleted(tx: Tx, storeId: string, itemIds: string[], at: Date): Promise<number> {
    if (itemIds.length === 0) return 0;
    const res = await tx
      .update(channelListing)
      .set({ status: "deleted", lastPulledAt: at, updatedAt: at, rowVersion: sql`${channelListing.rowVersion} + 1` })
      .where(
        and(
          eq(channelListing.storeId, storeId),
          inArray(channelListing.externalItemId, itemIds),
          ne(channelListing.status, "deleted"),
        ),
      )
      .returning({ id: channelListing.id });
    return res.length;
  }

  /** Variants of an item that the marketplace no longer returns (a removed model or SKU). */
  async closeMissingVariants(tx: Tx, storeId: string, itemId: string, variantIds: string[], at: Date): Promise<number> {
    const res = await tx
      .update(channelListing)
      .set({ status: "deleted", lastPulledAt: at, updatedAt: at, rowVersion: sql`${channelListing.rowVersion} + 1` })
      .where(
        and(
          eq(channelListing.storeId, storeId),
          eq(channelListing.externalItemId, itemId),
          ne(channelListing.status, "deleted"),
          variantIds.length
            ? sql`${channelListing.externalVariantId} NOT IN (${sql.join(
                variantIds.map((v) => sql`${v}`),
                sql`, `,
              )})`
            : undefined,
        ),
      )
      .returning({ id: channelListing.id });
    return res.length;
  }

  /** End of a full pull: what the marketplace no longer lists is gone. */
  async closeUnseen(tx: Tx, storeId: string, startedAt: Date): Promise<number> {
    const res = await tx
      .update(channelListing)
      .set({ status: "deleted", updatedAt: new Date(), rowVersion: sql`${channelListing.rowVersion} + 1` })
      .where(
        and(
          eq(channelListing.storeId, storeId),
          ne(channelListing.status, "deleted"),
          or(isNull(channelListing.lastPulledAt), lt(channelListing.lastPulledAt, startedAt)),
        ),
      )
      .returning({ id: channelListing.id });
    return res.length;
  }

  async setMapping(tx: Tx, listingId: string, variantId: string | null, source: MappingSource | null): Promise<void> {
    await tx
      .update(channelListing)
      .set({
        variantId,
        mappingSource: variantId ? source : null,
        mappedAt: variantId ? new Date() : null,
        updatedAt: new Date(),
        rowVersion: sql`${channelListing.rowVersion} + 1`,
      })
      .where(eq(channelListing.id, listingId));
  }

  /**
   * FR-PRD-02: maps every unmapped live listing whose SKU equals exactly one live variant's SKU
   * (ignoring case and surrounding spaces). Ambiguous SKUs stay unmapped for a person to decide.
   */
  async autoMapBySku(tx: Tx, storeId?: string): Promise<{ listingId: string; variantId: string }[]> {
    const storeFilter = storeId ? sql`AND l2.store_id = ${storeId}` : sql``;
    const r = await tx.execute<{ id: string; variant_id: string }>(sql`
      UPDATE channel_listing l
         SET variant_id = m.variant_id, mapping_source = 'auto_sku', mapped_at = now(),
             updated_at = now(), row_version = l.row_version + 1
        FROM (SELECT l2.id AS listing_id, min(v.id) AS variant_id
                FROM channel_listing l2
                JOIN variant v ON v.tenant_id = l2.tenant_id AND v.deleted_at IS NULL AND v.status = 'active'
                              AND lower(btrim(v.sku)) = lower(btrim(l2.external_sku))
               WHERE l2.variant_id IS NULL AND l2.external_sku IS NOT NULL AND btrim(l2.external_sku) <> ''
                 AND l2.status <> 'deleted' ${storeFilter}
               GROUP BY l2.id
              HAVING count(*) = 1) m
       WHERE l.id = m.listing_id
      RETURNING l.id, l.variant_id`);
    return r.rows.map((x) => ({ listingId: x.id, variantId: x.variant_id }));
  }

  /** FR-PRD-03: up to three variants per listing whose product name resembles the listing title. */
  async nameSuggestions(tx: Tx, listingIds: string[]): Promise<Suggestion[]> {
    if (listingIds.length === 0) return [];
    const r = await tx.execute<{ listing_id: string; variant_id: string; score: number }>(sql`
      SELECT l.id AS listing_id, s.variant_id, s.score
        FROM channel_listing l
        CROSS JOIN LATERAL (
          SELECT v.id AS variant_id,
                 round(similarity(p.name || ' ' || v.name,
                                  l.title || ' ' || coalesce(l.channel_data->>'variantName', ''))::numeric, 3)::float8 AS score
            FROM product p
            JOIN variant v ON v.product_id = p.id AND v.deleted_at IS NULL AND v.status = 'active'
           WHERE p.deleted_at IS NULL AND p.name % l.title
           ORDER BY score DESC, v.id
           LIMIT 3) s
       WHERE l.id IN (${sql.join(
         listingIds.map((id) => sql`${id}`),
         sql`, `,
       )})
       ORDER BY l.id, s.score DESC`);
    return r.rows.map((x) => ({ listingId: x.listing_id, variantId: x.variant_id, score: Number(x.score) }));
  }

  async variantsWithProduct(tx: Tx, ids: string[]) {
    if (ids.length === 0) return [];
    return tx
      .select({ variant, productName: product.name })
      .from(variant)
      .innerJoin(product, eq(product.id, variant.productId))
      .where(inArray(variant.id, ids));
  }
}
