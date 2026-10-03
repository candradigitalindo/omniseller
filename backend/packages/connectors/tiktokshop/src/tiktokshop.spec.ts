import {
  AuthExpiredError,
  AuthRevokedError,
  PermanentConnectorError,
  TransientConnectorError,
} from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { tiktokListingStatus } from "./catalog.js";
import { tiktokSign, tiktokSignString } from "./client.js";
import { createTiktokShopConnector } from "./connector.js";
import { parseTiktokWebhook, verifyTiktokWebhook } from "./webhooks.js";

type Handler = (url: URL, init: RequestInit) => unknown;

/** fetch double: routes by path, records calls, answers JSON. */
function fakeFetch(routes: Record<string, Handler>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const route = routes[`${init.method ?? "GET"} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ code: 36009009, message: "Invalid path" }), { status: 404 });
    const out = route(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

function connector(fetchImpl: typeof fetch) {
  return createTiktokShopConnector({
    appKey: "app-key",
    appSecret: "app-secret",
    serviceId: "7000000000000000001",
    apiBaseUrl: "https://open-api.tiktokglobalshop.com",
    authBaseUrl: "https://auth.tiktok-shops.com",
    authorizeUrl: "https://services.tiktokshop.com/open/authorize",
    http: { fetch: fetchImpl },
  });
}

const now = Math.floor(Date.now() / 1000);
const tokenData = {
  access_token: "TTP_access",
  access_token_expire_in: now + 7 * 86400,
  refresh_token: "TTP_refresh",
  refresh_token_expire_in: now + 365 * 86400,
  open_id: "7010736057180325637",
  seller_name: "Toko Rina",
  seller_base_region: "ID",
  user_type: 0,
  granted_scopes: ["seller.authorization.info", "seller.logistics"],
};

describe("TikTok Shop request signing (Sign your API request)", () => {
  it("reproduces the documented Get Authorized Shops signature", () => {
    const s = tiktokSignString({
      path: "/authorization/202309/shops",
      query: { app_key: "29a39d", timestamp: "1623812664", sign: "ignored", access_token: "ignored" },
    });
    expect(s).toBe("/authorization/202309/shopsapp_key29a39dtimestamp1623812664");
    expect(tiktokSign("e59af819cc", s)).toBe("b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8");
  });

  it("appends the exact body after the sorted parameters, as in the Update Shop Webhook example", () => {
    const s = tiktokSignString({
      path: "/event/202309/webhooks",
      query: { timestamp: "1696909648", shop_cipher: "ROW_xkMbgAAAeVAQra0eZWebFQq5aIK", app_key: "68xu9ks5p4i8" },
      body: '{"address":"https://partner.tiktokshop.com","event_type":"PACKAGE_UPDATE"}',
    });
    expect(s).toBe(
      '/event/202309/webhooksapp_key68xu9ks5p4i8shop_cipherROW_xkMbgAAAeVAQra0eZWebFQq5aIKtimestamp1696909648{"address":"https://partner.tiktokshop.com","event_type":"PACKAGE_UPDATE"}',
    );
  });

  it("signs the bytes it sends and puts the token in x-tts-access-token, not the query", async () => {
    const f = fakeFetch({ "GET /authorization/202309/shops": () => ({ code: 0, data: { shops: [] } }) });
    const token = fakeFetch({ "GET /api/v2/token/get": () => ({ code: 0, data: tokenData }) });
    const c = connector((async (u: URL | string, i?: RequestInit) =>
      String(u).includes("auth.tiktok-shops.com") ? token.fn(u, i) : f.fn(u, i)) as typeof fetch);
    await c.auth.exchangeCode({ code: "TTP_code" });
    const call = f.calls[0]!;
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-tts-access-token"]).toBe("TTP_access");
    expect(call.url.searchParams.has("access_token")).toBe(false);
    const query = Object.fromEntries(call.url.searchParams);
    const expected = tiktokSign("app-secret", tiktokSignString({ path: call.url.pathname, query }));
    expect(query.sign).toBe(expected);
  });
});

describe("TikTok Shop webhooks (Overview)", () => {
  const body =
    '{"type":1,"tts_notification_id":"7380066284010030890","shop_id":"7495540735365777507","timestamp":1718305585,"data":{"is_on_hold_order":true,"order_id":"576653688135258178","order_status":"UNPAID","update_time":1718305585}}';

  it("verifies the documented example signature", () => {
    const req = {
      url: "https://example.com/tiktok-shop/webhooks",
      headers: { authorization: "5dec0f11ec2f6783b8deee53c9ffbf8d024302f7c7e7fa55a35d17629031ac05" },
      rawBody: Buffer.from(body),
    };
    expect(verifyTiktokWebhook("abcdef", "123", req)).toBe(true);
    expect(verifyTiktokWebhook("abcdef", "124", req)).toBe(false);
    expect(verifyTiktokWebhook("abcdef", "123", { ...req, rawBody: Buffer.from(`${body} `) })).toBe(false);
    expect(verifyTiktokWebhook("abcdef", "123", { ...req, headers: {} })).toBe(false);
  });

  it("normalizes order, deauthorization, and expiry notifications", () => {
    const [order] = parseTiktokWebhook(Buffer.from(body));
    expect(order).toMatchObject({
      eventId: "7380066284010030890",
      kind: "order.status_changed",
      externalShopIds: ["7495540735365777507"],
      data: { externalOrderId: "576653688135258178", status: "UNPAID" },
    });

    const [revoked] = parseTiktokWebhook(
      Buffer.from(
        '{"type":6,"tts_notification_id":"7327112393057371910","shop_id":"7494049642642441621","timestamp":1644412885,"data":{"message":"Shop_id {xxx} is deauthorized from your APP by merchant."}}',
      ),
    );
    expect(revoked).toMatchObject({ kind: "authorization.revoked", code: "SELLER_DEAUTHORIZATION" });

    const [expiring] = parseTiktokWebhook(
      Buffer.from(
        '{"type":7,"tts_notification_id":"1","shop_id":"749","timestamp":1644412885,"data":{"message":"expiring","expiration_time":"1627587506"}}',
      ),
    );
    expect(expiring?.kind).toBe("authorization.expiring");
    expect(expiring?.data.expiresAt?.toISOString()).toBe(new Date(1627587506 * 1000).toISOString());

    // The reauthorization guide shows the topic name instead of the numeric type.
    const [named] = parseTiktokWebhook(
      Buffer.from(
        '{"event_type":"UPCOMING_AUTHORIZATION_EXPIRATION","shop_id":"749","timestamp":1,"data":{"expiration_time":1699501648}}',
      ),
    );
    expect(named?.kind).toBe("authorization.expiring");
    expect(named?.eventId).toMatch(/^[0-9a-f]{64}$/);

    expect(parseTiktokWebhook(Buffer.from("not json"))).toEqual([]);
  });
});

describe("TikTok Shop authorization", () => {
  it("builds the non-US seller authorization link with service_id and state", () => {
    const c = connector(fetch);
    const url = new URL(c.auth.authorizeUrl({ state: "st4te", redirectUri: "ignored" }));
    expect(url.origin + url.pathname).toBe("https://services.tiktokshop.com/open/authorize");
    expect(url.searchParams.get("service_id")).toBe("7000000000000000001");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(c.auth.revokeUrl({ redirectUri: "x" })).toBeNull();
  });

  it("exchanges the code with grant_type=authorized_code and lists the authorized shops", async () => {
    const f = fakeFetch({
      "GET /api/v2/token/get": (url) => {
        expect(url.searchParams.get("grant_type")).toBe("authorized_code");
        expect(url.searchParams.get("auth_code")).toBe("TTP_code");
        expect(url.searchParams.get("app_secret")).toBe("app-secret");
        return { code: 0, message: "success", data: tokenData };
      },
      "GET /authorization/202309/shops": () => ({
        code: 0,
        data: {
          shops: [
            { id: "7495", name: "Toko Rina", region: "ID", seller_type: "LOCAL", cipher: "ROW_abc", code: "IDLC1" },
          ],
        },
      }),
    });
    const c = connector(f.fn);
    const grant = await c.auth.exchangeCode({ code: "TTP_code" });
    expect(grant.tokens.accessToken).toBe("TTP_access");
    expect(grant.tokens.scopes).toContain("seller.logistics");
    expect(grant.shops).toEqual([
      {
        externalShopId: "7495",
        shopCipher: "ROW_abc",
        name: "Toko Rina",
        region: "ID",
        info: { seller_type: "LOCAL", shop_code: "IDLC1" },
      },
    ]);
    const [profile] = await c.shops.describe(grant);
    expect(profile?.authorizationExpiresAt?.getTime()).toBe(tokenData.refresh_token_expire_in * 1000);
    expect(profile?.info).toMatchObject({ open_id: tokenData.open_id, seller_type: "LOCAL" });
  });

  it("refuses authorizations that are not from a seller", async () => {
    const f = fakeFetch({ "GET /api/v2/token/get": () => ({ code: 0, data: { ...tokenData, user_type: 1 } }) });
    await expect(connector(f.fn).auth.exchangeCode({ code: "c" })).rejects.toBeInstanceOf(PermanentConnectorError);
  });

  it("classifies errors: expired token, rate limit, bad refresh token", async () => {
    const expired = fakeFetch({
      "GET /logistics/202309/warehouses": () => ({ code: 105002, message: "Expired credentials." }),
    });
    await expect(
      connector(expired.fn).warehouses.list({ externalShopId: "1", shopCipher: "c", accessToken: "t" }),
    ).rejects.toBeInstanceOf(AuthExpiredError);

    const limited = fakeFetch({
      "GET /logistics/202309/warehouses": () =>
        new Response(JSON.stringify({ code: 36009002, message: "Too many requests" }), {
          status: 429,
          headers: { "retry-after": "3" },
        }),
    });
    const err = await connector(limited.fn)
      .warehouses.list({ externalShopId: "1", shopCipher: "c", accessToken: "t" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientConnectorError);
    expect((err as TransientConnectorError).retryAfterMs).toBe(3000);

    const badRefresh = fakeFetch({
      "GET /api/v2/token/refresh": () => ({ code: 36004004, message: "Invalid refresh token" }),
    });
    await expect(
      connector(badRefresh.fn).auth.refresh({ refreshToken: "r", externalShopId: "1" }),
    ).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("TikTok Shop warehouses and webhook subscription", () => {
  const shop = { externalShopId: "7495", shopCipher: "ROW_abc", accessToken: "t" };

  it("keeps sales warehouses, drops return warehouses and contact data, adds subscribed FBT warehouses", async () => {
    const f = fakeFetch({
      "GET /logistics/202309/warehouses": () => ({
        code: 0,
        data: {
          warehouses: [
            {
              id: "w1",
              name: "Gudang Jakarta",
              effect_status: "ENABLED",
              type: "SALES_WAREHOUSE",
              sub_type: "DOMESTIC_WAREHOUSE",
              is_default: true,
              address: { city: "Jakarta Barat", contact_person: "Rina", phone_number: "0812", distict: "Kebon Jeruk" },
            },
            { id: "w2", name: "Retur", type: "RETURN_WAREHOUSE", is_default: false },
          ],
        },
      }),
      "GET /fbt/202409/merchants/onboarded_regions": () => ({
        code: 0,
        data: { onboarded_regions: [{ region_code: "ID" }] },
      }),
      "GET /fbt/202408/warehouses": () => ({
        code: 0,
        data: {
          warehouses: [
            { fbt_warehouse_id: "f1", name: "FBT Cikarang", subscribed: true, warehouse_ids: ["x"] },
            { fbt_warehouse_id: "f2", name: "FBT Surabaya", subscribed: false },
          ],
        },
      }),
    });
    const list = await connector(f.fn).warehouses.list(shop);
    expect(list.map((w) => [w.externalId, w.kind, w.isDefault])).toEqual([
      ["w1", "seller", true],
      ["f1", "fulfillment", false],
    ]);
    expect(list[0]?.address).toEqual({
      city: "Jakarta Barat",
      district: "Kebon Jeruk",
      effect_status: "ENABLED",
      sub_type: "DOMESTIC_WAREHOUSE",
    });
    for (const c of f.calls) expect(c.url.searchParams.get("shop_cipher")).toBe("ROW_abc");
  });

  it("treats a missing FBT scope as not onboarded", async () => {
    const f = fakeFetch({
      "GET /logistics/202309/warehouses": () => ({ code: 0, data: { warehouses: [] } }),
      "GET /fbt/202409/merchants/onboarded_regions": () => ({ code: 105005, message: "Access denied." }),
    });
    expect(await connector(f.fn).warehouses.list(shop)).toEqual([]);
  });

  it("subscribes only the topics not yet pointing at the address", async () => {
    const put: string[] = [];
    const f = fakeFetch({
      "GET /event/202309/webhooks": () => ({
        code: 0,
        data: {
          webhooks: [
            { event_type: "SELLER_DEAUTHORIZATION", address: "https://hooks.omniseller.id/webhooks/tiktokshop" },
            { event_type: "ORDER_STATUS_CHANGE", address: "https://old.example.com" },
          ],
        },
      }),
      "PUT /event/202309/webhooks": (_u, init) => {
        put.push((JSON.parse(String(init.body)) as { event_type: string }).event_type);
        return { code: 0, data: {} };
      },
    });
    const c = connector(f.fn);
    await c.webhooks.subscribe?.(shop, "https://hooks.omniseller.id/webhooks/tiktokshop");
    expect(put).not.toContain("SELLER_DEAUTHORIZATION");
    expect(put).toContain("ORDER_STATUS_CHANGE");
    expect(put).toContain("UPCOMING_AUTHORIZATION_EXPIRATION");
  });
});

describe("TikTok Shop catalog", () => {
  const shop = { externalShopId: "7495", shopCipher: "ROW_abc", accessToken: "t" };
  const detail = {
    id: "1729592969712207008",
    title: "Kaos Polos",
    status: "ACTIVATE",
    integrated_platform_statuses: [{ platform: "TOKOPEDIA", status: "SELLER_DEACTIVATED" }],
    main_images: [{ urls: ["https://p16.tiktokcdn.com/main.jpg"] }],
    package_weight: { value: "0.3", unit: "KILOGRAM" },
    package_dimensions: { length: "20", width: "15", height: "3", unit: "CENTIMETER" },
    category_chains: [{ local_name: "Pakaian Pria" }, { local_name: "Kaos" }],
    skus: [
      {
        id: "1729592969712207012",
        seller_sku: "KAOS-HTM-L",
        price: { currency: "IDR", tax_exclusive_price: "65000" },
        inventory: [
          { warehouse_id: "w-jkt", quantity: 10 },
          { warehouse_id: "w-sby", quantity: 5 },
        ],
        sales_attributes: [
          { name: "Warna", value_name: "Hitam", sku_img: { urls: ["https://p16.tiktokcdn.com/hitam.jpg"] } },
          { name: "Ukuran", value_name: "L" },
        ],
        status_info: { status: "NORMAL" },
      },
      {
        id: "1729592969712207013",
        seller_sku: "KAOS-HTM-XL",
        price: { tax_exclusive_price: "67000" },
        inventory: [],
        sales_attributes: [
          { name: "Warna", value_name: "Hitam" },
          { name: "Ukuran", value_name: "XL" },
        ],
        status_info: { status: "DEACTIVATED", deactivation_source: "PLATFORM" },
      },
    ],
  };

  it("searches products, reads each one's details, and reports deleted products", async () => {
    const f = fakeFetch({
      "POST /product/202502/products/search": (url, init) => {
        expect(url.searchParams.get("page_size")).toBe("100");
        expect(url.searchParams.get("page_token")).toBe("tok1");
        expect(JSON.parse(String(init.body))).toEqual({ status: "ALL", update_time_ge: 1790000000 });
        return {
          code: 0,
          data: {
            products: [
              { id: "1729592969712207008", status: "ACTIVATE" },
              { id: "1729592969712209999", status: "DELETED" },
            ],
            next_page_token: "",
          },
        };
      },
      "GET /product/202309/products/1729592969712207008": () => ({ code: 0, data: detail }),
    });
    const page = await connector(f.fn).catalog.listListings(shop, {
      cursor: "tok1",
      updatedSince: new Date(1_790_000_000_000),
    });
    expect(page.nextCursor).toBeNull();
    expect(page.deletedItemIds).toEqual(["1729592969712209999"]);
    expect(page.listings.map((l) => [l.externalVariantId, l.sku, l.variantName, l.status, l.price, l.stock])).toEqual([
      ["1729592969712207012", "KAOS-HTM-L", "Hitam, L", "active", 65000, 15],
      ["1729592969712207013", "KAOS-HTM-XL", "Hitam, XL", "banned", 67000, 0],
    ]);
    expect(page.listings[0]).toMatchObject({
      stockByWarehouse: { "w-jkt": 10, "w-sby": 5 },
      imageUrl: "https://p16.tiktokcdn.com/hitam.jpg",
      weightG: 300,
      dimensionsMm: { length: 200, width: 150, height: 30 },
      categoryPath: "Pakaian Pria > Kaos",
      statusDetail: { tiktok_shop: "ACTIVATE", tokopedia: "SELLER_DEACTIVATED", sku: "NORMAL" },
    });
  });

  it("counts a product active when it sells on TikTok Shop or Tokopedia", () => {
    expect(tiktokListingStatus(undefined, [{ platform: "TOKOPEDIA", status: "ACTIVATE" }])).toBe("active");
    expect(tiktokListingStatus("SELLER_DEACTIVATED", [{ platform: "TOKOPEDIA", status: "ACTIVATE" }])).toBe("active");
    expect(tiktokListingStatus("PENDING")).toBe("reviewing");
    expect(tiktokListingStatus("FREEZE", [{ platform: "TOKOPEDIA", status: "PLATFORM_DEACTIVATED" }])).toBe("banned");
    expect(tiktokListingStatus("ACTIVATE", [], { status: "DEACTIVATED", deactivation_source: "SELLER" })).toBe(
      "inactive",
    );
    expect(tiktokListingStatus(undefined)).toBe("unknown");
  });

  it("activates and deactivates, reading per-product errors even when code is 0", async () => {
    const f = fakeFetch({
      "POST /product/202309/products/deactivate": (_u, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ product_ids: ["1", "2"] });
        return {
          code: 0,
          data: {
            errors: [
              {
                code: 12052990,
                message: "Batch deactivate business error.",
                detail: {
                  product_id: "2",
                  extra_errors: [{ code: 12052048, message: "You can't edit other sellers' products" }],
                },
              },
            ],
          },
        };
      },
    });
    expect(await connector(f.fn).catalog.setListingStatus(shop, ["1", "2"], false)).toEqual([
      { externalItemId: "1", ok: true },
      { externalItemId: "2", ok: false, error: "You can't edit other sellers' products" },
    ]);
  });

  it("keeps 19-digit product ids exact in product webhooks", () => {
    const [e] = parseTiktokWebhook(
      Buffer.from(
        '{"type":5,"tts_notification_id":"7327112393057371910","shop_id":"7494049642642441621","timestamp":1644412885,"data":{"product_id":576486316948490012,"status":"PRODUCT_AUDIT_FAILURE","suspended_reason":"","update_time":1644412885}}',
      ),
    );
    expect(e).toMatchObject({
      kind: "listing.changed",
      code: "PRODUCT_STATUS_CHANGE",
      data: { externalItemId: "576486316948490012" },
    });
  });
});

describe("TikTok Shop stock (Update Inventory 202309)", () => {
  const shop = { externalShopId: "7494049642642441621", shopCipher: "ROW_cipher", accessToken: "TTP_access" };
  type Body = { skus: { id: string; inventory: { warehouse_id: string; quantity: number }[] }[] };

  it("sends one call per product with every warehouse of each SKU, capped at 99,999", async () => {
    const calls: { product: string; body: Body }[] = [];
    const f = fakeFetch({
      "POST /product/202309/products/1729382561353664372/inventory/update": (url, init) => {
        expect(url.searchParams.get("shop_cipher")).toBe("ROW_cipher");
        calls.push({ product: "1729382561353664372", body: JSON.parse(String(init.body)) as Body });
        return { code: 0, message: "Success", data: {} };
      },
      "POST /product/202309/products/1729382561353664999/inventory/update": (_url, init) => {
        calls.push({ product: "1729382561353664999", body: JSON.parse(String(init.body)) as Body });
        return { code: 0, message: "Success", data: {} };
      },
    });
    const results = await connector(f.fn).inventory.updateStock(shop, [
      {
        externalItemId: "1729382561353664372",
        externalVariantId: "1729592969712207013",
        warehouses: [
          { externalWarehouseId: "7068517275539719942", quantity: 120000 },
          { externalWarehouseId: "7068517275539719943", quantity: 0 },
        ],
      },
      {
        externalItemId: "1729382561353664999",
        externalVariantId: "1729592969712207999",
        warehouses: [{ externalWarehouseId: "7068517275539719942", quantity: 7 }],
      },
      {
        externalItemId: "1729382561353664372",
        externalVariantId: "1729592969712207014",
        warehouses: [{ externalWarehouseId: "7068517275539719942", quantity: 3 }],
      },
    ]);
    expect(calls).toEqual([
      {
        product: "1729382561353664372",
        body: {
          skus: [
            {
              id: "1729592969712207013",
              inventory: [
                { warehouse_id: "7068517275539719942", quantity: 99_999 },
                { warehouse_id: "7068517275539719943", quantity: 0 },
              ],
            },
            { id: "1729592969712207014", inventory: [{ warehouse_id: "7068517275539719942", quantity: 3 }] },
          ],
        },
      },
      {
        product: "1729382561353664999",
        body: {
          skus: [{ id: "1729592969712207999", inventory: [{ warehouse_id: "7068517275539719942", quantity: 7 }] }],
        },
      },
    ]);
    expect(results.map((r) => [r.externalVariantId, r.ok])).toEqual([
      ["1729592969712207013", true],
      ["1729592969712207999", true],
      ["1729592969712207014", true],
    ]);
  });

  it("reads per-SKU errors from data.errors even when code is 0", async () => {
    const f = fakeFetch({
      "POST /product/202309/products/1/inventory/update": () => ({
        code: 0,
        message: "Success",
        data: {
          errors: [
            {
              code: 12052990,
              message: "Batch update inventory error.",
              detail: {
                sku_id: "12",
                extra_errors: [
                  {
                    warehouse_id: "W1",
                    code: 12052393,
                    message: "Product locked for Promotion and stock can't be updated below current stock",
                  },
                ],
              },
            },
          ],
        },
      }),
    });
    const results = await connector(f.fn).inventory.updateStock(shop, [
      { externalItemId: "1", externalVariantId: "11", warehouses: [{ externalWarehouseId: "W1", quantity: 5 }] },
      { externalItemId: "1", externalVariantId: "12", warehouses: [{ externalWarehouseId: "W1", quantity: 0 }] },
    ]);
    expect(results[0]).toEqual({ externalItemId: "1", externalVariantId: "11", ok: true });
    expect(results[1]).toMatchObject({ externalVariantId: "12", ok: false, retryable: false });
    expect(results[1]!.error).toContain("Product locked for Promotion");
    expect(results[1]!.error).toContain("gudang W1");
  });

  it("marks internal errors retryable, refusals not, and throws authorization errors", async () => {
    const f = fakeFetch({
      "POST /product/202309/products/1/inventory/update": () => ({
        code: 36009003,
        message: "Internal error. Please try again.",
      }),
      "POST /product/202309/products/2/inventory/update": () => ({
        code: 12019028,
        message: "Multiple warehouses detected. Include all warehouse IDs and the corresponding details and try again.",
      }),
    });
    const results = await connector(f.fn).inventory.updateStock(shop, [
      { externalItemId: "1", externalVariantId: "11", warehouses: [{ externalWarehouseId: "W1", quantity: 1 }] },
      { externalItemId: "2", externalVariantId: "21", warehouses: [{ externalWarehouseId: "W1", quantity: 1 }] },
    ]);
    expect(results.map((r) => [r.ok, r.retryable])).toEqual([
      [false, true],
      [false, false],
    ]);

    const expired = fakeFetch({
      "POST /product/202309/products/1/inventory/update": () => ({ code: 105002, message: "Expired credentials." }),
    });
    await expect(
      connector(expired.fn).inventory.updateStock(shop, [
        { externalItemId: "1", externalVariantId: "11", warehouses: [{ externalWarehouseId: "W1", quantity: 1 }] },
      ]),
    ).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
