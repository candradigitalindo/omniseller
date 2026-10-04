import {
  type AttributeInput,
  type CategoryAttribute,
  type CategoryRules,
  type CreatedProduct,
  type CreateHooks,
  fileForm,
  type ImageUse,
  isConnectorError,
  type MarketplaceBrand,
  type MarketplaceCategory,
  PermanentConnectorError,
  type ProductToCreate,
  type ShopCredentials,
  type SourceProduct,
  toRupiah,
} from "@omniseller/connector-core";
import type { TiktokShopClient } from "./client.js";

/**
 * Creating products on TikTok Shop (Products API 202309; "Products API overview" usage flow), for
 * copying listings between shops (FR-PRD-13):
 * - Get Categories, Recommend Category (with the source platform's category and brand), Get
 *   Attributes, Get Category Rules, Get Brands: SEA shops must pass `category_version=v2` (the
 *   7-level tree), names in `id-ID`
 * - Upload Product Image (multipart, `use_case`); products may only use images hosted by TikTok Shop
 * - Check Listing Prerequisites (202312): shop readiness (warehouses, delivery options, limits)
 * - Create Product with `idempotency_key`, so a retried call creates the product once
 * Get Attributes spells its required flag `is_requried`; both spellings are read.
 */
export const CATEGORY_VERSION = "v2";
const LOCALE = "id-ID";
const BRAND_PAGES = 5;

interface Image {
  uri?: string;
  urls?: string[];
}

interface ProductDetail {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  integrated_platform_statuses?: { platform?: string; status?: string }[];
  main_images?: Image[];
  brand?: { id?: string; name?: string };
  category_chains?: { id?: string; parent_id?: string; local_name?: string; is_leaf?: boolean }[];
  product_attributes?: { id?: string; name?: string; values?: { id?: string; name?: string }[] }[];
  package_weight?: { value?: string; unit?: string };
  package_dimensions?: { length?: string; width?: string; height?: string; unit?: string };
  size_chart?: { image?: Image };
  is_pre_owned?: boolean;
  skus?: {
    id?: string;
    seller_sku?: string;
    price?: { tax_exclusive_price?: string; sale_price?: string; amount?: string };
    inventory?: { warehouse_id?: string; quantity?: number }[];
    sales_attributes?: { id?: string; name?: string; value_id?: string; value_name?: string; sku_img?: Image }[];
    identifier_code?: { code?: string; type?: string };
    pre_sale?: { fulfillment_type?: { handling_duration_days?: number } };
  }[];
}

interface AttributeData {
  attributes?: {
    id?: string;
    name?: string;
    type?: string;
    is_requried?: boolean;
    is_required?: boolean;
    values?: { id?: string; name?: string }[];
    value_data_format?: string;
    is_customizable?: boolean;
    is_multiple_selection?: boolean;
    requirement_conditions?: { condition_type?: string; attribute_id?: string; attribute_value_id?: string }[];
  }[];
}

interface RulesData {
  product_certifications?: { id?: string; name?: string; is_required?: boolean }[];
  size_chart?: { is_supported?: boolean; is_required?: boolean };
  package_dimension?: { is_required?: boolean };
}

const USE_CASE: Record<ImageUse, string> = {
  main: "MAIN_IMAGE",
  variant: "ATTRIBUTE_IMAGE",
  description: "DESCRIPTION_IMAGE",
  size_chart: "SIZE_CHART_IMAGE",
};

const clean = (s: string | undefined | null) => s?.trim() || null;

function grams(w: { value?: string; unit?: string } | undefined): number | null {
  const n = Number(String(w?.value ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (w?.unit ?? "KILOGRAM").toUpperCase();
  return Math.round(unit === "GRAM" ? n : unit === "POUND" ? n * 453.592 : n * 1000);
}

function millimetres(d: ProductDetail["package_dimensions"]) {
  const [l, w, h] = [Number(d?.length), Number(d?.width), Number(d?.height)];
  if (![l, w, h].every((x) => Number.isFinite(x) && x > 0)) return null;
  const factor = (d?.unit ?? "CENTIMETER").toUpperCase() === "INCH" ? 25.4 : 10;
  return { length: Math.round(l * factor), width: Math.round(w * factor), height: Math.round(h * factor) };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** Readable text from a product description in HTML: block ends become line breaks, tags go. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A plain-text description as HTML paragraphs, one per line. */
export function textToHtml(text: string): string {
  return text
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
}

/** Identifier type of a GTIN-shaped code: EAN-8/13, UPC-A, or GTIN-14. */
export function identifierType(code: string): string {
  return code.length === 12 ? "UPC" : code.length === 14 ? "GTIN" : "EAN";
}

export function tiktokAttribute(a: NonNullable<AttributeData["attributes"]>[number]): CategoryAttribute | null {
  if (!a.id || a.type === "SALES_PROPERTY") return null;
  const values = (a.values ?? [])
    .filter((v) => v.id)
    .map((v) => ({ externalId: String(v.id), name: v.name?.trim() ?? "" }));
  let input: AttributeInput;
  if (a.is_multiple_selection) input = a.is_customizable ? "multi_select_or_text" : "multi_select";
  else if (values.length > 0) input = a.is_customizable ? "select_or_text" : "select";
  else input = "text";
  return {
    externalId: String(a.id),
    name: a.name?.trim() ?? "",
    required: (a.is_requried ?? a.is_required) === true,
    input,
    values,
    units: [],
    valueFormat: a.value_data_format === "POSITIVE_INT_OR_DECIMAL" ? "decimal" : null,
    maxValues: a.is_multiple_selection ? null : 1,
    requiredWhen: (a.requirement_conditions ?? [])
      .filter((c) => c.condition_type === "VALUE_ID_MATCH" && c.attribute_id && c.attribute_value_id)
      .map((c) => ({ attributeId: String(c.attribute_id), valueId: String(c.attribute_value_id) })),
  };
}

const selectable = (b: { authorized_status?: string; brand_status?: string; is_t1_brand?: boolean }) =>
  b.authorized_status === "AUTHORIZED" ? b.brand_status !== "UNAVAILABLE" : b.is_t1_brand !== true;

export function tiktokProducts(client: TiktokShopClient) {
  const get = <T>(shop: ShopCredentials, path: string, query?: Record<string, string>) =>
    client.call<T>({
      method: "GET",
      path,
      accessToken: shop.accessToken,
      shopCipher: shop.shopCipher,
      ...(query ? { query } : {}),
    });
  const post = <T>(shop: ShopCredentials, path: string, body: object) =>
    client.call<T>({ method: "POST", path, accessToken: shop.accessToken, shopCipher: shop.shopCipher, body });

  async function brands(
    shop: ShopCredentials,
    input: { categoryId: string; name?: string },
  ): Promise<MarketplaceBrand[]> {
    const out: MarketplaceBrand[] = [];
    let token: string | undefined;
    for (let page = 0; page < BRAND_PAGES; page++) {
      const data = await get<{
        brands?: {
          id?: string;
          name?: string;
          authorized_status?: string;
          brand_status?: string;
          is_t1_brand?: boolean;
        }[];
        next_page_token?: string;
      }>(shop, "/product/202309/brands", {
        category_id: input.categoryId,
        category_version: CATEGORY_VERSION,
        page_size: "100",
        ...(input.name ? { brand_name: input.name } : {}),
        ...(token ? { page_token: token } : {}),
      });
      for (const b of data.brands ?? []) {
        if (b.id) out.push({ externalId: String(b.id), name: b.name?.trim() ?? "", selectable: selectable(b) });
      }
      token = data.next_page_token || undefined;
      if (!token) break;
    }
    return out;
  }

  return {
    async get(shop: ShopCredentials, externalItemId: string): Promise<SourceProduct | null> {
      let p: ProductDetail;
      try {
        p = await get<ProductDetail>(shop, `/product/202309/products/${encodeURIComponent(externalItemId)}`);
      } catch (err) {
        if (isConnectorError(err) && err.kind === "permanent" && /not\s*exist|not\s*found/i.test(err.message))
          return null;
        throw err;
      }
      const chain = p.category_chains ?? [];
      const leaf = chain.find((c) => c.is_leaf) ?? chain[chain.length - 1];
      const skus = (p.skus ?? []).filter((s) => s.id);
      const variationNames = (skus[0]?.sales_attributes ?? []).map((a) => a.name?.trim() ?? "");
      const descriptionHtml = p.description?.trim() || null;
      return {
        externalItemId,
        title: p.title?.trim() ?? "",
        description: descriptionHtml ? htmlToText(descriptionHtml) : "",
        descriptionHtml,
        category: {
          externalId: String(leaf?.id ?? ""),
          name: clean(leaf?.local_name),
          path:
            chain
              .map((c) => c.local_name?.trim())
              .filter(Boolean)
              .join(" > ") || null,
        },
        brand: p.brand?.id ? { externalId: String(p.brand.id), name: clean(p.brand.name) } : null,
        attributes: (p.product_attributes ?? [])
          .filter((a) => a.id)
          .map((a) => ({
            attributeId: String(a.id),
            name: clean(a.name),
            values: (a.values ?? []).map((v) => ({ externalId: v.id ? String(v.id) : null, name: clean(v.name) })),
          })),
        images: (p.main_images ?? []).map((i) => i.urls?.[0]).filter((u): u is string => !!u),
        weightG: grams(p.package_weight),
        dimensionsMm: millimetres(p.package_dimensions),
        condition: p.is_pre_owned ? "used" : "new",
        preOrderDays: skus[0]?.pre_sale?.fulfillment_type?.handling_duration_days ?? null,
        sizeChartImageUrl: p.size_chart?.image?.urls?.[0] ?? null,
        itemSku: null,
        variationNames: variationNames.filter(Boolean).length === variationNames.length ? variationNames : [],
        variants: skus.map((s) => {
          const attrs = s.sales_attributes ?? [];
          return {
            externalVariantId: String(s.id),
            sku: clean(s.seller_sku),
            options: variationNames.map((name) => attrs.find((a) => a.name?.trim() === name)?.value_name?.trim() ?? ""),
            price: toRupiah(s.price?.tax_exclusive_price ?? s.price?.sale_price ?? s.price?.amount),
            stock: s.inventory ? s.inventory.reduce((n, i) => n + Number(i.quantity ?? 0), 0) : null,
            imageUrl: attrs.find((a) => a.sku_img?.urls?.[0])?.sku_img?.urls?.[0] ?? null,
            gtin: clean(s.identifier_code?.code),
          };
        }),
        extras: {},
      };
    },

    async categories(shop: ShopCredentials): Promise<MarketplaceCategory[]> {
      const data = await get<{
        categories?: {
          id?: string;
          parent_id?: string;
          local_name?: string;
          is_leaf?: boolean;
          permission_statuses?: string[];
        }[];
      }>(shop, "/product/202309/categories", { locale: LOCALE, category_version: CATEGORY_VERSION });
      return (data.categories ?? [])
        .filter((c) => c.id)
        .map((c) => ({
          externalId: String(c.id),
          parentExternalId: c.parent_id && c.parent_id !== "0" ? String(c.parent_id) : null,
          name: c.local_name?.trim() || String(c.id),
          isLeaf: c.is_leaf === true,
          permitted: !c.permission_statuses?.length || c.permission_statuses.includes("AVAILABLE"),
        }));
    },

    async recommendCategory(
      shop: ShopCredentials,
      input: {
        title: string;
        description: string;
        source?: { categoryId: string; categoryName: string | null; categoryPath: string | null; brand: string | null };
      },
    ): Promise<string[]> {
      try {
        const data = await post<{
          leaf_category_id?: string;
          categories?: { id?: string; is_leaf?: boolean; permission_statuses?: string[] }[];
        }>(shop, "/product/202309/categories/recommend", {
          product_title: input.title,
          ...(input.description ? { description: textToHtml(input.description).slice(0, 10_000) } : {}),
          category_version: CATEGORY_VERSION,
          locale: LOCALE,
          ...(input.source
            ? {
                origin_platform_category: {
                  id: input.source.categoryId,
                  ...(input.source.categoryName ? { name: input.source.categoryName } : {}),
                  ...(input.source.categoryPath ? { full_name: input.source.categoryPath } : {}),
                  is_leaf: true,
                },
                ...(input.source.brand ? { origin_platform_vendor: input.source.brand } : {}),
              }
            : {}),
        });
        const leaves = (data.categories ?? [])
          .filter(
            (c) => c.id && c.is_leaf && (!c.permission_statuses?.length || c.permission_statuses.includes("AVAILABLE")),
          )
          .map((c) => String(c.id));
        return [...new Set([...(data.leaf_category_id ? [String(data.leaf_category_id)] : []), ...leaves])];
      } catch (err) {
        // a title TikTok Shop cannot place (too short, no match) gets no suggestion, not a failed copy
        if (isConnectorError(err) && err.kind === "permanent") return [];
        throw err;
      }
    },

    async categoryRules(shop: ShopCredentials, categoryIds: string[]): Promise<CategoryRules[]> {
      const out: CategoryRules[] = [];
      for (const categoryId of categoryIds) {
        const query = { locale: LOCALE, category_version: CATEGORY_VERSION };
        const attrs = await get<AttributeData>(
          shop,
          `/product/202309/categories/${encodeURIComponent(categoryId)}/attributes`,
          query,
        );
        const rules = await get<RulesData>(
          shop,
          `/product/202309/categories/${encodeURIComponent(categoryId)}/rules`,
          query,
        );
        out.push({
          categoryId,
          attributes: (attrs.attributes ?? []).map(tiktokAttribute).filter((a): a is CategoryAttribute => !!a),
          brandRequired: false,
          weightRequired: true,
          dimensionsRequired: rules.package_dimension?.is_required === true,
          sizeChart: {
            supported: rules.size_chart?.is_supported === true,
            required: rules.size_chart?.is_required === true,
          },
          certifications: (rules.product_certifications ?? [])
            .filter((c) => c.is_required)
            .map((c) => c.name ?? String(c.id)),
          daysToShip: null,
          limits: {
            titleMin: 25,
            titleMax: 255,
            descriptionMin: 1,
            descriptionMax: 10_000,
            imagesMin: 1,
            imagesMax: 9,
            priceMin: null,
            priceMax: null,
            variantsMax: 100,
            variationsMax: 3,
            variationNameMax: 20,
            optionNameMax: 50,
            skuMax: 50,
            skuNoSpaces: true,
          },
        });
      }
      return out;
    },

    brands,

    async uploadImage(shop: ShopCredentials, image: { bytes: Uint8Array; contentType: string; use: ImageUse }) {
      const ext = image.contentType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
      const data = await client.upload<{ uri?: string; url?: string }>({
        path: "/product/202309/images/upload",
        accessToken: shop.accessToken,
        shopCipher: shop.shopCipher,
        form: fileForm(
          { field: "data", bytes: image.bytes, contentType: image.contentType, filename: `image.${ext}` },
          { use_case: USE_CASE[image.use] },
        ),
      });
      if (!data.uri) throw new PermanentConnectorError({ code: "no_image_uri", message: "upload returned no image" });
      return { ref: data.uri, url: data.url ?? null };
    },

    async prerequisites(shop: ShopCredentials): Promise<string[]> {
      const data = await get<{
        check_results?: { check_item?: string; is_failed?: boolean; fail_reasons?: string[] }[];
      }>(shop, "/product/202312/prerequisites");
      return (data.check_results ?? [])
        .filter((c) => c.is_failed)
        .flatMap((c) => (c.fail_reasons?.length ? c.fail_reasons : [`${c.check_item ?? "?"} belum memenuhi syarat.`]));
    },

    async create(
      shop: ShopCredentials,
      p: ProductToCreate,
      resume?: { externalItemId: string },
      hooks?: CreateHooks,
    ): Promise<CreatedProduct> {
      if (resume) {
        // the product exists (an earlier request created it): its SKUs, by seller SKU or by values
        const existing = await get<ProductDetail>(
          shop,
          `/product/202309/products/${encodeURIComponent(resume.externalItemId)}`,
        );
        const skus = (existing.skus ?? []).filter((s) => s.id);
        const valuesOf = (s: (typeof skus)[number]) =>
          p.variationNames
            .map((name) => (s.sales_attributes ?? []).find((a) => a.name?.trim() === name)?.value_name?.trim() ?? "")
            .join("|");
        return {
          externalItemId: resume.externalItemId,
          variants: p.variants.flatMap((v) => {
            const found =
              (v.sku ? skus.find((s) => s.seller_sku === v.sku) : undefined) ??
              skus.find((s) => valuesOf(s) === v.options.map((o) => o.trim()).join("|"));
            return found ? [{ key: v.key, externalVariantId: String(found.id) }] : [];
          }),
          warnings: [],
        };
      }
      const warnings: string[] = [];
      let brandId = p.brand?.externalId ?? null;
      if (!brandId && p.brand?.name) {
        const wanted = p.brand.name.trim().toLowerCase();
        const found = (await brands(shop, { categoryId: p.categoryId, name: p.brand.name })).find(
          (b) => b.selectable && b.name.toLowerCase() === wanted,
        );
        if (found) brandId = found.externalId;
        else warnings.push(`Merek ${p.brand.name} tidak bisa dipakai di TikTok Shop; produk dibuat tanpa merek.`);
      }
      // images on the first variation must cover every value of it, or none
      const firstValues = [...new Set(p.variants.map((v) => v.options[0] ?? ""))];
      const imageOf = new Map(p.variants.filter((v) => v.image).map((v) => [v.options[0] ?? "", v.image!]));
      const withImages = p.variationNames.length > 0 && firstValues.every((value) => imageOf.has(value));
      const weightKg = (Math.max(p.weightG, 1) / 1000).toFixed(3).replace(/\.?0+$/, "");
      const data = await post<{
        product_id?: string;
        skus?: { id?: string; seller_sku?: string }[];
        warnings?: { message?: string }[];
      }>(shop, "/product/202309/products", {
        save_mode: "LISTING",
        idempotency_key: p.idempotencyKey.slice(0, 128),
        title: p.title,
        description: p.descriptionHtml ?? textToHtml(p.description),
        category_id: p.categoryId,
        category_version: CATEGORY_VERSION,
        ...(brandId ? { brand_id: brandId } : {}),
        main_images: p.images.map((uri) => ({ uri })),
        skus: p.variants.map((v) => ({
          ...(p.variationNames.length > 0
            ? {
                sales_attributes: p.variationNames.map((name, k) => ({
                  name,
                  value_name: v.options[k] ?? "",
                  ...(k === 0 && withImages ? { sku_img: { uri: imageOf.get(v.options[0] ?? "") } } : {}),
                })),
              }
            : {}),
          inventory: [
            { warehouse_id: p.warehouseId ?? "", ...(v.stock > 0 ? { quantity: Math.min(v.stock, 99_999) } : {}) },
          ],
          ...(v.sku ? { seller_sku: v.sku } : {}),
          price: { amount: String(v.price), currency: "IDR" },
          ...(v.gtin ? { identifier_code: { code: v.gtin, type: identifierType(v.gtin) } } : {}),
        })),
        package_weight: { value: weightKg, unit: "KILOGRAM" },
        ...(p.dimensionsMm
          ? {
              package_dimensions: {
                length: String(Math.max(1, Math.ceil(p.dimensionsMm.length / 10))),
                width: String(Math.max(1, Math.ceil(p.dimensionsMm.width / 10))),
                height: String(Math.max(1, Math.ceil(p.dimensionsMm.height / 10))),
                unit: "CENTIMETER",
              },
            }
          : {}),
        product_attributes: p.attributes
          .filter((a) => a.values.length > 0)
          .map((a) => ({
            id: a.attributeId,
            values: a.values.map((v) => (v.externalId ? { id: v.externalId } : { name: v.name ?? "" })),
          })),
        ...(p.sizeChartImage ? { size_chart: { image: { uri: p.sizeChartImage } } } : {}),
      });
      if (!data.product_id)
        throw new PermanentConnectorError({ code: "no_product_id", message: "Create Product returned no id" });
      await hooks?.itemCreated?.(String(data.product_id));
      const skus = data.skus ?? [];
      const bySku = new Map(skus.filter((s) => s.seller_sku).map((s) => [s.seller_sku!, String(s.id)]));
      const uniqueSkus = new Set(p.variants.map((v) => v.sku)).size === p.variants.length;
      return {
        externalItemId: String(data.product_id),
        variants: p.variants.flatMap((v, i) => {
          const id = (uniqueSkus && v.sku ? bySku.get(v.sku) : undefined) ?? skus[i]?.id;
          return id ? [{ key: v.key, externalVariantId: String(id) }] : [];
        }),
        warnings: [...warnings, ...(data.warnings ?? []).map((w) => w.message ?? "").filter(Boolean)],
      };
    },
  };
}
