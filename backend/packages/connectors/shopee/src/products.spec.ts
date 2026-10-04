import {
  type CallRecord,
  isConnectorError,
  PermanentConnectorError,
  type ProductToCreate,
} from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { createShopeeConnector } from "./connector.js";
import { shopeeAttribute, shopeeLogisticsFor } from "./products.js";

type Handler = (url: URL, init: RequestInit) => unknown;

function fakeFetch(routes: Record<string, Handler>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const route = routes[`${init.method ?? "GET"} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: "error_param", message: "no route" }), { status: 404 });
    const out = route(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

function connector(fetchImpl: typeof fetch, observer?: (r: CallRecord) => void) {
  return createShopeeConnector({
    partnerId: 2001887,
    partnerKey: "partner-key-for-tests",
    apiBaseUrl: "https://partner.shopeemobile.com",
    authBaseUrl: "https://open.shopee.com",
    http: { fetch: fetchImpl, ...(observer ? { observer } : {}) },
    variantDelayMs: 0,
  });
}

const shop = { externalShopId: "14701711", accessToken: "token", shopCipher: null };
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body));

const channels = {
  error: "",
  response: {
    logistics_channel_list: [
      { logistics_channel_id: 8003, enabled: true, fee_type: "SIZE_SELECTION", mask_channel_id: 0 },
      { logistics_channel_id: 8005, enabled: true, fee_type: "FIXED_DEFAULT_PRICE", mask_channel_id: 0 },
      { logistics_channel_id: 80020, enabled: true, fee_type: "FIXED_DEFAULT_PRICE", mask_channel_id: 8000 },
      { logistics_channel_id: 8006, enabled: false, fee_type: "FIXED_DEFAULT_PRICE", mask_channel_id: 0 },
      { logistics_channel_id: 8007, enabled: true, fee_type: "SIZE_INPUT", mask_channel_id: 0 },
    ],
  },
};

function product(over: Partial<ProductToCreate> = {}): ProductToCreate {
  return {
    idempotencyKey: "copy-1",
    title: "Kaos Polos Katun Combed 30s",
    description: "Bahan adem.\nUkuran pas.",
    descriptionHtml: null,
    categoryId: "100017",
    brand: null,
    attributes: [
      { attributeId: "100134", name: "Bahan", values: [{ externalId: "1234", name: "Katun" }] },
      { attributeId: "100010", name: "Berat Bersih", values: [{ externalId: null, name: "180", unit: "g" }] },
      { attributeId: "100011", name: "Kosong", values: [] },
    ],
    images: ["img-1", "img-2"],
    weightG: 250,
    dimensionsMm: { length: 301, width: 200, height: 25 },
    condition: "new",
    preOrderDays: null,
    itemSku: "KAOS",
    sizeChartImage: null,
    variationNames: ["Warna", "Ukuran"],
    variants: [
      { key: "v1", sku: "KAOS-HTM-M", options: ["Hitam", "M"], price: 55_000, stock: 7, image: "img-h", gtin: null },
      { key: "v2", sku: "KAOS-HTM-L", options: ["Hitam", "L"], price: 57_000, stock: 0, image: "img-h", gtin: null },
      {
        key: "v3",
        sku: "KAOS-PTH-M",
        options: ["Putih", "M"],
        price: 55_000,
        stock: 3,
        image: null,
        gtin: "8991234567891",
      },
    ],
    warehouseId: null,
    extras: {},
    ...over,
  };
}

describe("Shopee products: reading a product to copy", () => {
  it("maps base info and models: tiers in order, original prices, units, extended description", async () => {
    const f = fakeFetch({
      "GET /api/v2/product/get_item_base_info": () => ({
        error: "",
        response: {
          item_list: [
            {
              item_id: 800123,
              category_id: 100017,
              item_name: " Kaos Polos ",
              description_type: "extended",
              description_info: {
                extended_description: {
                  field_list: [
                    { field_type: "text", text: "Bahan adem." },
                    { field_type: "image", image_info: { image_id: "x" } },
                    { field_type: "text", text: "Ukuran pas." },
                  ],
                },
              },
              item_sku: "KAOS",
              attribute_list: [
                {
                  attribute_id: 100010,
                  original_attribute_name: "Berat Bersih",
                  attribute_value_list: [{ value_id: 0, original_value_name: "180", value_unit: "g" }],
                },
              ],
              image: { image_url_list: ["https://cf.shopee.co.id/file/a", "https://cf.shopee.co.id/file/b"] },
              weight: "0.25",
              dimension: { package_length: 30, package_width: 20, package_height: 3 },
              logistic_info: [{ logistic_id: 8005, enabled: true, is_free: false }],
              pre_order: { is_pre_order: true, days_to_ship: 7 },
              condition: "NEW",
              has_model: true,
              brand: { brand_id: 0, original_brand_name: "NoBrand" },
              item_dangerous: 0,
            },
          ],
        },
      }),
      "GET /api/v2/product/get_model_list": (url) => {
        expect(url.searchParams.get("item_id")).toBe("800123");
        return {
          error: "",
          response: {
            tier_variation: [
              {
                name: "Warna",
                option_list: [
                  { option: "Hitam", image: { image_url: "https://cf.shopee.co.id/file/h" } },
                  { option: "Putih" },
                ],
              },
              { name: "Ukuran", option_list: [{ option: "M" }, { option: "L" }] },
            ],
            model: [
              {
                model_id: 9001,
                model_sku: "KAOS-PTH-L",
                tier_index: [1, 1],
                price_info: [{ original_price: 60000, current_price: 45000 }],
                stock_info_v2: { summary_info: { total_available_stock: 4 } },
              },
              {
                model_id: 9002,
                model_sku: "KAOS-HTM-M",
                tier_index: [0, 0],
                price_info: [{ original_price: 55000, current_price: 55000 }],
                stock_info_v2: { summary_info: { total_available_stock: 0 } },
                gtin_code: "8991234567891",
              },
            ],
          },
        };
      },
    });
    const p = await connector(f.fn).products.get(shop, "800123");
    expect(p).toMatchObject({
      externalItemId: "800123",
      title: "Kaos Polos",
      description: "Bahan adem.\nUkuran pas.",
      descriptionHtml: null,
      category: { externalId: "100017" },
      brand: null,
      images: ["https://cf.shopee.co.id/file/a", "https://cf.shopee.co.id/file/b"],
      weightG: 250,
      dimensionsMm: { length: 300, width: 200, height: 30 },
      condition: "new",
      preOrderDays: 7,
      itemSku: "KAOS",
      variationNames: ["Warna", "Ukuran"],
      extras: { logistics: [{ logistic_id: 8005, enabled: true, is_free: false }], itemDangerous: 0 },
    });
    expect(p?.attributes).toEqual([
      { attributeId: "100010", name: "Berat Bersih", values: [{ externalId: null, name: "180", unit: "g" }] },
    ]);
    expect(p?.variants).toEqual([
      {
        externalVariantId: "9001",
        sku: "KAOS-PTH-L",
        options: ["Putih", "L"],
        price: 60_000,
        stock: 4,
        imageUrl: null,
        gtin: null,
      },
      {
        externalVariantId: "9002",
        sku: "KAOS-HTM-M",
        options: ["Hitam", "M"],
        price: 55_000,
        stock: 0,
        imageUrl: "https://cf.shopee.co.id/file/h",
        gtin: "8991234567891",
      },
    ]);
  });

  it("reads an item without models as one variant keyed like the catalog (empty variant id)", async () => {
    const f = fakeFetch({
      "GET /api/v2/product/get_item_base_info": () => ({
        error: "",
        response: {
          item_list: [
            {
              item_id: 800124,
              category_id: 100017,
              item_name: "Topi",
              description: "Topi rajut",
              item_sku: "TOPI",
              price_info: [{ original_price: 30000, current_price: 25000 }],
              stock_info_v2: { summary_info: { total_available_stock: 12 } },
              has_model: false,
              brand: { brand_id: 1123, original_brand_name: "Rajutku" },
              gtin_code: "00",
              condition: "USED",
            },
          ],
        },
      }),
    });
    const p = await connector(f.fn).products.get(shop, "800124");
    expect(f.calls.map((c) => c.url.pathname)).toEqual(["/api/v2/product/get_item_base_info"]);
    expect(p).toMatchObject({
      description: "Topi rajut",
      brand: { externalId: "1123", name: "Rajutku" },
      condition: "used",
      preOrderDays: null,
      variationNames: [],
      variants: [{ externalVariantId: "", sku: "TOPI", options: [], price: 30_000, stock: 12, gtin: null }],
    });
  });

  it("answers null for an item the shop no longer has", async () => {
    const f = fakeFetch({
      "GET /api/v2/product/get_item_base_info": () => ({ error: "", response: { item_list: [] } }),
    });
    expect(await connector(f.fn).products.get(shop, "1")).toBeNull();
  });
});

describe("Shopee products: reference data", () => {
  it("reads the category tree in Indonesian; only categories without children are leaves", async () => {
    const f = fakeFetch({
      "GET /api/v2/product/get_category": (url) => {
        expect(url.searchParams.get("language")).toBe("id");
        return {
          error: "",
          response: {
            category_list: [
              { category_id: 100, parent_category_id: 0, original_category_name: "Fashion", has_children: true },
              {
                category_id: 100017,
                parent_category_id: 100,
                original_category_name: "T-Shirts",
                display_category_name: "Kaos",
                has_children: false,
              },
            ],
          },
        };
      },
    });
    expect(await connector(f.fn).products.categories(shop)).toEqual([
      { externalId: "100", parentExternalId: null, name: "Fashion", isLeaf: false, permitted: true },
      { externalId: "100017", parentExternalId: "100", name: "Kaos", isLeaf: true, permitted: true },
    ]);
  });

  it("asks category_recommend with the item name (GET)", async () => {
    const f = fakeFetch({
      "GET /api/v2/product/category_recommend": (url) => {
        expect(url.searchParams.get("item_name")).toBe("Kaos Polos Katun");
        return { error: "", response: { category_id: [100017, 100018] } };
      },
    });
    expect(
      await connector(f.fn).products.recommendCategory(shop, { title: "Kaos Polos Katun", description: "" }),
    ).toEqual(["100017", "100018"]);
  });

  it("reads attribute trees 20 categories per call and limits per category", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => String(200000 + i));
    const f = fakeFetch({
      "GET /api/v2/product/get_attribute_tree": (url) => {
        const list = url.searchParams.get("category_id_list")!.split(",");
        return {
          error: "",
          response: {
            list: list.map((id) => ({
              category_id: Number(id),
              attribute_tree: [
                {
                  attribute_id: 100134,
                  mandatory: true,
                  name: "Material",
                  multi_lang: [{ language: "id", value: "Bahan" }],
                  attribute_value_list: [
                    { value_id: 1234, name: "Cotton", multi_lang: [{ language: "id", value: "Katun" }] },
                  ],
                  attribute_info: { input_type: 2, input_validation_type: 2, format_type: 1, max_value_count: 1 },
                },
                {
                  attribute_id: 100010,
                  mandatory: false,
                  name: "Berat Bersih",
                  attribute_info: {
                    input_type: 3,
                    input_validation_type: 3,
                    format_type: 2,
                    attribute_unit_list: ["g", "kg"],
                  },
                },
              ],
            })),
          },
        };
      },
      "GET /api/v2/product/get_item_limit": () => ({
        error: "",
        response: {
          price_limit: { min_limit: 99, max_limit: 150000000 },
          item_name_length_limit: { min_limit: 20, max_limit: 255 },
          item_image_count_limit: { min_limit: 1, max_limit: 9 },
          item_description_length_limit: { min_limit: 20, max_limit: 3000 },
          tier_variation_name_length_limit: { min_limit: 1, max_limit: 14 },
          tier_variation_option_length_limit: { min_limit: 1, max_limit: 30 },
          dts_limit: { non_pre_order_days_to_ship: 2 },
          weight_limit: { weight_mandatory: true },
          dimension_limit: { dimension_mandatory: false },
          size_chart_limit: { size_chart_mandatory: false, support_image_size_chart: true },
        },
      }),
      "GET /api/v2/product/get_brand_list": (url) => {
        expect(url.searchParams.get("status")).toBe("1");
        return {
          error: "",
          response: { brand_list: [], is_mandatory: url.searchParams.get("category_id") === ids[0] },
        };
      },
    });
    const rules = await connector(f.fn).products.categoryRules(shop, ids);
    const trees = f.calls.filter((c) => c.url.pathname.endsWith("get_attribute_tree"));
    expect(trees.map((c) => c.url.searchParams.get("category_id_list")!.split(",").length)).toEqual([20, 1]);
    expect(rules).toHaveLength(21);
    expect(rules[0]).toMatchObject({
      categoryId: ids[0],
      brandRequired: true,
      weightRequired: true,
      dimensionsRequired: false,
      sizeChart: { supported: true, required: false },
      daysToShip: 2,
      limits: {
        titleMin: 20,
        titleMax: 255,
        descriptionMin: 20,
        descriptionMax: 3000,
        priceMin: 99,
        priceMax: 150_000_000,
        variantsMax: 50,
        variationsMax: 2,
        variationNameMax: 14,
        optionNameMax: 30,
        skuNoSpaces: false,
      },
    });
    expect(rules[1]?.brandRequired).toBe(false);
    expect(rules[0]?.attributes).toEqual([
      {
        externalId: "100134",
        name: "Bahan",
        required: true,
        input: "select_or_text",
        values: [{ externalId: "1234", name: "Katun" }],
        units: [],
        valueFormat: null,
        maxValues: 1,
        requiredWhen: [],
      },
      {
        externalId: "100010",
        name: "Berat Bersih",
        required: false,
        input: "text",
        values: [],
        units: ["g", "kg"],
        valueFormat: "decimal",
        maxValues: null,
        requiredWhen: [],
      },
    ]);
  });

  it("maps every documented input type and validation type", () => {
    const of = (input_type: number, input_validation_type?: number) =>
      shopeeAttribute({ attribute_id: 1, name: "a", attribute_info: { input_type, input_validation_type } });
    expect([1, 2, 3, 4, 5].map((t) => of(t)?.input)).toEqual([
      "select",
      "select_or_text",
      "text",
      "multi_select",
      "multi_select_or_text",
    ]);
    expect([0, 1, 2, 3, 4].map((v) => of(3, v)?.valueFormat)).toEqual([null, "integer", null, "decimal", "date"]);
  });

  it("filters brands by name prefix across pages and offers No Brand (brand_id 0)", async () => {
    const f = fakeFetch({
      "GET /api/v2/product/get_brand_list": (url) =>
        url.searchParams.get("offset") === "0"
          ? {
              error: "",
              response: {
                brand_list: [
                  { brand_id: 11, original_brand_name: "Rajutku" },
                  { brand_id: 12, original_brand_name: "Lain" },
                ],
                has_next_page: true,
                next_offset: 100,
              },
            }
          : {
              error: "",
              response: { brand_list: [{ brand_id: 13, original_brand_name: "rajut indah" }], has_next_page: false },
            },
    });
    const c = connector(f.fn);
    expect(await c.products.brands(shop, { categoryId: "100017", name: "Rajut" })).toEqual([
      { externalId: "11", name: "Rajutku", selectable: true },
      { externalId: "13", name: "rajut indah", selectable: true },
    ]);
    expect((await c.products.brands(shop, { categoryId: "100017" }))[0]).toEqual({
      externalId: "0",
      name: "No Brand",
      selectable: true,
    });
  });

  it("uploads an image as multipart field image with its scene; the call record keeps only size and type", async () => {
    const records: CallRecord[] = [];
    const f = fakeFetch({
      "POST /api/v2/media_space/upload_image": (url, init) => {
        expect(url.searchParams.get("shop_id")).toBe("14701711");
        expect(url.searchParams.get("sign")).toMatch(/^[0-9a-f]{64}$/);
        const form = init.body as FormData;
        expect(form.get("scene")).toBe("normal");
        const file = form.get("image") as File;
        expect(file.type).toBe("image/png");
        expect(file.size).toBe(4);
        return {
          error: "",
          response: {
            image_info: {
              image_id: "id-img-1",
              image_url_list: [
                { image_url_region: "SG", image_url: "https://cf.shopee.sg/file/id-img-1" },
                { image_url_region: "ID", image_url: "https://cf.shopee.co.id/file/id-img-1" },
              ],
            },
          },
        };
      },
    });
    const out = await connector(f.fn, (r) => records.push(r)).products.uploadImage(shop, {
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentType: "image/png",
      use: "variant",
    });
    expect(out).toEqual({ ref: "id-img-1", url: "https://cf.shopee.co.id/file/id-img-1" });
    expect(records[0]?.request).toEqual({ scene: "normal", image: { bytes: 4, contentType: "image/png" } });
  });

  it("treats an error inside image_info_list as a failed upload", async () => {
    const f = fakeFetch({
      "POST /api/v2/media_space/upload_image": () => ({
        error: "",
        response: { image_info_list: [{ error: "error_image_size", message: "image is too large" }] },
      }),
    });
    await expect(
      connector(f.fn).products.uploadImage(shop, {
        bytes: new Uint8Array([1]),
        contentType: "image/jpeg",
        use: "description",
      }),
    ).rejects.toThrow(PermanentConnectorError);
    expect((f.calls[0]!.init.body as FormData).get("scene")).toBe("desc");
  });

  it("needs at least one enabled logistics channel before listing", async () => {
    const none = fakeFetch({
      "GET /api/v2/logistics/get_channel_list": () => ({
        error: "",
        response: { logistics_channel_list: [{ logistics_channel_id: 8005, enabled: false }] },
      }),
    });
    expect(await connector(none.fn).products.prerequisites(shop)).toHaveLength(1);
    const some = fakeFetch({ "GET /api/v2/logistics/get_channel_list": () => channels });
    expect(await connector(some.fn).products.prerequisites(shop)).toEqual([]);
  });
});

describe("Shopee products: creating a product", () => {
  it("chooses logistics: the copied channels still enabled, else fixed-fee checkout channels", () => {
    const list = channels.response.logistics_channel_list;
    expect(
      shopeeLogisticsFor(
        list,
        [
          { logistic_id: 8003, enabled: true, size_id: 2 },
          { logistic_id: 8006, enabled: true },
        ],
        false,
      ),
    ).toEqual([{ logistic_id: 8003, enabled: true, size_id: 2 }]);
    expect(shopeeLogisticsFor(list, [{ logistic_id: 8006, enabled: true }], false)).toEqual([
      { logistic_id: 8005, enabled: true },
    ]);
    expect(shopeeLogisticsFor(list, undefined, true)).toEqual([
      { logistic_id: 8005, enabled: true },
      { logistic_id: 8007, enabled: true },
    ]);
  });

  it("adds the item, then its tiers with standardise_tier_variation, and maps models back by tier index", async () => {
    const f = fakeFetch({
      "GET /api/v2/logistics/get_channel_list": () => channels,
      "POST /api/v2/product/add_item": () => ({ error: "", response: { item_id: 880001 } }),
      "POST /api/v2/product/init_tier_variation": (_url, init) => {
        const body = bodyOf(init);
        return {
          error: "",
          response: {
            item_id: body.item_id,
            model: (body.model as { tier_index: number[] }[]).map((m, i) => ({
              model_id: 990000 + i,
              tier_index: m.tier_index,
            })),
          },
        };
      },
    });
    const created = await connector(f.fn).products.create(shop, product({ warehouseId: "IDZ" }));
    expect(f.calls.map((c) => c.url.pathname)).toEqual([
      "/api/v2/logistics/get_channel_list",
      "/api/v2/product/add_item",
      "/api/v2/product/init_tier_variation",
    ]);
    const add = bodyOf(f.calls[1]!.init);
    expect(add).toEqual({
      item_name: "Kaos Polos Katun Combed 30s",
      description: "Bahan adem.\nUkuran pas.",
      original_price: 55_000,
      weight: 0.25,
      dimension: { package_length: 31, package_width: 20, package_height: 3 },
      logistic_info: [
        { logistic_id: 8005, enabled: true },
        { logistic_id: 8007, enabled: true },
      ],
      category_id: 100017,
      image: { image_id_list: ["img-1", "img-2"] },
      attribute_list: [
        { attribute_id: 100134, attribute_value_list: [{ value_id: 1234 }] },
        { attribute_id: 100010, attribute_value_list: [{ value_id: 0, original_value_name: "180", value_unit: "g" }] },
      ],
      brand: { brand_id: 0, original_brand_name: "NoBrand" },
      condition: "NEW",
      item_status: "NORMAL",
      item_sku: "KAOS",
    });
    const tiers = bodyOf(f.calls[2]!.init);
    expect(tiers.standardise_tier_variation).toEqual([
      {
        variation_id: 0,
        variation_group_id: 0,
        variation_name: "Warna",
        variation_option_list: [
          { variation_option_id: 0, variation_option_name: "Hitam", image_id: "img-h" },
          { variation_option_id: 0, variation_option_name: "Putih" },
        ],
      },
      {
        variation_id: 0,
        variation_group_id: 0,
        variation_name: "Ukuran",
        variation_option_list: [
          { variation_option_id: 0, variation_option_name: "M" },
          { variation_option_id: 0, variation_option_name: "L" },
        ],
      },
    ]);
    expect(tiers.tier_variation).toBeUndefined();
    expect(tiers.model).toEqual([
      {
        tier_index: [0, 0],
        original_price: 55_000,
        model_sku: "KAOS-HTM-M",
        seller_stock: [{ location_id: "IDZ", stock: 7 }],
      },
      {
        tier_index: [0, 1],
        original_price: 57_000,
        model_sku: "KAOS-HTM-L",
        seller_stock: [{ location_id: "IDZ", stock: 0 }],
      },
      {
        tier_index: [1, 0],
        original_price: 55_000,
        model_sku: "KAOS-PTH-M",
        seller_stock: [{ location_id: "IDZ", stock: 3 }],
        gtin_code: "8991234567891",
      },
    ]);
    expect(created).toEqual({
      externalItemId: "880001",
      variants: [
        { key: "v1", externalVariantId: "990000" },
        { key: "v2", externalVariantId: "990001" },
        { key: "v3", externalVariantId: "990002" },
      ],
      warnings: [],
    });
  });

  it("puts stock, GTIN, brand, and pre-order on the item itself when there are no variations", async () => {
    const f = fakeFetch({
      "GET /api/v2/logistics/get_channel_list": () => channels,
      "POST /api/v2/product/add_item": () => ({ error: "", response: { item_id: 880002 } }),
    });
    const created = await connector(f.fn).products.create(
      shop,
      product({
        variationNames: [],
        brand: { externalId: "1123", name: "Rajutku" },
        preOrderDays: 7,
        dimensionsMm: null,
        // stock without a location (shop without multi-warehouse) goes without location_id
        warehouseId: "default",
        variants: [
          { key: "only", sku: "TOPI", options: [], price: 30_000, stock: 12, image: null, gtin: "8991234567891" },
        ],
      }),
    );
    expect(f.calls.map((c) => c.url.pathname)).not.toContain("/api/v2/product/init_tier_variation");
    const add = bodyOf(f.calls[1]!.init);
    expect(add).toMatchObject({
      original_price: 30_000,
      brand: { brand_id: 1123, original_brand_name: "Rajutku" },
      pre_order: { is_pre_order: true, days_to_ship: 7 },
      seller_stock: [{ stock: 12 }],
      gtin_code: "8991234567891",
      logistic_info: [{ logistic_id: 8005, enabled: true }],
    });
    expect(add.seller_stock).toEqual([{ stock: 12 }]);
    expect(add.dimension).toBeUndefined();
    expect(created).toEqual({
      externalItemId: "880002",
      variants: [{ key: "only", externalVariantId: "" }],
      warnings: [],
    });
  });

  it("refuses to create an item no courier can ship", async () => {
    const f = fakeFetch({
      "GET /api/v2/logistics/get_channel_list": () => ({
        error: "",
        response: {
          logistics_channel_list: [{ logistics_channel_id: 8003, enabled: true, fee_type: "SIZE_SELECTION" }],
        },
      }),
    });
    await expect(connector(f.fn).products.create(shop, product())).rejects.toMatchObject({ code: "no_logistics" });
  });

  it("reports the created item when its tiers fail, and resumes from it without adding the item again", async () => {
    let fail = true;
    const created: string[] = [];
    const f = fakeFetch({
      "GET /api/v2/logistics/get_channel_list": () => channels,
      "POST /api/v2/product/add_item": () => ({ error: "", response: { item_id: 880003 } }),
      "GET /api/v2/product/get_model_list": () => ({ error: "", response: { tier_variation: [], model: [] } }),
      "POST /api/v2/product/init_tier_variation": (_url, init) =>
        fail
          ? { error: "product.error_busi", message: "item is not ready" }
          : {
              error: "",
              response: {
                model: (bodyOf(init).model as { tier_index: number[] }[]).map((m, i) => ({
                  model_id: 1 + i,
                  tier_index: m.tier_index,
                })),
              },
            },
    });
    const c = connector(f.fn);
    const err = await c.products
      .create(shop, product(), undefined, { itemCreated: async (id) => void created.push(id) })
      .catch((e: unknown) => e);
    // the caller knew the item before its tiers failed
    expect(created).toEqual(["880003"]);
    expect(isConnectorError(err) && err.externalItemId).toBe("880003");
    expect(isConnectorError(err) && err.detail).toBe("item is not ready");
    fail = false;
    const resumed = await c.products.create(shop, product(), { externalItemId: "880003" });
    expect(f.calls.filter((call) => call.url.pathname.endsWith("add_item"))).toHaveLength(1);
    expect(bodyOf(f.calls.at(-1)!.init).item_id).toBe(880003);
    expect(resumed.variants).toHaveLength(3);
  });

  it("resumes an item whose variations were already added by returning their models", async () => {
    const f = fakeFetch({
      "GET /api/v2/product/get_model_list": () => ({
        error: "",
        response: {
          tier_variation: [
            { name: "Warna", option_list: [{ option: "Hitam" }, { option: "Putih" }] },
            { name: "Ukuran", option_list: [{ option: "M" }, { option: "L" }] },
          ],
          model: [
            { model_id: 71, tier_index: [0, 0] },
            { model_id: 72, tier_index: [0, 1] },
            { model_id: 73, tier_index: [1, 0] },
          ],
        },
      }),
    });
    const created = await connector(f.fn).products.create(shop, product(), { externalItemId: "880004" });
    expect(f.calls.map((c) => c.url.pathname)).toEqual(["/api/v2/product/get_model_list"]);
    expect(created.variants).toEqual([
      { key: "v1", externalVariantId: "71" },
      { key: "v2", externalVariantId: "72" },
      { key: "v3", externalVariantId: "73" },
    ]);
  });
});
