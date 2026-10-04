import { type CallRecord, type ProductToCreate, TransientConnectorError } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { tiktokSign, tiktokSignString } from "./client.js";
import { createTiktokShopConnector } from "./connector.js";
import { htmlToText, identifierType, textToHtml, tiktokAttribute } from "./products.js";

type Handler = (url: URL, init: RequestInit) => unknown;

function fakeFetch(routes: Record<string, Handler>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const route = Object.entries(routes).find(([k]) => {
      const [method, pattern] = k.split(" ");
      return method === (init.method ?? "GET") && new RegExp(`^${pattern}$`).test(url.pathname);
    })?.[1];
    if (!route) return new Response(JSON.stringify({ code: 36009009, message: "Invalid path" }), { status: 404 });
    const out = route(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

function connector(fetchImpl: typeof fetch, observer?: (r: CallRecord) => void) {
  return createTiktokShopConnector({
    appKey: "app-key",
    appSecret: "app-secret",
    apiBaseUrl: "https://open-api.tiktokglobalshop.com",
    authBaseUrl: "https://auth.tiktok-shops.com",
    authorizeUrl: "https://services.tiktokshop.com/open/authorize",
    http: { fetch: fetchImpl, ...(observer ? { observer } : {}) },
  });
}

const shop = { externalShopId: "7495000000000000001", accessToken: "TTP_access", shopCipher: "ROW_cipher" };
const ok = (data: unknown) => ({ code: 0, message: "Success", request_id: "r", data });
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body));

function product(over: Partial<ProductToCreate> = {}): ProductToCreate {
  return {
    idempotencyKey: "01JCOPYDRAFT0000000000000A",
    title: "Kaos Polos Katun Combed 30s Unisex",
    description: "Bahan adem.\nUkuran <pas> & nyaman.",
    descriptionHtml: null,
    categoryId: "601226",
    brand: null,
    attributes: [
      { attributeId: "100392", name: "Bahan", values: [{ externalId: "1000040", name: "Katun" }] },
      { attributeId: "102254", name: "Barang Impor", values: [{ externalId: "1000059", name: "Tidak" }] },
      { attributeId: "100500", name: "Gaya", values: [{ externalId: null, name: "Kasual" }] },
      { attributeId: "100501", name: "Kosong", values: [] },
    ],
    images: ["tos-maliva-i-1", "tos-maliva-i-2"],
    weightG: 250,
    dimensionsMm: { length: 301, width: 200, height: 25 },
    condition: "new",
    preOrderDays: null,
    itemSku: null,
    sizeChartImage: null,
    variationNames: ["Warna", "Ukuran"],
    variants: [
      { key: "v1", sku: "KAOS-HTM-M", options: ["Hitam", "M"], price: 55_000, stock: 7, image: "tos-h", gtin: null },
      { key: "v2", sku: "KAOS-HTM-L", options: ["Hitam", "L"], price: 57_000, stock: 0, image: "tos-h", gtin: null },
      {
        key: "v3",
        sku: "KAOS-PTH-M",
        options: ["Putih", "M"],
        price: 55_000,
        stock: 3,
        image: "tos-p",
        gtin: "8991234567891",
      },
    ],
    warehouseId: "7300000000000000001",
    extras: {},
    ...over,
  };
}

describe("TikTok Shop products: text helpers", () => {
  it("turns description HTML into readable lines and back", () => {
    expect(htmlToText("<p>Bahan adem.</p><ul><li>Katun</li><li>S &amp; M</li></ul><p>Cuci<br/>dingin</p>")).toBe(
      "Bahan adem.\n- Katun\n- S & M\nCuci\ndingin",
    );
    expect(textToHtml("Bahan adem.\n\nUkuran <pas> & nyaman.")).toBe(
      "<p>Bahan adem.</p><p>Ukuran &lt;pas&gt; &amp; nyaman.</p>",
    );
  });

  it("names the identifier type by code length", () => {
    expect(["12345670", "8991234567891", "012345678905", "18991234567898"].map(identifierType)).toEqual([
      "EAN",
      "EAN",
      "UPC",
      "GTIN",
    ]);
  });
});

describe("TikTok Shop products: reading a product to copy", () => {
  it("maps Get Product: leaf category, attributes, sales attributes in order, package in grams and mm", async () => {
    const f = fakeFetch({
      "GET /product/202309/products/1729592969712207013": () =>
        ok({
          id: "1729592969712207013",
          title: "Kaos Polos",
          description: "<p>Bahan adem.</p><p>Ukuran pas.</p>",
          main_images: [
            { uri: "tos-a", urls: ["https://p16.tiktokcdn.com/a.jpg"] },
            { uri: "tos-b", urls: ["https://p16.tiktokcdn.com/b.jpg"] },
          ],
          brand: { id: "7082427311584347905", name: "Rajutku" },
          category_chains: [
            { id: "601152", parent_id: "0", local_name: "Pakaian Wanita", is_leaf: false },
            { id: "601226", parent_id: "601152", local_name: "Kaos", is_leaf: true },
          ],
          product_attributes: [
            { id: "100392", name: "Bahan", values: [{ id: "1000040", name: "Katun" }] },
            { id: "100500", name: "Gaya", values: [{ name: "Kasual" }] },
          ],
          package_weight: { value: "0.25", unit: "KILOGRAM" },
          package_dimensions: { length: "30", width: "20", height: "3", unit: "CENTIMETER" },
          size_chart: { image: { uri: "tos-sc", urls: ["https://p16.tiktokcdn.com/sc.jpg"] } },
          skus: [
            {
              id: "1729592969712207234",
              seller_sku: "KAOS-PTH-L",
              price: { tax_exclusive_price: "60000", sale_price: "60000", currency: "IDR" },
              inventory: [
                { warehouse_id: "7300000000000000001", quantity: 3 },
                { warehouse_id: "7300000000000000002", quantity: 1 },
              ],
              sales_attributes: [
                { id: "100000", name: "Ukuran", value_id: "2", value_name: "L" },
                {
                  id: "100089",
                  name: "Warna",
                  value_id: "1",
                  value_name: "Putih",
                  sku_img: { uri: "tos-p", urls: ["https://p16.tiktokcdn.com/p.jpg"] },
                },
              ],
            },
            {
              id: "1729592969712207235",
              seller_sku: "KAOS-HTM-M",
              price: { tax_exclusive_price: "55000" },
              inventory: [{ warehouse_id: "7300000000000000001", quantity: 0 }],
              sales_attributes: [
                { id: "100000", name: "Ukuran", value_id: "3", value_name: "M" },
                { id: "100089", name: "Warna", value_id: "4", value_name: "Hitam" },
              ],
              identifier_code: { code: "8991234567891", type: "EAN" },
            },
          ],
        }),
    });
    const p = await connector(f.fn).products.get(shop, "1729592969712207013");
    expect(p).toMatchObject({
      externalItemId: "1729592969712207013",
      title: "Kaos Polos",
      description: "Bahan adem.\nUkuran pas.",
      descriptionHtml: "<p>Bahan adem.</p><p>Ukuran pas.</p>",
      category: { externalId: "601226", name: "Kaos", path: "Pakaian Wanita > Kaos" },
      brand: { externalId: "7082427311584347905", name: "Rajutku" },
      images: ["https://p16.tiktokcdn.com/a.jpg", "https://p16.tiktokcdn.com/b.jpg"],
      weightG: 250,
      dimensionsMm: { length: 300, width: 200, height: 30 },
      condition: "new",
      sizeChartImageUrl: "https://p16.tiktokcdn.com/sc.jpg",
      variationNames: ["Ukuran", "Warna"],
    });
    expect(p?.attributes).toEqual([
      { attributeId: "100392", name: "Bahan", values: [{ externalId: "1000040", name: "Katun" }] },
      { attributeId: "100500", name: "Gaya", values: [{ externalId: null, name: "Kasual" }] },
    ]);
    expect(p?.variants).toEqual([
      {
        externalVariantId: "1729592969712207234",
        sku: "KAOS-PTH-L",
        options: ["L", "Putih"],
        price: 60_000,
        stock: 4,
        imageUrl: "https://p16.tiktokcdn.com/p.jpg",
        gtin: null,
      },
      {
        externalVariantId: "1729592969712207235",
        sku: "KAOS-HTM-M",
        options: ["M", "Hitam"],
        price: 55_000,
        stock: 0,
        imageUrl: null,
        gtin: "8991234567891",
      },
    ]);
  });

  it("answers null for a product the shop no longer has", async () => {
    const f = fakeFetch({
      "GET /product/202309/products/\\d+": () => ({
        code: 12052048,
        message: "Product does not exist",
        request_id: "r",
      }),
    });
    expect(await connector(f.fn).products.get(shop, "1")).toBeNull();
  });
});

describe("TikTok Shop products: reference data", () => {
  it("reads categories in id-ID with category_version v2; permission decides what the shop may use", async () => {
    const f = fakeFetch({
      "GET /product/202309/categories": (url) => {
        expect(url.searchParams.get("locale")).toBe("id-ID");
        expect(url.searchParams.get("category_version")).toBe("v2");
        expect(url.searchParams.get("shop_cipher")).toBe("ROW_cipher");
        return ok({
          categories: [
            {
              id: "601152",
              parent_id: "0",
              local_name: "Pakaian Wanita",
              is_leaf: false,
              permission_statuses: ["AVAILABLE"],
            },
            {
              id: "601226",
              parent_id: "601152",
              local_name: "Kaos",
              is_leaf: true,
              permission_statuses: ["AVAILABLE"],
            },
            {
              id: "700001",
              parent_id: "601152",
              local_name: "Obat",
              is_leaf: true,
              permission_statuses: ["INVITE_ONLY", "NON_MAIN_CATEGORY"],
            },
          ],
        });
      },
    });
    expect(await connector(f.fn).products.categories(shop)).toEqual([
      { externalId: "601152", parentExternalId: null, name: "Pakaian Wanita", isLeaf: false, permitted: true },
      { externalId: "601226", parentExternalId: "601152", name: "Kaos", isLeaf: true, permitted: true },
      { externalId: "700001", parentExternalId: "601152", name: "Obat", isLeaf: true, permitted: false },
    ]);
  });

  it("recommends with the source platform's category and brand; a title it cannot place gives no suggestion", async () => {
    let answer: unknown = ok({
      leaf_category_id: "601226",
      categories: [{ id: "601227", is_leaf: true, permission_statuses: ["AVAILABLE"] }],
    });
    const f = fakeFetch({ "POST /product/202309/categories/recommend": () => answer });
    const c = connector(f.fn);
    const ids = await c.products.recommendCategory(shop, {
      title: "Kaos Polos Katun",
      description: "Bahan adem",
      source: { categoryId: "100017", categoryName: "Kaos", categoryPath: "Pakaian Pria > Kaos", brand: "Rajutku" },
    });
    expect(ids).toEqual(["601226", "601227"]);
    expect(bodyOf(f.calls[0]!.init)).toEqual({
      product_title: "Kaos Polos Katun",
      description: "<p>Bahan adem</p>",
      category_version: "v2",
      locale: "id-ID",
      origin_platform_category: { id: "100017", name: "Kaos", full_name: "Pakaian Pria > Kaos", is_leaf: true },
      origin_platform_vendor: "Rajutku",
    });
    answer = { code: 12019015, message: "product title is invalid", request_id: "r" };
    expect(await c.products.recommendCategory(shop, { title: "x", description: "" })).toEqual([]);
    answer = new Response("busy", { status: 503 });
    await expect(c.products.recommendCategory(shop, { title: "x", description: "" })).rejects.toThrow(
      TransientConnectorError,
    );
  });

  it("reads product attributes (not sales attributes) and category rules per leaf", async () => {
    const f = fakeFetch({
      "GET /product/202309/categories/601226/attributes": (url) => {
        expect(url.searchParams.get("category_version")).toBe("v2");
        return ok({
          attributes: [
            { id: "100000", name: "Ukuran", type: "SALES_PROPERTY", is_requried: false, values: [] },
            {
              id: "102254",
              name: "Barang Impor",
              type: "PRODUCT_PROPERTY",
              is_requried: true,
              values: [
                { id: "1000058", name: "Ya" },
                { id: "1000059", name: "Tidak" },
              ],
              is_customizable: false,
              is_multiple_selection: false,
            },
            {
              id: "100392",
              name: "Bahan",
              type: "PRODUCT_PROPERTY",
              is_requried: false,
              values: [{ id: "1000040", name: "Katun" }],
              is_customizable: true,
              is_multiple_selection: true,
              requirement_conditions: [
                { condition_type: "VALUE_ID_MATCH", attribute_id: "102254", attribute_value_id: "1000058" },
              ],
            },
            {
              id: "100600",
              name: "Berat Bersih",
              type: "PRODUCT_PROPERTY",
              values: [],
              value_data_format: "POSITIVE_INT_OR_DECIMAL",
            },
          ],
        });
      },
      "GET /product/202309/categories/601226/rules": () =>
        ok({
          product_certifications: [
            { id: "1", name: "SNI", is_required: true },
            { id: "2", name: "Halal", is_required: false },
          ],
          size_chart: { is_supported: true, is_required: false },
          package_dimension: { is_required: true },
        }),
    });
    const [rules] = await connector(f.fn).products.categoryRules(shop, ["601226"]);
    expect(rules).toMatchObject({
      categoryId: "601226",
      brandRequired: false,
      weightRequired: true,
      dimensionsRequired: true,
      sizeChart: { supported: true, required: false },
      certifications: ["SNI"],
      limits: { titleMin: 25, titleMax: 255, variantsMax: 100, variationsMax: 3, skuMax: 50, skuNoSpaces: true },
    });
    expect(rules?.attributes.map((a) => [a.externalId, a.required, a.input, a.maxValues, a.valueFormat])).toEqual([
      ["102254", true, "select", 1, null],
      ["100392", false, "multi_select_or_text", null, null],
      ["100600", false, "text", 1, "decimal"],
    ]);
    expect(rules?.attributes[1]?.requiredWhen).toEqual([{ attributeId: "102254", valueId: "1000058" }]);
  });

  it("reads the documented spelling is_requried and the corrected one", () => {
    expect(tiktokAttribute({ id: "1", type: "PRODUCT_PROPERTY", is_required: true })?.required).toBe(true);
    expect(tiktokAttribute({ id: "1", type: "PRODUCT_PROPERTY", is_requried: true })?.required).toBe(true);
    expect(tiktokAttribute({ id: "1", type: "SALES_PROPERTY", is_requried: true })).toBeNull();
  });

  it("lists brands by name across pages; unauthorized T1 brands cannot be chosen", async () => {
    const f = fakeFetch({
      "GET /product/202309/brands": (url) =>
        url.searchParams.get("page_token")
          ? ok({ brands: [{ id: "3", name: "Rajut Indah", authorized_status: "UNAUTHORIEZD", is_t1_brand: false }] })
          : ok({
              brands: [
                {
                  id: "1",
                  name: "Rajutku",
                  authorized_status: "AUTHORIZED",
                  brand_status: "AVAILABLE",
                  is_t1_brand: true,
                },
                {
                  id: "2",
                  name: "Rajut Global",
                  authorized_status: "UNAUTHORIEZD",
                  brand_status: "AVAILABLE",
                  is_t1_brand: true,
                },
              ],
              next_page_token: "p2",
            }),
    });
    expect(await connector(f.fn).products.brands(shop, { categoryId: "601226", name: "Rajut" })).toEqual([
      { externalId: "1", name: "Rajutku", selectable: true },
      { externalId: "2", name: "Rajut Global", selectable: false },
      { externalId: "3", name: "Rajut Indah", selectable: true },
    ]);
    expect(f.calls[0]?.url.searchParams.get("brand_name")).toBe("Rajut");
    expect(f.calls[0]?.url.searchParams.get("category_version")).toBe("v2");
  });

  it("uploads images as multipart field data with use_case, signed without the body", async () => {
    const records: CallRecord[] = [];
    const f = fakeFetch({
      "POST /product/202309/images/upload": (url, init) => {
        const query = Object.fromEntries(url.searchParams);
        const signString = tiktokSignString({ path: url.pathname, query });
        expect(query.sign).toBe(tiktokSign("app-secret", signString));
        expect(new Headers(init.headers).get("x-tts-access-token")).toBe("TTP_access");
        expect(new Headers(init.headers).get("content-type")).toBeNull();
        const form = init.body as FormData;
        expect(form.get("use_case")).toBe("ATTRIBUTE_IMAGE");
        expect((form.get("data") as File).type).toBe("image/jpeg");
        return ok({
          uri: "tos-maliva-i-9",
          url: "https://p16.tiktokcdn.com/9.jpg",
          width: 800,
          height: 800,
          use_case: "ATTRIBUTE_IMAGE",
        });
      },
    });
    const out = await connector(f.fn, (r) => records.push(r)).products.uploadImage(shop, {
      bytes: new Uint8Array(10),
      contentType: "image/jpeg",
      use: "variant",
    });
    expect(out).toEqual({ ref: "tos-maliva-i-9", url: "https://p16.tiktokcdn.com/9.jpg" });
    expect(records[0]?.request).toEqual({
      use_case: "ATTRIBUTE_IMAGE",
      data: { bytes: 10, contentType: "image/jpeg" },
    });
  });

  it("reports failed listing prerequisites in TikTok Shop's words", async () => {
    const f = fakeFetch({
      "GET /product/202312/prerequisites": () =>
        ok({
          check_results: [
            { check_item: "WAREHOUSE", is_failed: false },
            { check_item: "DELIVERY_OPTION", is_failed: true, fail_reasons: ["No delivery option is enabled."] },
            { check_item: "SHOP_STATUS", is_failed: true },
          ],
        }),
    });
    expect(await connector(f.fn).products.prerequisites(shop)).toEqual([
      "No delivery option is enabled.",
      "SHOP_STATUS belum memenuhi syarat.",
    ]);
  });
});

describe("TikTok Shop products: Create Product", () => {
  it("sends one idempotent request with SKUs, inventory, package, and attributes; maps SKUs back by seller SKU", async () => {
    const f = fakeFetch({
      "POST /product/202309/products": () =>
        ok({
          product_id: "1729600000000000001",
          skus: [
            { id: "1729600000000000103", seller_sku: "KAOS-PTH-M" },
            { id: "1729600000000000101", seller_sku: "KAOS-HTM-M" },
            { id: "1729600000000000102", seller_sku: "KAOS-HTM-L" },
          ],
          warnings: [{ message: "The brand was removed." }],
        }),
    });
    const created = await connector(f.fn).products.create(shop, product());
    const body = bodyOf(f.calls[0]!.init);
    expect(body).toEqual({
      save_mode: "LISTING",
      idempotency_key: "01JCOPYDRAFT0000000000000A",
      title: "Kaos Polos Katun Combed 30s Unisex",
      description: "<p>Bahan adem.</p><p>Ukuran &lt;pas&gt; &amp; nyaman.</p>",
      category_id: "601226",
      category_version: "v2",
      main_images: [{ uri: "tos-maliva-i-1" }, { uri: "tos-maliva-i-2" }],
      skus: [
        {
          sales_attributes: [
            { name: "Warna", value_name: "Hitam", sku_img: { uri: "tos-h" } },
            { name: "Ukuran", value_name: "M" },
          ],
          inventory: [{ warehouse_id: "7300000000000000001", quantity: 7 }],
          seller_sku: "KAOS-HTM-M",
          price: { amount: "55000", currency: "IDR" },
        },
        {
          sales_attributes: [
            { name: "Warna", value_name: "Hitam", sku_img: { uri: "tos-h" } },
            { name: "Ukuran", value_name: "L" },
          ],
          inventory: [{ warehouse_id: "7300000000000000001" }],
          seller_sku: "KAOS-HTM-L",
          price: { amount: "57000", currency: "IDR" },
        },
        {
          sales_attributes: [
            { name: "Warna", value_name: "Putih", sku_img: { uri: "tos-p" } },
            { name: "Ukuran", value_name: "M" },
          ],
          inventory: [{ warehouse_id: "7300000000000000001", quantity: 3 }],
          seller_sku: "KAOS-PTH-M",
          price: { amount: "55000", currency: "IDR" },
          identifier_code: { code: "8991234567891", type: "EAN" },
        },
      ],
      package_weight: { value: "0.25", unit: "KILOGRAM" },
      package_dimensions: { length: "31", width: "20", height: "3", unit: "CENTIMETER" },
      product_attributes: [
        { id: "100392", values: [{ id: "1000040" }] },
        { id: "102254", values: [{ id: "1000059" }] },
        { id: "100500", values: [{ name: "Kasual" }] },
      ],
    });
    expect(created).toEqual({
      externalItemId: "1729600000000000001",
      variants: [
        { key: "v1", externalVariantId: "1729600000000000101" },
        { key: "v2", externalVariantId: "1729600000000000102" },
        { key: "v3", externalVariantId: "1729600000000000103" },
      ],
      warnings: ["The brand was removed."],
    });
  });

  it("tells the caller the product id, and resumes a product an earlier request created by reading it", async () => {
    const f = fakeFetch({
      "POST /product/202309/products": () => ok({ product_id: "1729600000000000009", skus: [] }),
      "GET /product/202309/products/1729600000000000009": () =>
        ok({
          id: "1729600000000000009",
          skus: [
            {
              id: "201",
              seller_sku: "KAOS-HTM-M",
              sales_attributes: [
                { name: "Warna", value_name: "Hitam" },
                { name: "Ukuran", value_name: "M" },
              ],
            },
            {
              id: "202",
              seller_sku: "",
              sales_attributes: [
                { name: "Warna", value_name: "Hitam" },
                { name: "Ukuran", value_name: "L" },
              ],
            },
            {
              id: "203",
              seller_sku: "KAOS-PTH-M",
              sales_attributes: [
                { name: "Warna", value_name: "Putih" },
                { name: "Ukuran", value_name: "M" },
              ],
            },
          ],
        }),
    });
    const c = connector(f.fn);
    const seen: string[] = [];
    await c.products.create(shop, product(), undefined, { itemCreated: async (id) => void seen.push(id) });
    expect(seen).toEqual(["1729600000000000009"]);
    const variants = product().variants.map((v) => (v.key === "v2" ? { ...v, sku: null } : v));
    const resumed = await c.products.create(shop, product({ variants }), { externalItemId: "1729600000000000009" });
    expect(f.calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
    expect(resumed.variants).toEqual([
      { key: "v1", externalVariantId: "201" },
      { key: "v2", externalVariantId: "202" },
      { key: "v3", externalVariantId: "203" },
    ]);
  });

  it("drops option images unless every value of the first variation has one", async () => {
    const f = fakeFetch({ "POST /product/202309/products": () => ok({ product_id: "1", skus: [] }) });
    const variants = product().variants.map((v) => (v.options[0] === "Putih" ? { ...v, image: null } : v));
    await connector(f.fn).products.create(shop, product({ variants }));
    const skus = bodyOf(f.calls[0]!.init).skus as { sales_attributes: { sku_img?: unknown }[] }[];
    expect(skus.every((s) => s.sales_attributes.every((a) => a.sku_img === undefined))).toBe(true);
  });

  it("looks a brand up by name when only the name is known, and warns when it cannot be used", async () => {
    let brands: unknown[] = [{ id: "77", name: "Rajutku", authorized_status: "UNAUTHORIEZD", is_t1_brand: false }];
    const f = fakeFetch({
      "GET /product/202309/brands": () => ok({ brands }),
      "POST /product/202309/products": () => ok({ product_id: "1", skus: [{ id: "11" }] }),
    });
    const c = connector(f.fn);
    const single = {
      variationNames: [],
      variants: [{ key: "only", sku: "TOPI-1", options: [], price: 30_000, stock: 2, image: null, gtin: null }],
      brand: { externalId: null, name: "rajutku" },
    };
    const first = await c.products.create(shop, product(single));
    expect(bodyOf(f.calls[1]!.init)).toMatchObject({ brand_id: "77" });
    expect(bodyOf(f.calls[1]!.init).skus[0].sales_attributes).toBeUndefined();
    expect(first.variants).toEqual([{ key: "only", externalVariantId: "11" }]);
    brands = [];
    const second = await c.products.create(shop, product(single));
    expect(bodyOf(f.calls[3]!.init).brand_id).toBeUndefined();
    expect(second.warnings).toEqual(["Merek rajutku tidak bisa dipakai di TikTok Shop; produk dibuat tanpa merek."]);
  });

  it("keeps the source HTML description and the size chart image", async () => {
    const f = fakeFetch({ "POST /product/202309/products": () => ok({ product_id: "1", skus: [] }) });
    await connector(f.fn).products.create(
      shop,
      product({ descriptionHtml: "<p>Asli</p><ul><li>a</li></ul>", sizeChartImage: "tos-sc", dimensionsMm: null }),
    );
    const body = bodyOf(f.calls[0]!.init);
    expect(body.description).toBe("<p>Asli</p><ul><li>a</li></ul>");
    expect(body.size_chart).toEqual({ image: { uri: "tos-sc" } });
    expect(body.package_dimensions).toBeUndefined();
  });
});
