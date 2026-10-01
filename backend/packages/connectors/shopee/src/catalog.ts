import {
  type ListingPage,
  type ListingStatus,
  type ListingStatusResult,
  type NormalizedListing,
  type ShopCredentials,
  toRupiah,
} from "@omniseller/connector-core";
import type { ShopeeClient } from "./client.js";

/**
 * Shopee product APIs (v2.product.*):
 * - get_item_list: item ids, 100 per page (offset), filtered by item_status and optionally update time
 * - get_item_base_info: details of up to 50 items (title, item_sku, images, weight, price and stock of
 *   items without models)
 * - get_model_list: variants of one item (model_sku, tier options, price, stock per location)
 * - unlist_item: unlist or relist up to 50 items, with a success and a failure list
 */
export const SHOPEE_ITEM_STATUSES = [
  "NORMAL",
  "BANNED",
  "UNLIST",
  "REVIEWING",
  "SELLER_DELETE",
  "SHOPEE_DELETE",
] as const;
const DELETED = new Set(["SELLER_DELETE", "SHOPEE_DELETE"]);
const PAGE_SIZE = 100;
const BASE_INFO_BATCH = 50;
const UNLIST_BATCH = 50;

export function shopeeListingStatus(itemStatus: string | undefined, modelStatus?: string): ListingStatus {
  switch (itemStatus) {
    case "NORMAL":
      return modelStatus === "MODEL_UNAVAILABLE" ? "inactive" : "active";
    case "UNLIST":
      return "inactive";
    case "BANNED":
      return "banned";
    case "REVIEWING":
      return "reviewing";
    case "SELLER_DELETE":
    case "SHOPEE_DELETE":
      return "deleted";
    default:
      return "unknown";
  }
}

interface ItemListResponse {
  response?: {
    item?: { item_id?: number; item_status?: string; update_time?: number }[];
    has_next_page?: boolean;
    next_offset?: number;
    total_count?: number;
  };
}

interface StockInfoV2 {
  summary_info?: { total_available_stock?: number };
  seller_stock?: { location_id?: string; stock?: number }[];
  shopee_stock?: { location_id?: string; stock?: number | string }[];
}

interface BaseInfoItem {
  item_id?: number;
  item_name?: string;
  item_sku?: string;
  description?: string;
  item_status?: string;
  update_time?: number;
  has_model?: boolean;
  weight?: string;
  dimension?: { package_length?: number; package_width?: number; package_height?: number };
  image?: { image_url_list?: string[] };
  price_info?: { current_price?: number; original_price?: number }[];
  stock_info_v2?: StockInfoV2;
  brand?: { original_brand_name?: string };
  category_id?: number;
}

interface BaseInfoResponse {
  response?: { item_list?: BaseInfoItem[] };
}

interface ModelListResponse {
  response?: {
    tier_variation?: { name?: string; option_list?: { option?: string; image?: { image_url?: string } }[] }[];
    model?: {
      model_id?: number;
      model_sku?: string;
      model_status?: string;
      tier_index?: number[];
      price_info?: { current_price?: number; original_price?: number }[];
      stock_info_v2?: StockInfoV2;
      weight?: string;
      dimension?: { package_length?: number; package_width?: number; package_height?: number };
    }[];
  };
}

interface UnlistResponse {
  response?: {
    success_list?: { item_id?: number; unlist?: boolean }[];
    failure_list?: { item_id?: number; failed_reason?: string }[];
  };
}

/** Shopee weight is kilograms as a string. */
function grams(kg: string | undefined): number | null {
  const n = Number(kg);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
}

function dims(d: { package_length?: number; package_width?: number; package_height?: number } | undefined) {
  if (!d?.package_length || !d.package_width || !d.package_height) return null;
  return { length: d.package_length * 10, width: d.package_width * 10, height: d.package_height * 10 };
}

/** Seller stock per location, plus Shopee-held stock under the FBS warehouse id. */
function stockOf(info: StockInfoV2 | undefined, fbsWarehouseId: string) {
  const byWarehouse: Record<string, number> = {};
  for (const s of info?.seller_stock ?? []) {
    if (s.location_id) byWarehouse[s.location_id] = (byWarehouse[s.location_id] ?? 0) + Number(s.stock ?? 0);
  }
  let fbs = 0;
  for (const s of info?.shopee_stock ?? []) fbs += Number(s.stock ?? 0);
  if (fbs > 0) byWarehouse[fbsWarehouseId] = fbs;
  const total = info?.summary_info?.total_available_stock;
  return { total: typeof total === "number" ? total : null, byWarehouse };
}

function clean(s: string | undefined | null): string | null {
  const t = s?.trim();
  return t ? t : null;
}

export function shopeeCatalog(client: ShopeeClient, fbsWarehouseId: string) {
  async function itemsToListings(shop: ShopCredentials, ids: string[]): Promise<NormalizedListing[]> {
    const out: NormalizedListing[] = [];
    for (let i = 0; i < ids.length; i += BASE_INFO_BATCH) {
      const batch = ids.slice(i, i + BASE_INFO_BATCH);
      const base = await client.shopCall<BaseInfoResponse>(shop, "GET", "/api/v2/product/get_item_base_info", {
        query: { item_id_list: batch.join(","), need_tax_info: "false", need_complaint_policy: "false" },
      });
      for (const item of base.response?.item_list ?? []) {
        if (item.item_id === undefined) continue;
        const itemId = String(item.item_id);
        const images = item.image?.image_url_list ?? [];
        const common = {
          externalItemId: itemId,
          itemSku: clean(item.item_sku),
          title: item.item_name?.trim() || `Item ${itemId}`,
          itemImageUrls: images,
          description: item.description ? item.description.slice(0, 5000) : null,
          brand: clean(item.brand?.original_brand_name) === "NoBrand" ? null : clean(item.brand?.original_brand_name),
          categoryPath: item.category_id ? String(item.category_id) : null,
          updatedAt: item.update_time ? new Date(item.update_time * 1000) : null,
        };
        if (!item.has_model) {
          const stock = stockOf(item.stock_info_v2, fbsWarehouseId);
          out.push({
            ...common,
            externalVariantId: "",
            sku: clean(item.item_sku),
            variantName: null,
            attributes: {},
            price: toRupiah(item.price_info?.[0]?.current_price),
            originalPrice: toRupiah(item.price_info?.[0]?.original_price),
            status: shopeeListingStatus(item.item_status),
            statusDetail: { item_status: item.item_status ?? null },
            stock: stock.total,
            stockByWarehouse: stock.byWarehouse,
            imageUrl: images[0] ?? null,
            weightG: grams(item.weight),
            dimensionsMm: dims(item.dimension),
          });
          continue;
        }
        const models = await client.shopCall<ModelListResponse>(shop, "GET", "/api/v2/product/get_model_list", {
          query: { item_id: itemId },
        });
        const tiers = models.response?.tier_variation ?? [];
        for (const m of models.response?.model ?? []) {
          if (m.model_id === undefined) continue;
          const attributes: Record<string, string> = {};
          let image: string | null = null;
          (m.tier_index ?? []).forEach((optionIndex, tier) => {
            const t = tiers[tier];
            const option = t?.option_list?.[optionIndex];
            if (t?.name && option?.option) attributes[t.name] = option.option;
            if (tier === 0 && option?.image?.image_url) image = option.image.image_url;
          });
          const stock = stockOf(m.stock_info_v2, fbsWarehouseId);
          out.push({
            ...common,
            externalVariantId: String(m.model_id),
            sku: clean(m.model_sku),
            variantName: Object.values(attributes).join(", ") || null,
            attributes,
            price: toRupiah(m.price_info?.[0]?.current_price),
            originalPrice: toRupiah(m.price_info?.[0]?.original_price),
            status: shopeeListingStatus(item.item_status, m.model_status),
            statusDetail: { item_status: item.item_status ?? null, model_status: m.model_status ?? null },
            stock: stock.total,
            stockByWarehouse: stock.byWarehouse,
            imageUrl: image ?? images[0] ?? null,
            weightG: grams(m.weight) ?? grams(item.weight),
            dimensionsMm: dims(m.dimension) ?? dims(item.dimension),
          });
        }
      }
    }
    return out;
  }

  return {
    async listListings(
      shop: ShopCredentials,
      input: { cursor?: string | null; updatedSince?: Date | null },
    ): Promise<ListingPage> {
      const offset = Number(input.cursor ?? 0) || 0;
      const query: Record<string, string | readonly string[]> = {
        offset: String(offset),
        page_size: String(PAGE_SIZE),
        item_status: SHOPEE_ITEM_STATUSES,
      };
      if (input.updatedSince) {
        query.update_time_from = String(Math.floor(input.updatedSince.getTime() / 1000));
        query.update_time_to = String(Math.floor(Date.now() / 1000));
      }
      const list = await client.shopCall<ItemListResponse>(shop, "GET", "/api/v2/product/get_item_list", { query });
      const items = list.response?.item ?? [];
      const deletedItemIds = items.filter((i) => DELETED.has(i.item_status ?? "")).map((i) => String(i.item_id));
      const live = items
        .filter((i) => i.item_id !== undefined && !DELETED.has(i.item_status ?? ""))
        .map((i) => String(i.item_id));
      return {
        listings: await itemsToListings(shop, live),
        deletedItemIds,
        nextCursor: list.response?.has_next_page ? String(list.response.next_offset ?? offset + items.length) : null,
        itemCount: items.length,
      };
    },

    async getListings(shop: ShopCredentials, externalItemIds: string[]): Promise<ListingPage> {
      const listings = await itemsToListings(shop, externalItemIds);
      const found = new Set(listings.map((l) => l.externalItemId));
      return {
        // An item the marketplace no longer returns is gone (deleted by the seller or by Shopee).
        listings,
        deletedItemIds: externalItemIds.filter((id) => !found.has(id)),
        nextCursor: null,
        itemCount: externalItemIds.length,
      };
    },

    async setListingStatus(
      shop: ShopCredentials,
      externalItemIds: string[],
      active: boolean,
    ): Promise<ListingStatusResult[]> {
      const results: ListingStatusResult[] = [];
      for (let i = 0; i < externalItemIds.length; i += UNLIST_BATCH) {
        const batch = externalItemIds.slice(i, i + UNLIST_BATCH);
        const res = await client.shopCall<UnlistResponse>(shop, "POST", "/api/v2/product/unlist_item", {
          body: { item_list: batch.map((id) => ({ item_id: Number(id), unlist: !active })) },
        });
        const failed = new Map(
          (res.response?.failure_list ?? []).map((f) => [String(f.item_id), f.failed_reason ?? "failed"]),
        );
        for (const id of batch) {
          const reason = failed.get(id);
          results.push(reason ? { externalItemId: id, ok: false, error: reason } : { externalItemId: id, ok: true });
        }
      }
      return results;
    },
  };
}
