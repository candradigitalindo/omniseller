import { type ProductToCreate, parseJsonSafe } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { createShopeeConnector } from "./connector.js";
import { numericId, shopeeId } from "./identifiers.js";
import { chooseShopeeHandover } from "./logistics.js";

const LARGE = "9007199254740993";
const NEIGHBOR = "9007199254740992";
const MAX = "9223372036854775807";
const shop = { externalShopId: LARGE, accessToken: "test-token", shopCipher: null };
type Call = { url: URL; body: Record<string, unknown>; raw: string };
function harness(reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const connector = createShopeeConnector({
    partnerId: 123,
    partnerKey: "test-key",
    apiBaseUrl: "https://partner.shopeemobile.com",
    authBaseUrl: "https://open.shopee.com",
    variantDelayMs: 0,
    http: {
      fetch: (async (input, init) => {
        const raw = String(init?.body ?? "{}");
        const call = { url: new URL(String(input)), body: parseJsonSafe(raw) as Record<string, unknown>, raw };
        calls.push(call);
        const response = reply(call);
        return new Response(typeof response === "string" ? response : JSON.stringify(response), { status: 200 });
      }) as typeof fetch,
    },
  });
  return { connector, calls };
}
const grant = { access_token: "access", refresh_token: "refresh", expire_in: 14400 };
const stock = (model = LARGE, warehouses = [{ externalWarehouseId: "IDZ", quantity: 5 }]) => ({
  externalItemId: MAX,
  externalVariantId: model,
  warehouses,
});

const product = (): ProductToCreate => ({
  idempotencyKey: "test-id",
  title: "Kaos",
  description: "Kaos katun",
  descriptionHtml: null,
  categoryId: LARGE,
  brand: { externalId: MAX, name: "Brand" },
  attributes: [{ attributeId: LARGE, name: "Bahan", values: [{ externalId: MAX, name: "Katun" }] }],
  images: ["img"],
  weightG: 100,
  dimensionsMm: null,
  condition: "new",
  preOrderDays: null,
  itemSku: "shirt",
  sizeChartImage: null,
  warehouseId: null,
  variationNames: ["Warna"],
  variants: [
    { key: "one", sku: "one", options: ["Merah"], price: 50000, stock: 1, image: null, gtin: null },
    { key: "two", sku: "two", options: ["Biru"], price: 50000, stock: 2, image: null, gtin: null },
  ],
  extras: { logistics: [{ logistic_id: LARGE, enabled: true, size_id: MAX }] },
});

describe("Shopee int64 identifiers", () => {
  it("keeps an absent cross-border classification unknown instead of assuming a local seller", async () => {
    let classification: boolean | undefined;
    const h = harness(({ url }) => {
      if (url.pathname.endsWith("/token/get")) return grant;
      if (url.pathname.endsWith("get_shop_info"))
        return { shop_name: "Toko", region: "ID", ...(classification === undefined ? {} : { is_cb: classification }) };
      return { response: {} };
    });
    const authorization = await h.connector.auth.exchangeCode({ code: "code", shopId: LARGE });
    for (const value of [undefined, false, true]) {
      classification = value;
      expect((await h.connector.shops.describe(authorization))[0]?.info.is_cb).toBe(value ?? null);
    }
  });

  it("serializes safe and large identifiers as exact JSON numbers and rejects already rounded numbers", () => {
    expect(JSON.stringify([numericId(42), numericId(LARGE), numericId(MAX)])).toBe(`[42,${LARGE},${MAX}]`);
    expect(shopeeId(LARGE)).toBe(LARGE);
    expect(shopeeId("0001")).toBe("1");
    expect(shopeeId(Number(LARGE))).toBeNull();
  });

  it.each(["-1", "1.5", "1e3", "", "abc", "9223372036854775808", Number(LARGE), Number.NaN])(
    "rejects invalid identifier %s",
    (value) => expect(() => numericId(value)).toThrow(),
  );

  it("keeps exact shop/main-account IDs through code exchange, refresh and multi-shop replies", async () => {
    const h = harness(
      () =>
        `{"access_token":"access","refresh_token":"refresh","expire_in":14400,"shop_id_list":[${LARGE},${NEIGHBOR}],"merchant_id_list":[${MAX}]}`,
    );
    await h.connector.auth.exchangeCode({ code: "code", shopId: LARGE });
    const result = await h.connector.auth.exchangeCode({ code: "code", mainAccountId: MAX });
    await h.connector.auth.refresh({ refreshToken: "refresh", externalShopId: LARGE });
    expect(h.calls.map((c) => c.body)).toEqual([
      { code: "code", partner_id: 123, shop_id: LARGE },
      { code: "code", partner_id: 123, main_account_id: MAX },
      { refresh_token: "refresh", partner_id: 123, shop_id: LARGE },
    ]);
    expect(result.shops.map((s) => s.externalShopId)).toEqual([LARGE, NEIGHBOR]);
    expect(result.principal.merchant_ids).toBe(MAX);
    expect(h.calls[0]?.raw).toContain(`"shop_id":${LARGE}`);
  });

  it("keeps distinct int64 item IDs when matching unlist success and failure responses", async () => {
    const h = harness(
      () =>
        `{"response":{"success_list":[{"item_id":${LARGE},"unlist":true}],"failure_list":[{"item_id":${NEIGHBOR},"failed_reason":"promotion"}]}}`,
    );
    expect(await h.connector.catalog.setListingStatus(shop, [LARGE, NEIGHBOR], false)).toEqual([
      { externalItemId: LARGE, ok: true },
      { externalItemId: NEIGHBOR, ok: false, error: "promotion" },
    ]);
    expect(h.calls[0]?.body.item_list).toEqual([
      { item_id: LARGE, unlist: true },
      { item_id: NEIGHBOR, unlist: true },
    ]);
  });

  it("never accepts missing or contradictory item status acknowledgement", async () => {
    const h = harness(() => ({ response: { success_list: [{ item_id: LARGE, unlist: false }] } }));
    expect(await h.connector.catalog.setListingStatus(shop, [LARGE, NEIGHBOR], false)).toMatchObject([
      { externalItemId: LARGE, ok: false },
      { externalItemId: NEIGHBOR, ok: false },
    ]);
  });

  it.each([
    { response: { success_list: {} } },
    { response: { success_list: [null] } },
    { response: { success_list: [{ item_id: LARGE, unlist: true }], failure_list: {} } },
  ])("refuses malformed per-item status lists %#", async (reply) => {
    const h = harness(() => reply);
    expect(await h.connector.catalog.setListingStatus(shop, [LARGE], false)).toMatchObject([{ ok: false }]);
  });

  it("matches large price model IDs exactly and rejects aliases of the same update", async () => {
    const h = harness(
      () =>
        `{"response":{"success_list":[{"model_id":${LARGE},"original_price":50000}],"failure_list":[{"model_id":${NEIGHBOR},"failed_reason":"locked"}]}}`,
    );
    const updates = [LARGE, NEIGHBOR].map((id) => ({ externalItemId: MAX, externalVariantId: id, price: 50000 }));
    expect((await h.connector.catalog.updatePrices!(shop, updates)).map((r) => r.ok)).toEqual([true, false]);
    const untouched = harness(() => ({}));
    await expect(
      untouched.connector.catalog.updatePrices!(shop, [
        { externalItemId: "01", externalVariantId: "", price: 50000 },
        { externalItemId: "1", externalVariantId: "0", price: 50000 },
      ]),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(untouched.calls).toHaveLength(0);
  });

  it.each([
    { response: { success_list: {} } },
    { response: { success_list: [null] } },
    { response: { success_list: [{ model_id: LARGE, original_price: 50000 }], failure_list: {} } },
    {
      response: {
        success_list: [
          { model_id: LARGE, original_price: 50000 },
          { model_id: LARGE, original_price: 50000 },
        ],
      },
    },
  ])("refuses malformed or repeated price acknowledgements %#", async (reply) => {
    const h = harness(() => reply);
    expect(
      await h.connector.catalog.updatePrices!(shop, [{ externalItemId: MAX, externalVariantId: LARGE, price: 50000 }]),
    ).toMatchObject([{ ok: false, errorCode: "bad_response" }]);
  });

  it("keeps colliding item/model IDs separate on reads and selects the exact source product", async () => {
    const h = harness(
      () =>
        `{"response":{"item_list":[{"item_id":${NEIGHBOR},"item_name":"Other"},{"item_id":${LARGE},"item_name":"Requested"}]}}`,
    );
    expect(await h.connector.products.get(shop, LARGE)).toMatchObject({ externalItemId: LARGE, title: "Requested" });
    expect(
      (await h.connector.catalog.getListings(shop, [LARGE, NEIGHBOR])).listings.map((l) => l.externalItemId),
    ).toEqual([NEIGHBOR, LARGE]);
    const wrong = harness(() => `{"response":{"item_list":[{"item_id":${NEIGHBOR},"item_name":"Other"}]}}`);
    expect(await wrong.connector.products.get(shop, LARGE)).toBeNull();
  });

  it("sends out-of-stock cancellation item/model IDs as exact numbers", async () => {
    const h = harness(() => ({}));
    await h.connector.orders.cancelOrder(shop, {
      externalOrderId: "ORDER",
      externalStatus: "READY_TO_SHIP",
      reason: "OUT_OF_STOCK",
      items: [{ externalItemId: MAX, externalVariantId: LARGE, quantity: 1 }],
    });
    expect(h.calls[0]?.body.item_list).toEqual([{ item_id: MAX, model_id: LARGE }]);
    expect(h.calls[0]?.raw).toContain(`"model_id":${LARGE}`);
  });

  it("creates categories, attributes, brands, logistics and variations without rounding int64 IDs", async () => {
    const h = harness(({ url }) => {
      if (url.pathname.endsWith("get_channel_list"))
        return `{"response":{"logistics_channel_list":[{"logistics_channel_id":${LARGE},"enabled":true,"fee_type":"SIZE_SELECTION"}]}}`;
      if (url.pathname.endsWith("add_item")) return `{"response":{"item_id":${MAX}}}`;
      if (url.pathname.endsWith("init_tier_variation"))
        return `{"response":{"model":[{"model_id":${LARGE},"tier_index":[0]},{"model_id":${NEIGHBOR},"tier_index":[1]}]}}`;
      throw new Error("unexpected request");
    });
    expect(await h.connector.products.create(shop, product())).toEqual({
      externalItemId: MAX,
      variants: [
        { key: "one", externalVariantId: LARGE },
        { key: "two", externalVariantId: NEIGHBOR },
      ],
      warnings: [],
    });
    expect(h.calls[1]?.body).toMatchObject({
      category_id: LARGE,
      brand: { brand_id: MAX },
      attribute_list: [{ attribute_id: LARGE, attribute_value_list: [{ value_id: MAX }] }],
      logistic_info: [{ logistic_id: LARGE, size_id: MAX }],
    });
    expect(h.calls[2]?.body.item_id).toBe(MAX);
    expect(h.calls[2]?.raw).toContain(`"item_id":${MAX}`);
  });

  it("serializes large pickup-address identifiers as JSON numbers, rather than strings", () => {
    const choice = chooseShopeeHandover(
      { info_needed: { pickup: ["address_id"] }, pickup: { address_list: [{ address_id: LARGE }] } },
      "pickup",
    );
    expect(choice.ok).toBe(true);
    if (choice.ok) expect(JSON.stringify(choice.body)).toBe(`{"pickup":{"address_id":${LARGE}}}`);
  });

  it("sends int64 shipping channel and pickup address as numbers throughout mass shipping", async () => {
    const h = harness(({ url }) => {
      if (url.pathname.endsWith("get_order_detail"))
        return `{"response":{"order_list":[{"order_sn":"ORDER","order_status":"READY_TO_SHIP","package_list":[{"package_number":"PKG","logistics_status":"LOGISTICS_READY","logistics_channel_id":${LARGE}}]}]}}`;
      if (url.pathname.endsWith("get_mass_shipping_parameter"))
        return `{"response":{"info_needed":{"pickup":["address_id"]},"pickup":{"address_list":[{"address_id":${MAX}}]},"success_list":[{"package_number":"PKG"}]}}`;
      if (url.pathname.endsWith("mass_ship_order")) return { success_list: [{ package_number: "PKG" }] };
      throw new Error("unexpected request");
    });
    expect(
      await h.connector.fulfillment.arrange(shop, { externalOrderIds: ["ORDER"], method: "pickup" }),
    ).toMatchObject([{ externalOrderId: "ORDER", packages: [{ ok: true }] }]);
    expect(h.calls[1]?.raw).toContain(`"logistics_channel_id":${LARGE}`);
    expect(h.calls[2]?.raw).toContain(`"logistics_channel_id":${LARGE}`);
    expect(h.calls[2]?.raw).toContain(`"address_id":${MAX}`);
  });
});

describe("Shopee stock acknowledgements", () => {
  it("matches colliding int64 model IDs exactly and preserves JSON numeric types", async () => {
    const h = harness(
      () =>
        `{"response":{"success_list":[{"model_id":${LARGE},"location_id":"IDZ","stock":5}],"failure_list":[{"model_id":${NEIGHBOR},"failed_reason":"reserved stock"}]}}`,
    );
    const result = await h.connector.inventory.updateStock(shop, [stock(LARGE), stock(NEIGHBOR)]);
    expect(result.map((r) => [r.externalVariantId, r.ok])).toEqual([
      [LARGE, true],
      [NEIGHBOR, false],
    ]);
    expect(h.calls[0]?.body.item_id).toBe(MAX);
    expect(h.calls[0]?.body.stock_list).toEqual([
      { model_id: LARGE, seller_stock: [{ location_id: "IDZ", stock: 5 }] },
      { model_id: NEIGHBOR, seller_stock: [{ location_id: "IDZ", stock: 5 }] },
    ]);
    expect(h.calls[0]?.raw).toContain(`"item_id":${MAX}`);
  });

  it.each([
    {},
    { response: {} },
    { response: { success_list: [] } },
    { response: { success_list: {} } },
    { response: { success_list: [null] } },
    { response: { success_list: [{ stock: 5, location_id: "IDZ" }] } },
    { response: { success_list: [{ model_id: LARGE }] } },
    { response: { success_list: [{ model_id: LARGE, stock: 4, location_id: "IDZ" }] } },
    { response: { success_list: [{ model_id: LARGE, stock: 5, location_id: "OTHER" }] } },
    { response: { success_list: [{ model_id: LARGE, stock: 5, location_id: "IDZ" }], failure_list: {} } },
  ])("refuses missing/malformed/changed acknowledgements %#", async (reply) => {
    const h = harness(() => reply);
    expect(await h.connector.inventory.updateStock(shop, [stock()])).toMatchObject([{ ok: false, retryable: true }]);
  });

  it("requires each model and every warehouse, including zero stock, to be acknowledged once", async () => {
    const requested = [
      stock(LARGE, [
        { externalWarehouseId: "IDZ", quantity: 5 },
        { externalWarehouseId: "IDA", quantity: 0 },
      ]),
      stock(NEIGHBOR),
    ];
    const h = harness(() => ({
      response: {
        success_list: [
          { model_id: LARGE, location_id: "IDZ", stock: 5 },
          { model_id: LARGE, location_id: "IDA", stock: 0 },
        ],
      },
    }));
    expect((await h.connector.inventory.updateStock(shop, requested)).map((r) => r.ok)).toEqual([true, false]);
    const partial = harness(() => ({
      response: { success_list: [{ model_id: LARGE, location_id: "IDZ", stock: 5 }] },
    }));
    expect(await partial.connector.inventory.updateStock(shop, [requested[0]!])).toMatchObject([
      { ok: false, retryable: true },
    ]);
    const repeated = harness(() => ({
      response: {
        success_list: [
          { model_id: LARGE, location_id: "IDZ", stock: 5 },
          { model_id: LARGE, location_id: "IDZ", stock: 5 },
        ],
      },
    }));
    expect(await repeated.connector.inventory.updateStock(shop, [stock()])).toMatchObject([
      { ok: false, retryable: true },
    ]);
  });

  it("never treats an omitted model ID as a no-variation item success", async () => {
    const h = harness(() => ({ response: { success_list: [{ stock: 0 }] } }));
    expect(
      await h.connector.inventory.updateStock(shop, [stock("", [{ externalWarehouseId: "default", quantity: 0 }])]),
    ).toMatchObject([{ ok: false }]);
    const valid = harness(() => ({ response: { success_list: [{ model_id: 0, stock: 0 }] } }));
    expect(
      await valid.connector.inventory.updateStock(shop, [stock("", [{ externalWarehouseId: "default", quantity: 0 }])]),
    ).toMatchObject([{ ok: true }]);
  });

  it("prioritizes explicit failures when the same model appears in both lists", async () => {
    const h = harness(() => ({
      response: {
        success_list: [{ model_id: LARGE, stock: 5, location_id: "IDZ" }],
        failure_list: [{ model_id: LARGE, failed_reason: "promotion reserved stock" }],
      },
    }));
    expect(await h.connector.inventory.updateStock(shop, [stock()])).toMatchObject([{ ok: false, retryable: false }]);
  });

  it.each(["9223372036854775808", "-1", "invalid"])("refuses invalid int64 model %s without sending it", async (id) => {
    const h = harness(() => grant);
    expect(await h.connector.inventory.updateStock(shop, [stock(id)])).toMatchObject([{ ok: false, retryable: false }]);
    expect(h.calls).toHaveLength(0);
  });
});
