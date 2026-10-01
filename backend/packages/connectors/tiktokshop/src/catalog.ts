import {
  isConnectorError,
  type ListingPage,
  type ListingStatus,
  type ListingStatusResult,
  type NormalizedListing,
  type ShopCredentials,
  toRupiah,
} from "@omniseller/connector-core";
import type { TiktokShopClient } from "./client.js";

/**
 * TikTok Shop product APIs:
 * - Search Products (POST /product/202502/products/search): 100 products per page with page_token,
 *   filterable by update_time_ge
 * - Get Product (GET /product/202309/products/{id}): variant attributes, images, weight, description
 * - Activate / Deactivate Products (POST /product/202309/products/activate|deactivate): partial
 *   failures come back in data.errors even when code is 0
 *
 * In Indonesia one product can be listed on TikTok Shop, Tokopedia, or both: `status` covers TikTok
 * Shop (absent when the product is not listed there) and `integrated_platform_statuses` covers
 * Tokopedia. A listing counts as active when it sells on at least one of them.
 */
const PAGE_SIZE = 100;
const STATUS_BATCH = 20;

const PRODUCT_STATUS: Record<string, ListingStatus> = {
  ACTIVATE: "active",
  SELLER_DEACTIVATED: "inactive",
  DRAFT: "inactive",
  PENDING: "reviewing",
  FAILED: "banned",
  PLATFORM_DEACTIVATED: "banned",
  FREEZE: "banned",
  DELETED: "deleted",
};
const PRECEDENCE: ListingStatus[] = ["active", "reviewing", "inactive", "banned", "deleted", "unknown"];

export function tiktokListingStatus(
  productStatus: string | undefined,
  platformStatuses: { platform?: string; status?: string }[] = [],
  skuStatus?: { status?: string; deactivation_source?: string },
): ListingStatus {
  const candidates = [productStatus, ...platformStatuses.map((p) => p.status)]
    .filter((s): s is string => !!s)
    .map((s) => PRODUCT_STATUS[s] ?? "unknown");
  let status = PRECEDENCE.find((p) => candidates.includes(p)) ?? "unknown";
  if (status === "active" && skuStatus?.status === "DEACTIVATED") {
    status = skuStatus.deactivation_source === "PLATFORM" ? "banned" : "inactive";
  }
  return status;
}

interface Price {
  currency?: string;
  tax_exclusive_price?: string;
  sale_price?: string;
}

interface SearchData {
  products?: { id?: string; status?: string; update_time?: number }[];
  next_page_token?: string;
  total_count?: number;
}

interface ProductDetail {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  update_time?: number;
  integrated_platform_statuses?: { platform?: string; status?: string }[];
  main_images?: { urls?: string[] }[];
  brand?: { name?: string };
  category_chains?: { local_name?: string; is_leaf?: boolean }[];
  package_weight?: { value?: string; unit?: string };
  package_dimensions?: { length?: string; width?: string; height?: string; unit?: string };
  skus?: {
    id?: string;
    seller_sku?: string;
    price?: Price;
    inventory?: { warehouse_id?: string; quantity?: number }[];
    sales_attributes?: { name?: string; value_name?: string; sku_img?: { urls?: string[] } }[];
    status_info?: { status?: string; deactivation_source?: string };
    sku_weight?: { value?: string; unit?: string };
    sku_dimensions?: { length?: string; width?: string; height?: string; unit?: string };
  }[];
}

interface StatusData {
  errors?: {
    code?: number;
    message?: string;
    detail?: { product_id?: string; extra_errors?: { message?: string }[] };
  }[];
}

function grams(w: { value?: string; unit?: string } | undefined): number | null {
  const n = Number(w?.value);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch ((w?.unit ?? "KILOGRAM").toUpperCase()) {
    case "GRAM":
      return Math.round(n);
    case "POUND":
      return Math.round(n * 453.592);
    default:
      return Math.round(n * 1000);
  }
}

function millimetres(d: { length?: string; width?: string; height?: string; unit?: string } | undefined) {
  const [l, w, h] = [Number(d?.length), Number(d?.width), Number(d?.height)];
  if (![l, w, h].every((x) => Number.isFinite(x) && x > 0)) return null;
  const factor = (d?.unit ?? "CENTIMETER").toUpperCase() === "INCH" ? 25.4 : 10;
  return { length: Math.round(l * factor), width: Math.round(w * factor), height: Math.round(h * factor) };
}

function clean(s: string | undefined | null): string | null {
  const t = s?.trim();
  return t ? t : null;
}

export function detailToListings(p: ProductDetail): NormalizedListing[] {
  const productId = String(p.id);
  const images = (p.main_images ?? []).map((i) => i.urls?.[0]).filter((u): u is string => !!u);
  const leaf = (p.category_chains ?? []).map((c) => c.local_name).filter(Boolean);
  const statusDetail = {
    tiktok_shop: p.status ?? null,
    ...Object.fromEntries(
      (p.integrated_platform_statuses ?? []).map((s) => [String(s.platform).toLowerCase(), s.status ?? null]),
    ),
  };
  return (p.skus ?? [])
    .filter((s) => s.id)
    .map((s) => {
      const attributes: Record<string, string> = {};
      let image: string | null = null;
      for (const a of s.sales_attributes ?? []) {
        if (a.name && a.value_name) attributes[a.name] = a.value_name;
        image ??= a.sku_img?.urls?.[0] ?? null;
      }
      const byWarehouse: Record<string, number> = {};
      let total = 0;
      for (const inv of s.inventory ?? []) {
        const q = Number(inv.quantity ?? 0);
        total += q;
        if (inv.warehouse_id) byWarehouse[inv.warehouse_id] = (byWarehouse[inv.warehouse_id] ?? 0) + q;
      }
      return {
        externalItemId: productId,
        externalVariantId: String(s.id),
        sku: clean(s.seller_sku),
        itemSku: null,
        title: p.title?.trim() || `Produk ${productId}`,
        variantName: Object.values(attributes).join(", ") || null,
        attributes,
        price: toRupiah(s.price?.tax_exclusive_price ?? s.price?.sale_price),
        originalPrice: null,
        status: tiktokListingStatus(p.status, p.integrated_platform_statuses, s.status_info),
        statusDetail: { ...statusDetail, sku: s.status_info?.status ?? null },
        stock: s.inventory ? total : null,
        stockByWarehouse: byWarehouse,
        imageUrl: image ?? images[0] ?? null,
        itemImageUrls: images,
        description: p.description ? p.description.slice(0, 5000) : null,
        brand: clean(p.brand?.name),
        categoryPath: leaf.length ? leaf.join(" > ") : null,
        weightG: grams(s.sku_weight) ?? grams(p.package_weight),
        dimensionsMm: millimetres(s.sku_dimensions) ?? millimetres(p.package_dimensions),
        updatedAt: p.update_time ? new Date(p.update_time * 1000) : null,
      };
    });
}

export function tiktokCatalog(client: TiktokShopClient) {
  async function details(shop: ShopCredentials, ids: string[]): Promise<ListingPage> {
    const listings: NormalizedListing[] = [];
    const deletedItemIds: string[] = [];
    for (const id of ids) {
      let p: ProductDetail;
      try {
        p = await client.call<ProductDetail>({
          method: "GET",
          path: `/product/202309/products/${encodeURIComponent(id)}`,
          accessToken: shop.accessToken,
          shopCipher: shop.shopCipher,
        });
      } catch (err) {
        // A product that no longer exists for this shop is gone; anything else is a real failure.
        if (isConnectorError(err) && err.kind === "permanent" && /not\s*exist|not\s*found/i.test(err.message)) {
          deletedItemIds.push(id);
          continue;
        }
        throw err;
      }
      if (
        p.status === "DELETED" &&
        !(p.integrated_platform_statuses ?? []).some((s) => s.status && s.status !== "DELETED")
      ) {
        deletedItemIds.push(id);
        continue;
      }
      listings.push(...detailToListings({ ...p, id: p.id ?? id }));
    }
    return { listings, deletedItemIds, nextCursor: null, itemCount: ids.length };
  }

  return {
    async listListings(
      shop: ShopCredentials,
      input: { cursor?: string | null; updatedSince?: Date | null },
    ): Promise<ListingPage> {
      const query: Record<string, string> = { page_size: String(PAGE_SIZE) };
      if (input.cursor) query.page_token = input.cursor;
      const body: Record<string, unknown> = { status: "ALL" };
      if (input.updatedSince) body.update_time_ge = Math.floor(input.updatedSince.getTime() / 1000);
      const page = await client.call<SearchData>({
        method: "POST",
        path: "/product/202502/products/search",
        accessToken: shop.accessToken,
        shopCipher: shop.shopCipher,
        query,
        body,
      });
      const products = page.products ?? [];
      const deleted = products.filter((p) => p.status === "DELETED").map((p) => String(p.id));
      const live = products.filter((p) => p.id && p.status !== "DELETED").map((p) => String(p.id));
      const detailed = await details(shop, live);
      return {
        listings: detailed.listings,
        deletedItemIds: [...deleted, ...detailed.deletedItemIds],
        nextCursor: page.next_page_token ? page.next_page_token : null,
        itemCount: products.length,
      };
    },

    getListings(shop: ShopCredentials, externalItemIds: string[]): Promise<ListingPage> {
      return details(shop, externalItemIds);
    },

    async setListingStatus(
      shop: ShopCredentials,
      externalItemIds: string[],
      active: boolean,
    ): Promise<ListingStatusResult[]> {
      const results: ListingStatusResult[] = [];
      for (let i = 0; i < externalItemIds.length; i += STATUS_BATCH) {
        const batch = externalItemIds.slice(i, i + STATUS_BATCH);
        // Without listing_platforms the change applies to every platform the product is listed on.
        const data = await client.call<StatusData>({
          method: "POST",
          path: `/product/202309/products/${active ? "activate" : "deactivate"}`,
          accessToken: shop.accessToken,
          shopCipher: shop.shopCipher,
          body: { product_ids: batch },
        });
        const failed = new Map<string, string>();
        for (const e of data.errors ?? []) {
          const id = e.detail?.product_id;
          if (!id) continue;
          const extra = (e.detail?.extra_errors ?? [])
            .map((x) => x.message)
            .filter(Boolean)
            .join("; ");
          failed.set(String(id), extra || e.message || `error ${e.code ?? ""}`.trim());
        }
        for (const id of batch) {
          const reason = failed.get(id);
          results.push(reason ? { externalItemId: id, ok: false, error: reason } : { externalItemId: id, ok: true });
        }
      }
      return results;
    },
  };
}
