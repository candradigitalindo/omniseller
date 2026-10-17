import {
  type AttributeInput,
  type CategoryAttribute,
  type CategoryRules,
  type CreatedProduct,
  type CreateHooks,
  fileForm,
  isConnectorError,
  type MarketplaceBrand,
  type MarketplaceCategory,
  PermanentConnectorError,
  type ProductAttributeValue,
  type ProductToCreate,
  type ShopCredentials,
  type SourceProduct,
  toRupiah,
  withCreatedItem,
} from "@omniseller/connector-core";
import type { ShopeeClient } from "./client.js";
import { numericId, shopeeId } from "./identifiers.js";

/**
 * Creating products on Shopee (v2.product.*, v2.media_space.upload_image; developer guides "Product
 * creation preparation" and "Creating product"), for copying listings between shops (FR-PRD-13):
 * - get_category (language=id): the tree; only leaves (has_children=false) take products
 * - category_recommend: leaf categories for an item name
 * - get_attribute_tree (20 categories per call), get_item_limit, get_brand_list (is_mandatory)
 * - media_space.upload_image: JPG/PNG up to 10 MB; scene normal (square) or desc
 * - add_item, then init_tier_variation with standardise_tier_variation (the tier_variation structure
 *   is deprecated since 2025-09-12), at least 5 seconds after the item is created
 * Brand "No Brand" is brand_id 0. Prices in Indonesia are whole rupiah.
 */
const LANGUAGE = "id";
const ATTRIBUTE_BATCH = 20;
const BRAND_PAGE = 100;
const BRAND_PAGES = 10;
const NO_BRAND: MarketplaceBrand = { externalId: "0", name: "No Brand", selectable: true };

interface BaseInfo {
  item_id?: number | string;
  category_id?: number | string;
  item_name?: string;
  description?: string;
  description_type?: string;
  description_info?: { extended_description?: { field_list?: { field_type?: string; text?: string }[] } };
  item_sku?: string;
  attribute_list?: {
    attribute_id?: number | string;
    original_attribute_name?: string;
    attribute_value_list?: { value_id?: number | string; original_value_name?: string; value_unit?: string }[];
  }[];
  price_info?: { original_price?: number; current_price?: number }[];
  stock_info_v2?: { summary_info?: { total_available_stock?: number } };
  image?: { image_url_list?: string[] };
  weight?: string;
  dimension?: { package_length?: number; package_width?: number; package_height?: number };
  logistic_info?: {
    logistic_id?: number | string;
    enabled?: boolean;
    is_free?: boolean;
    size_id?: number | string;
    shipping_fee?: number;
  }[];
  pre_order?: { is_pre_order?: boolean; days_to_ship?: number };
  condition?: string;
  size_chart?: string;
  has_model?: boolean;
  brand?: { brand_id?: number | string; original_brand_name?: string };
  item_dangerous?: number;
  gtin_code?: string;
}

interface ModelList {
  response?: {
    tier_variation?: { name?: string; option_list?: { option?: string; image?: { image_url?: string } }[] }[];
    model?: {
      model_id?: number | string;
      model_sku?: string;
      tier_index?: number[];
      price_info?: { original_price?: number; current_price?: number }[];
      stock_info_v2?: { summary_info?: { total_available_stock?: number } };
      gtin_code?: string;
    }[];
  };
}

interface AttributeNode {
  attribute_id?: number | string;
  mandatory?: boolean;
  name?: string;
  multi_lang?: { language?: string; value?: string }[];
  attribute_value_list?: {
    value_id?: number | string;
    name?: string;
    multi_lang?: { language?: string; value?: string }[];
  }[];
  attribute_info?: {
    input_type?: number;
    input_validation_type?: number;
    format_type?: number;
    attribute_unit_list?: string[];
    max_value_count?: number;
  };
}

interface ItemLimit {
  response?: {
    price_limit?: { min_limit?: number; max_limit?: number };
    item_name_length_limit?: { min_limit?: number; max_limit?: number };
    item_image_count_limit?: { min_limit?: number; max_limit?: number };
    item_description_length_limit?: { min_limit?: number; max_limit?: number };
    tier_variation_name_length_limit?: { min_limit?: number; max_limit?: number };
    tier_variation_option_length_limit?: { min_limit?: number; max_limit?: number };
    dts_limit?: { non_pre_order_days_to_ship?: number };
    weight_limit?: { weight_mandatory?: boolean };
    dimension_limit?: { dimension_mandatory?: boolean };
    size_chart_limit?: { size_chart_mandatory?: boolean; support_image_size_chart?: boolean };
  };
}

interface ChannelList {
  response?: {
    logistics_channel_list?: {
      logistics_channel_id?: number | string;
      enabled?: boolean;
      fee_type?: string;
      mask_channel_id?: number | string;
    }[];
  };
}

const INPUT: Record<number, AttributeInput> = {
  1: "select",
  2: "select_or_text",
  3: "text",
  4: "multi_select",
  5: "multi_select_or_text",
};

const nameIn = (n: { name?: string; multi_lang?: { language?: string; value?: string }[] }) =>
  n.multi_lang?.find((m) => m.language?.toLowerCase() === LANGUAGE)?.value?.trim() || n.name?.trim() || "";

function grams(kg: string | number | undefined): number | null {
  const n = Number(kg);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
}

const clean = (s: string | undefined | null) => s?.trim() || null;

/** Shopee's attribute node as a category attribute; child attributes (shown for one value) are left out. */
export function shopeeAttribute(node: AttributeNode): CategoryAttribute | null {
  if (node.attribute_id === undefined) return null;
  const info = node.attribute_info ?? {};
  const validation = info.input_validation_type;
  return {
    externalId: String(node.attribute_id),
    name: nameIn(node),
    required: node.mandatory === true,
    input: INPUT[info.input_type ?? 3] ?? "text",
    values: (node.attribute_value_list ?? [])
      .filter((v) => v.value_id !== undefined)
      .map((v) => ({ externalId: String(v.value_id), name: nameIn(v) })),
    units: info.format_type === 2 ? (info.attribute_unit_list ?? []) : [],
    valueFormat: validation === 4 ? "date" : validation === 1 ? "integer" : validation === 3 ? "decimal" : null,
    maxValues: info.max_value_count && info.max_value_count > 0 ? info.max_value_count : null,
    requiredWhen: [],
  };
}

/** Plain text for add_item: Shopee's normal description takes no markup. */
function descriptionOf(item: BaseInfo): string {
  if (item.description_type === "extended") {
    return (item.description_info?.extended_description?.field_list ?? [])
      .filter((f) => f.field_type === "text" && f.text)
      .map((f) => f.text!.trim())
      .join("\n");
  }
  return item.description?.trim() ?? "";
}

/**
 * Logistics of a new item: the source item's channels when it comes from Shopee and the shop has them
 * enabled, otherwise every enabled checkout channel whose fee needs nothing else (fixed fee, or by size
 * when the package has dimensions). Size selection and custom fees are left for the Seller Centre.
 */
export function shopeeLogisticsFor(
  channels: NonNullable<NonNullable<ChannelList["response"]>["logistics_channel_list"]>,
  copied: unknown,
  hasDimensions: boolean,
): { logistic_id: unknown; enabled: boolean; is_free?: boolean; size_id?: unknown; shipping_fee?: number }[] {
  const enabled = channels.filter((c) => c.enabled && c.logistics_channel_id !== undefined);
  const enabledIds = new Set(enabled.map((c) => shopeeId(c.logistics_channel_id)));
  if (Array.isArray(copied)) {
    const kept = (
      copied as {
        logistic_id?: number | string;
        enabled?: boolean;
        is_free?: boolean;
        size_id?: number | string;
        shipping_fee?: number;
      }[]
    )
      .filter((c) => c.enabled && c.logistic_id !== undefined && enabledIds.has(shopeeId(c.logistic_id)))
      .map((c) => ({
        logistic_id: numericId(c.logistic_id!),
        enabled: true,
        ...(c.is_free !== undefined ? { is_free: c.is_free } : {}),
        ...(c.size_id ? { size_id: numericId(c.size_id) } : {}),
        ...(c.shipping_fee !== undefined ? { shipping_fee: c.shipping_fee } : {}),
      }));
    if (kept.length > 0) return kept;
  }
  return enabled
    .filter((c) => (c.mask_channel_id ?? 0) === 0)
    .filter((c) => c.fee_type === "FIXED_DEFAULT_PRICE" || (c.fee_type === "SIZE_INPUT" && hasDimensions))
    .map((c) => ({ logistic_id: numericId(c.logistics_channel_id!), enabled: true }));
}

function attributeList(attrs: ProductAttributeValue[]) {
  return attrs
    .filter((a) => a.values.length > 0)
    .map((a) => ({
      attribute_id: numericId(a.attributeId),
      attribute_value_list: a.values.map((v) =>
        v.externalId && v.externalId !== "0"
          ? { value_id: numericId(v.externalId), ...(v.unit ? { value_unit: v.unit } : {}) }
          : { value_id: 0, original_value_name: v.name ?? "", ...(v.unit ? { value_unit: v.unit } : {}) },
      ),
    }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `ids.shopLevel` is the warehouse id the connector gives stock without a location (shops without
 * multi-warehouse): such stock is sent without `location_id`, as Shopee requires.
 */
export function shopeeProducts(client: ShopeeClient, ids: { shopLevel: string }) {
  async function channels(shop: ShopCredentials) {
    const res = await client.shopCall<ChannelList>(shop, "GET", "/api/v2/logistics/get_channel_list");
    return res.response?.logistics_channel_list ?? [];
  }

  return {
    async get(shop: ShopCredentials, externalItemId: string): Promise<SourceProduct | null> {
      const base = await client.shopCall<{ response?: { item_list?: BaseInfo[] } }>(
        shop,
        "GET",
        "/api/v2/product/get_item_base_info",
        { query: { item_id_list: externalItemId, need_tax_info: "false", need_complaint_policy: "false" } },
      );
      const item = base.response?.item_list?.find((row) => shopeeId(row.item_id) === shopeeId(externalItemId));
      if (!item?.item_id) return null;
      let variationNames: string[] = [];
      let variants: SourceProduct["variants"];
      if (item.has_model) {
        const models = await client.shopCall<ModelList>(shop, "GET", "/api/v2/product/get_model_list", {
          query: { item_id: externalItemId },
        });
        const tiers = models.response?.tier_variation ?? [];
        variationNames = tiers.map((t) => t.name?.trim() ?? "");
        variants = (models.response?.model ?? [])
          .filter((m) => m.model_id !== undefined)
          .map((m) => {
            const index = m.tier_index ?? [];
            return {
              externalVariantId: String(m.model_id),
              sku: clean(m.model_sku),
              options: tiers.map((t, k) => t.option_list?.[index[k] ?? -1]?.option?.trim() ?? ""),
              price: toRupiah(m.price_info?.[0]?.original_price ?? m.price_info?.[0]?.current_price),
              stock: m.stock_info_v2?.summary_info?.total_available_stock ?? null,
              imageUrl: tiers[0]?.option_list?.[index[0] ?? -1]?.image?.image_url ?? null,
              gtin: clean(m.gtin_code),
            };
          });
      } else {
        variants = [
          {
            externalVariantId: "",
            sku: clean(item.item_sku),
            options: [],
            price: toRupiah(item.price_info?.[0]?.original_price ?? item.price_info?.[0]?.current_price),
            stock: item.stock_info_v2?.summary_info?.total_available_stock ?? null,
            imageUrl: null,
            gtin: item.gtin_code && item.gtin_code !== "00" ? item.gtin_code : null,
          },
        ];
      }
      const d = item.dimension;
      const brandName = clean(item.brand?.original_brand_name);
      return {
        externalItemId,
        title: item.item_name?.trim() ?? "",
        description: descriptionOf(item),
        descriptionHtml: null,
        category: { externalId: String(item.category_id ?? ""), name: null, path: null },
        brand:
          item.brand?.brand_id && item.brand.brand_id !== 0
            ? { externalId: String(item.brand.brand_id), name: brandName === "NoBrand" ? null : brandName }
            : null,
        attributes: (item.attribute_list ?? [])
          .filter((a) => a.attribute_id !== undefined)
          .map((a) => ({
            attributeId: String(a.attribute_id),
            name: clean(a.original_attribute_name),
            values: (a.attribute_value_list ?? []).map((v) => ({
              externalId: v.value_id ? String(v.value_id) : null,
              name: clean(v.original_value_name),
              unit: clean(v.value_unit),
            })),
          })),
        images: item.image?.image_url_list ?? [],
        weightG: grams(item.weight),
        dimensionsMm:
          d?.package_length && d.package_width && d.package_height
            ? { length: d.package_length * 10, width: d.package_width * 10, height: d.package_height * 10 }
            : null,
        condition: item.condition?.toUpperCase() === "USED" ? "used" : "new",
        preOrderDays: item.pre_order?.is_pre_order ? (item.pre_order.days_to_ship ?? null) : null,
        sizeChartImageUrl: clean(item.size_chart),
        itemSku: clean(item.item_sku),
        variationNames,
        variants,
        extras: {
          logistics: item.logistic_info ?? [],
          ...(item.item_dangerous !== undefined ? { itemDangerous: item.item_dangerous } : {}),
        },
      };
    },

    async categories(shop: ShopCredentials): Promise<MarketplaceCategory[]> {
      const res = await client.shopCall<{
        response?: {
          category_list?: {
            category_id?: number | string;
            parent_category_id?: number | string;
            original_category_name?: string;
            display_category_name?: string;
            has_children?: boolean;
          }[];
        };
      }>(shop, "GET", "/api/v2/product/get_category", { query: { language: LANGUAGE } });
      return (res.response?.category_list ?? [])
        .filter((c) => c.category_id !== undefined)
        .map((c) => ({
          externalId: String(c.category_id),
          parentExternalId: c.parent_category_id ? String(c.parent_category_id) : null,
          name: c.display_category_name?.trim() || c.original_category_name?.trim() || String(c.category_id),
          isLeaf: c.has_children !== true,
          permitted: true,
        }));
    },

    async recommendCategory(shop: ShopCredentials, input: { title: string }): Promise<string[]> {
      const res = await client.shopCall<{ response?: { category_id?: (number | string)[] } }>(
        shop,
        "GET",
        "/api/v2/product/category_recommend",
        { query: { item_name: input.title } },
      );
      return (res.response?.category_id ?? []).map(String);
    },

    async categoryRules(shop: ShopCredentials, categoryIds: string[]): Promise<CategoryRules[]> {
      const trees = new Map<string, AttributeNode[]>();
      for (let i = 0; i < categoryIds.length; i += ATTRIBUTE_BATCH) {
        const batch = categoryIds.slice(i, i + ATTRIBUTE_BATCH);
        const res = await client.shopCall<{
          response?: { list?: { category_id?: number | string; attribute_tree?: AttributeNode[] }[] };
        }>(shop, "GET", "/api/v2/product/get_attribute_tree", {
          query: { category_id_list: batch.join(","), language: LANGUAGE },
        });
        for (const c of res.response?.list ?? []) trees.set(String(c.category_id), c.attribute_tree ?? []);
      }
      const out: CategoryRules[] = [];
      for (const categoryId of categoryIds) {
        const limit = (
          await client.shopCall<ItemLimit>(shop, "GET", "/api/v2/product/get_item_limit", {
            query: { category_id: categoryId },
          })
        ).response;
        const brands = await client.shopCall<{ response?: { is_mandatory?: boolean } }>(
          shop,
          "GET",
          "/api/v2/product/get_brand_list",
          { query: { category_id: categoryId, status: "1", offset: "0", page_size: "1", language: LANGUAGE } },
        );
        out.push({
          categoryId,
          attributes: (trees.get(categoryId) ?? []).map(shopeeAttribute).filter((a): a is CategoryAttribute => !!a),
          brandRequired: brands.response?.is_mandatory === true,
          weightRequired: limit?.weight_limit?.weight_mandatory ?? true,
          dimensionsRequired: limit?.dimension_limit?.dimension_mandatory ?? false,
          sizeChart: {
            supported: limit?.size_chart_limit?.support_image_size_chart ?? false,
            required: limit?.size_chart_limit?.size_chart_mandatory ?? false,
          },
          certifications: [],
          daysToShip: limit?.dts_limit?.non_pre_order_days_to_ship ?? null,
          limits: {
            titleMin: limit?.item_name_length_limit?.min_limit ?? 1,
            titleMax: limit?.item_name_length_limit?.max_limit ?? 255,
            descriptionMin: limit?.item_description_length_limit?.min_limit ?? 0,
            descriptionMax: limit?.item_description_length_limit?.max_limit ?? 3000,
            imagesMin: limit?.item_image_count_limit?.min_limit ?? 1,
            imagesMax: limit?.item_image_count_limit?.max_limit ?? 9,
            priceMin: toRupiah(limit?.price_limit?.min_limit),
            priceMax: toRupiah(limit?.price_limit?.max_limit),
            variantsMax: 50,
            variationsMax: 2,
            variationNameMax: limit?.tier_variation_name_length_limit?.max_limit ?? 14,
            optionNameMax: limit?.tier_variation_option_length_limit?.max_limit ?? 20,
            skuMax: 100,
            skuNoSpaces: false,
          },
        });
      }
      return out;
    },

    async brands(shop: ShopCredentials, input: { categoryId: string; name?: string }): Promise<MarketplaceBrand[]> {
      const out: MarketplaceBrand[] = [];
      const wanted = input.name?.trim().toLowerCase();
      let offset = 0;
      for (let page = 0; page < BRAND_PAGES; page++) {
        const res = await client.shopCall<{
          response?: {
            brand_list?: { brand_id?: number | string; original_brand_name?: string; display_brand_name?: string }[];
            has_next_page?: boolean;
            next_offset?: number;
          };
        }>(shop, "GET", "/api/v2/product/get_brand_list", {
          query: {
            category_id: input.categoryId,
            status: "1",
            offset: String(offset),
            page_size: String(BRAND_PAGE),
            language: LANGUAGE,
          },
        });
        for (const b of res.response?.brand_list ?? []) {
          if (b.brand_id === undefined) continue;
          const name = b.display_brand_name?.trim() || b.original_brand_name?.trim() || "";
          if (
            wanted &&
            !name.toLowerCase().startsWith(wanted) &&
            !b.original_brand_name?.toLowerCase().startsWith(wanted)
          ) {
            continue;
          }
          out.push({ externalId: String(b.brand_id), name, selectable: true });
        }
        if (!res.response?.has_next_page) break;
        offset = res.response.next_offset ?? offset + BRAND_PAGE;
      }
      if (!out.some((b) => b.externalId === "0") && (!wanted || "no brand".startsWith(wanted))) out.unshift(NO_BRAND);
      return out;
    },

    async uploadImage(
      shop: ShopCredentials,
      image: { bytes: Uint8Array; contentType: string; use: "main" | "variant" | "description" | "size_chart" },
    ) {
      const ext = image.contentType.includes("png") ? "png" : "jpg";
      const res = await client.shopUpload<{
        response?: {
          image_info?: { image_id?: string; image_url_list?: { image_url_region?: string; image_url?: string }[] };
          image_info_list?: {
            error?: string;
            message?: string;
            image_info?: { image_id?: string; image_url_list?: { image_url_region?: string; image_url?: string }[] };
          }[];
        };
      }>(
        shop,
        "/api/v2/media_space/upload_image",
        fileForm(
          { field: "image", bytes: image.bytes, contentType: image.contentType, filename: `image.${ext}` },
          { scene: image.use === "description" ? "desc" : "normal" },
        ),
      );
      const listed = res.response?.image_info_list?.[0];
      if (listed?.error && listed.error !== "-") {
        throw new PermanentConnectorError({ code: listed.error, message: listed.message ?? "image upload failed" });
      }
      const info = res.response?.image_info ?? listed?.image_info;
      if (!info?.image_id)
        throw new PermanentConnectorError({ code: "no_image_id", message: "upload returned no image" });
      const urls = info.image_url_list ?? [];
      return {
        ref: info.image_id,
        url: urls.find((u) => u.image_url_region?.toUpperCase() === "ID")?.image_url ?? urls[0]?.image_url ?? null,
      };
    },

    async prerequisites(shop: ShopCredentials): Promise<string[]> {
      const list = await channels(shop);
      return list.some((c) => c.enabled)
        ? []
        : ["Belum ada jasa kirim yang aktif. Aktifkan minimal satu di Shopee Seller Centre."];
    },

    async create(
      shop: ShopCredentials,
      p: ProductToCreate,
      resume?: { externalItemId: string },
      hooks?: CreateHooks,
    ): Promise<CreatedProduct> {
      const location = p.warehouseId && p.warehouseId !== ids.shopLevel ? { location_id: p.warehouseId } : {};
      const single = p.variationNames.length === 0;
      let itemId = resume?.externalItemId;
      if (!itemId) {
        const logistics = shopeeLogisticsFor(await channels(shop), p.extras.logistics, !!p.dimensionsMm);
        if (logistics.length === 0) {
          throw new PermanentConnectorError({
            code: "no_logistics",
            message: "Tidak ada jasa kirim yang bisa dipakai produk ini. Aktifkan jasa kirim di Shopee Seller Centre.",
          });
        }
        const first = p.variants[0];
        const res = await client.shopCall<{ response?: { item_id?: number } }>(
          shop,
          "POST",
          "/api/v2/product/add_item",
          {
            body: {
              item_name: p.title,
              description: p.description,
              original_price: single ? (first?.price ?? 0) : Math.min(...p.variants.map((v) => v.price)),
              weight: Math.max(p.weightG, 1) / 1000,
              ...(p.dimensionsMm
                ? {
                    dimension: {
                      package_length: Math.max(1, Math.ceil(p.dimensionsMm.length / 10)),
                      package_width: Math.max(1, Math.ceil(p.dimensionsMm.width / 10)),
                      package_height: Math.max(1, Math.ceil(p.dimensionsMm.height / 10)),
                    },
                  }
                : {}),
              logistic_info: logistics,
              category_id: numericId(p.categoryId),
              image: { image_id_list: p.images },
              attribute_list: attributeList(p.attributes),
              brand: {
                brand_id: numericId(p.brand?.externalId ?? "0"),
                original_brand_name:
                  p.brand?.externalId && p.brand.externalId !== "0" ? (p.brand.name ?? "") : "NoBrand",
              },
              condition: p.condition === "used" ? "USED" : "NEW",
              item_status: "NORMAL",
              ...(p.itemSku ? { item_sku: p.itemSku } : {}),
              ...(p.preOrderDays ? { pre_order: { is_pre_order: true, days_to_ship: p.preOrderDays } } : {}),
              ...(single && first ? { seller_stock: [{ ...location, stock: first.stock }] } : {}),
              ...(single && first?.gtin ? { gtin_code: first.gtin } : {}),
              ...(p.sizeChartImage ? { size_chart_info: { size_chart: p.sizeChartImage } } : {}),
              ...(typeof p.extras.itemDangerous === "number" ? { item_dangerous: p.extras.itemDangerous } : {}),
            },
          },
        );
        if (!res.response?.item_id) {
          throw new PermanentConnectorError({ code: "no_item_id", message: "add_item returned no item" });
        }
        itemId = String(res.response.item_id);
        await hooks?.itemCreated?.(itemId);
        if (single)
          return {
            externalItemId: itemId,
            variants: first ? [{ key: first.key, externalVariantId: "" }] : [],
            warnings: [],
          };
        await sleep(client.config.variantDelayMs ?? 5000);
      } else if (single) {
        return {
          externalItemId: itemId,
          variants: p.variants[0] ? [{ key: p.variants[0].key, externalVariantId: "" }] : [],
          warnings: [],
        };
      } else {
        // continuing: the variations may have been added before the caller lost the answer
        const existing = await client.shopCall<ModelList>(shop, "GET", "/api/v2/product/get_model_list", {
          query: { item_id: itemId },
        });
        const models = existing.response?.model ?? [];
        if (models.length > 0) {
          const tiers = existing.response?.tier_variation ?? [];
          const byOptions = new Map(
            models
              .filter((m) => m.model_id !== undefined)
              .map((m) => [
                (m.tier_index ?? []).map((x, k) => tiers[k]?.option_list?.[x]?.option?.trim() ?? "").join("|"),
                String(m.model_id),
              ]),
          );
          return {
            externalItemId: itemId,
            variants: p.variants.flatMap((v) => {
              const id = byOptions.get(v.options.map((o) => o.trim()).join("|"));
              return id ? [{ key: v.key, externalVariantId: id }] : [];
            }),
            warnings: [],
          };
        }
      }

      // options in first-seen order, per variation; the first variation carries the option images
      const options = p.variationNames.map((_, k) => [...new Set(p.variants.map((v) => v.options[k] ?? ""))]);
      const imageOf = new Map(p.variants.filter((v) => v.image).map((v) => [v.options[0] ?? "", v.image!]));
      try {
        const res = await client.shopCall<{
          response?: { model?: { model_id?: number | string; tier_index?: number[] }[] };
        }>(shop, "POST", "/api/v2/product/init_tier_variation", {
          body: {
            item_id: numericId(itemId),
            standardise_tier_variation: p.variationNames.map((name, k) => ({
              variation_id: 0,
              variation_group_id: 0,
              variation_name: name,
              variation_option_list: options[k]!.map((option) => ({
                variation_option_id: 0,
                variation_option_name: option,
                ...(k === 0 && imageOf.get(option) ? { image_id: imageOf.get(option) } : {}),
              })),
            })),
            model: p.variants.map((v) => ({
              tier_index: v.options.map((o, k) => options[k]!.indexOf(o)),
              original_price: v.price,
              ...(v.sku ? { model_sku: v.sku } : {}),
              seller_stock: [{ ...location, stock: v.stock }],
              ...(v.gtin ? { gtin_code: v.gtin } : {}),
            })),
          },
        });
        const byIndex = new Map(
          (res.response?.model ?? [])
            .filter((m) => m.model_id !== undefined)
            .map((m) => [(m.tier_index ?? []).join(","), String(m.model_id)]),
        );
        return {
          externalItemId: itemId,
          variants: p.variants.flatMap((v) => {
            const id = byIndex.get(v.options.map((o, k) => options[k]!.indexOf(o)).join(","));
            return id ? [{ key: v.key, externalVariantId: id }] : [];
          }),
          warnings: [],
        };
      } catch (err) {
        throw isConnectorError(err) ? withCreatedItem(err, itemId) : err;
      }
    },
  };
}
