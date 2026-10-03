import { createHmac } from "node:crypto";
import {
  AuthExpiredError,
  AuthRevokedError,
  PermanentConnectorError,
  TransientConnectorError,
} from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { accessExpiry, classifyShopeeError, shopeeBaseString, shopeeSign } from "./client.js";
import { createShopeeConnector, SHOPEE_DEFAULT_WAREHOUSE_ID, SHOPEE_FBS_WAREHOUSE_ID } from "./connector.js";
import { parseShopeePush, verifyShopeePush } from "./webhooks.js";

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

const PARTNER_KEY = "partner-key-for-tests";

function connector(fetchImpl: typeof fetch) {
  return createShopeeConnector({
    partnerId: 2001887,
    partnerKey: PARTNER_KEY,
    apiBaseUrl: "https://partner.shopeemobile.com",
    authBaseUrl: "https://open.shopee.com",
    http: { fetch: fetchImpl },
  });
}

describe("Shopee signatures (API calls, Signature calculation)", () => {
  it("builds the documented base strings for shop and public APIs", () => {
    expect(
      shopeeBaseString({
        partnerId: 2001887,
        path: "/api/v2/shop/get_shop_info",
        timestamp: 1655714431,
        accessToken: "59777174636562737266615546704c6d",
        shopId: "14701711",
      }),
    ).toBe("2001887/api/v2/shop/get_shop_info165571443159777174636562737266615546704c6d14701711");
    expect(
      shopeeBaseString({ partnerId: 2001887, path: "/api/v2/public/get_shops_by_partner", timestamp: 1655714431 }),
    ).toBe("2001887/api/v2/public/get_shops_by_partner1655714431");
  });

  it("signs with HMAC-SHA256 keyed by the partner key, lower-case hex", () => {
    const expected = createHmac("sha256", "k").update("base").digest("hex");
    expect(shopeeSign("k", "base")).toBe(expected);
  });

  it("puts the common parameters in the query and signs shop calls with token and shop id", async () => {
    const f = fakeFetch({
      "GET /api/v2/shop/get_shop_info": () => ({
        error: "",
        shop_name: "Toko",
        region: "ID",
        shop_fulfillment_flag: "Others",
      }),
      "GET /api/v2/shop/get_warehouse_detail": () => ({
        error: "warehouse.error_not_in_whitelist",
        message: "Your shop is not in multi-warehouse whitelist.",
      }),
      "GET /api/v2/logistics/get_address_list": () => ({ error: "", response: { address_list: [] } }),
    });
    await connector(f.fn).warehouses.list({ externalShopId: "14701711", shopCipher: null, accessToken: "tok" });
    const call = f.calls[0]!;
    const q = call.url.searchParams;
    expect(q.get("partner_id")).toBe("2001887");
    expect(q.get("shop_id")).toBe("14701711");
    expect(q.get("access_token")).toBe("tok");
    const base = shopeeBaseString({
      partnerId: 2001887,
      path: "/api/v2/shop/get_shop_info",
      timestamp: Number(q.get("timestamp")),
      accessToken: "tok",
      shopId: "14701711",
    });
    expect(q.get("sign")).toBe(shopeeSign(PARTNER_KEY, base));
  });
});

describe("Shopee authorization (Authorization and Authentication)", () => {
  it("builds the new-style link with auth_type, redirect_uri, response_type and state", () => {
    const url = new URL(
      connector(fetch).auth.authorizeUrl({ state: "s1", redirectUri: "https://app.omniseller.id/cb" }),
    );
    expect(url.origin + url.pathname).toBe("https://open.shopee.com/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      partner_id: "2001887",
      auth_type: "seller",
      redirect_uri: "https://app.omniseller.id/cb",
      response_type: "code",
      state: "s1",
    });
    expect(connector(fetch).auth.revokeUrl({ redirectUri: "https://app.omniseller.id/cb" })).toContain("/cancel_auth?");
  });

  it("exchanges a shop code: partner_id in query and body, shop_id as a number", async () => {
    const f = fakeFetch({
      "POST /api/v2/auth/token/get": (url, init) => {
        expect(url.searchParams.get("partner_id")).toBe("2001887");
        expect(JSON.parse(String(init.body))).toEqual({ code: "abc", partner_id: 2001887, shop_id: 54804 });
        return { refresh_token: "r1", access_token: "a1", expire_in: 13859, request_id: "x", error: "", message: "" };
      },
    });
    const grant = await connector(f.fn).auth.exchangeCode({ code: "abc", shopId: "54804" });
    expect(grant.shops.map((s) => s.externalShopId)).toEqual(["54804"]);
    expect(grant.tokens.refreshToken).toBe("r1");
    expect(grant.tokens.accessExpiresAt.getTime() - Date.now()).toBeGreaterThan(13_000_000);
  });

  it("exchanges a main-account code into every authorized shop", async () => {
    const f = fakeFetch({
      "POST /api/v2/auth/token/get": (_u, init) => {
        expect(JSON.parse(String(init.body))).toMatchObject({ main_account_id: 10208 });
        return {
          refresh_token: "r",
          access_token: "a",
          expire_in: 14344,
          shop_id_list: [33142, 46154],
          merchant_id_list: [1001705],
          error: "",
        };
      },
    });
    const grant = await connector(f.fn).auth.exchangeCode({ code: "c", mainAccountId: "10208" });
    expect(grant.shops.map((s) => s.externalShopId)).toEqual(["33142", "46154"]);
    expect(grant.principal).toMatchObject({ main_account_id: "10208", merchant_ids: "1001705" });
  });

  it("refreshes per shop and classifies expired refresh tokens as revoked", async () => {
    const ok = fakeFetch({
      "POST /api/v2/auth/access_token/get": (_u, init) => {
        expect(JSON.parse(String(init.body))).toEqual({ refresh_token: "r1", partner_id: 2001887, shop_id: 54804 });
        return {
          partner_id: 2001887,
          shop_id: 54804,
          refresh_token: "r2",
          access_token: "a2",
          expire_in: 14400,
          error: "",
        };
      },
    });
    expect((await connector(ok.fn).auth.refresh({ refreshToken: "r1", externalShopId: "54804" })).refreshToken).toBe(
      "r2",
    );

    const expired = fakeFetch({
      "POST /api/v2/auth/access_token/get": () => ({
        error: "refresh_token_expired",
        message: "Your refresh_token expired.",
      }),
    });
    await expect(
      connector(expired.fn).auth.refresh({ refreshToken: "r1", externalShopId: "54804" }),
    ).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("reads expire_in as seconds, or as a timestamp when it can only be one", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(accessExpiry(14400, now).toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(accessExpiry(1767001812, now).getTime()).toBe(1767001812 * 1000);
    expect(() => accessExpiry(undefined, now)).toThrow(PermanentConnectorError);
  });
});

describe("Shopee error classification (common error list)", () => {
  it.each([
    ["invalid_acceess_token", "Invalid access_token, please have a check.", 403, "auth_expired"],
    ["error_auth", "Invalid access_token.", 403, "auth_expired"],
    ["error_auth", "Invalid partner_id or shopid.", 403, "auth_revoked"],
    ["partner_shop_no_link", "Invalid partner_id or shop_id, please have a check.", 403, "auth_revoked"],
    ["shop_banned", "The shop account has been banned.", 403, "auth_revoked"],
    ["error_auth", "System error, please try again later.", 500, "transient"],
    ["error_rate_limit", "Too many requests.", 429, "transient"],
    ["error_server", "Something wrong. Please try later.", 500, "transient"],
    ["error_sign", "Wrong sign.", 403, "permanent"],
    ["error_param", "Wrong parameters", 400, "permanent"],
  ])("%s / %s -> %s", (error, message, status, kind) => {
    expect(classifyShopeeError(error, message, status)).toBe(kind);
  });

  it("maps an invalid token on a shop call to AuthExpiredError and rate limits to a delay", async () => {
    const f = fakeFetch({
      "GET /api/v2/shop/get_shop_info": () =>
        new Response(
          JSON.stringify({ error: "invalid_acceess_token", message: "Invalid access_token", request_id: "rq" }),
          {
            status: 403,
          },
        ),
    });
    const err = await connector(f.fn)
      .warehouses.list({ externalShopId: "1", shopCipher: null, accessToken: "t" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthExpiredError);
    expect((err as AuthExpiredError).requestId).toBe("rq");

    const limited = fakeFetch({
      "GET /api/v2/shop/get_shop_info": () => ({ error: "error_rate_limit", message: "Too many requests." }),
    });
    const e2 = await connector(limited.fn)
      .warehouses.list({ externalShopId: "1", shopCipher: null, accessToken: "t" })
      .catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(TransientConnectorError);
    expect((e2 as TransientConnectorError).retryAfterMs).toBe(60_000);
  });
});

describe("Shopee warehouses", () => {
  const shop = { externalShopId: "1", shopCipher: null, accessToken: "t" };

  it("uses location_id for multi-warehouse shops and merges addresses sharing a location", async () => {
    const f = fakeFetch({
      "GET /api/v2/shop/get_shop_info": () => ({ error: "", shop_fulfillment_flag: "Others" }),
      "GET /api/v2/shop/get_warehouse_detail": (url) => {
        expect(url.searchParams.get("warehouse_type")).toBe("1");
        return {
          error: "",
          response: [
            {
              warehouse_id: 6,
              warehouse_name: "Jakarta Barat",
              warehouse_type: 1,
              location_id: "IDZ",
              city: "Jakarta",
            },
            { warehouse_id: 7, warehouse_name: "Tangerang", warehouse_type: 1, location_id: "IDZ" },
            { warehouse_id: 8, warehouse_name: "Sidoarjo", warehouse_type: 1, location_id: "IDS" },
          ],
        };
      },
    });
    const list = await connector(f.fn).warehouses.list(shop);
    expect(list.map((w) => [w.externalId, w.name, w.kind])).toEqual([
      ["IDZ", "Jakarta Barat / Tangerang", "seller"],
      ["IDS", "Sidoarjo", "seller"],
    ]);
  });

  it("gives shops outside the programme one default warehouse with the pickup address", async () => {
    const f = fakeFetch({
      "GET /api/v2/shop/get_shop_info": () => ({ error: "", shop_fulfillment_flag: "Others" }),
      "GET /api/v2/shop/get_warehouse_detail": () => ({ error: "warehouse.error_not_in_whitelist", message: "no" }),
      "GET /api/v2/logistics/get_address_list": () => ({
        error: "",
        response: {
          address_list: [
            { address_id: 1, city: "Bandung", address_type: [] },
            { address_id: 2, city: "Jakarta", address_type: ["PICK_UP_ADDRESS"] },
          ],
        },
      }),
    });
    const list = await connector(f.fn).warehouses.list(shop);
    expect(list).toEqual([
      {
        externalId: SHOPEE_DEFAULT_WAREHOUSE_ID,
        name: "Gudang toko",
        kind: "seller",
        isDefault: true,
        address: { address_id: 2, city: "Jakarta" },
      },
    ]);
  });

  it("adds the Shopee-managed warehouse for FBS shops and no seller warehouse for pure FBS", async () => {
    const pure = fakeFetch({
      "GET /api/v2/shop/get_shop_info": () => ({ error: "", shop_fulfillment_flag: "Pure - FBS Shop" }),
    });
    expect((await connector(pure.fn).warehouses.list(shop)).map((w) => [w.externalId, w.kind])).toEqual([
      [SHOPEE_FBS_WAREHOUSE_ID, "fulfillment"],
    ]);
  });
});

describe("Shopee push (Push Mechanism)", () => {
  const url = "https://hooks.omniseller.id/webhooks/shopee";

  it("verifies Authorization = HMAC(partner_key, url|raw_body)", () => {
    const body =
      '{"data":{"items":[],"ordersn":"220810QSK8S7BX","status":"PROCESSED"},"shop_id":727720655,"code":3,"timestamp":1660123127}';
    const sig = createHmac("sha256", PARTNER_KEY).update(`${url}|${body}`).digest("hex");
    const req = { url, headers: { authorization: sig }, rawBody: Buffer.from(body) };
    expect(verifyShopeePush(PARTNER_KEY, req)).toBe(true);
    expect(verifyShopeePush(PARTNER_KEY, { ...req, url: `${url}/` })).toBe(false);
    expect(verifyShopeePush("other", req)).toBe(false);
  });

  it("normalizes order, cancellation (including shopid), and expiry pushes", () => {
    const [order] = parseShopeePush(
      Buffer.from(
        '{"data":{"ordersn":"220810QSK8S7BX","status":"PROCESSED"},"shop_id":727720655,"code":3,"timestamp":1660123127}',
      ),
    );
    expect(order).toMatchObject({
      kind: "order.status_changed",
      externalShopIds: ["727720655"],
      data: { externalOrderId: "220810QSK8S7BX", status: "PROCESSED" },
    });

    const [expiredAuth] = parseShopeePush(
      Buffer.from(
        '{"data":{"authorize_type":"expiry","shopid":22000000,"success":1,"extra":"The authorization is expired."},"code":2,"partner_id":800000,"timestamp":1653026985}',
      ),
    );
    expect(expiredAuth).toMatchObject({
      kind: "authorization.revoked",
      externalShopIds: ["22000000"],
      data: { reason: "expiry" },
    });

    const [bySeller] = parseShopeePush(
      Buffer.from(
        '{"data":{"authorize_type":"user cancel shop authorization","success":1,"extra":"shop id 22000000 (VN) has been cancelled its authorization"},"code":2,"partner_id":800000,"timestamp":1653394175}',
      ),
    );
    expect(bySeller).toMatchObject({ kind: "authorization.revoked", externalShopIds: ["22000000"] });

    const [soon] = parseShopeePush(
      Buffer.from(
        '{"code":12,"timestamp":1568606634,"data":{"merchant_expire_soon":[1],"shop_expire_soon":[23213,243242],"expire_before":1619740800,"page_no":1,"total_page":1}}',
      ),
    );
    expect(soon).toMatchObject({ kind: "authorization.expiring", externalShopIds: ["23213", "243242"] });
    expect(soon?.data.expiresAt?.getTime()).toBe(1619740800 * 1000);

    const [main] = parseShopeePush(
      Buffer.from(
        '{"data":{"authorize_type":"shop authorization by user","main_account_id":68272,"shop_id_list":[62000001,62000002],"success":1},"partner_id":2000002,"code":1,"timestamp":1660616631}',
      ),
    );
    expect(main).toMatchObject({ kind: "authorization.granted", externalShopIds: ["62000001", "62000002"] });
    expect(main?.eventId).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Shopee catalog (v2.product)", () => {
  const shop = { externalShopId: "1", shopCipher: null, accessToken: "t" };

  it("pages items, repeats item_status, expands models into listings with attributes and stock", async () => {
    const f = fakeFetch({
      "GET /api/v2/product/get_item_list": (url) => {
        expect(url.searchParams.getAll("item_status")).toEqual([
          "NORMAL",
          "BANNED",
          "UNLIST",
          "REVIEWING",
          "SELLER_DELETE",
          "SHOPEE_DELETE",
        ]);
        expect(url.searchParams.has("update_time_from")).toBe(false);
        return {
          error: "",
          response: {
            item: [
              { item_id: 100, item_status: "NORMAL" },
              { item_id: 200, item_status: "UNLIST" },
              { item_id: 300, item_status: "SELLER_DELETE" },
            ],
            has_next_page: true,
            next_offset: 3,
          },
        };
      },
      "GET /api/v2/product/get_item_base_info": (url) => {
        expect(url.searchParams.get("item_id_list")).toBe("100,200");
        return {
          error: "",
          response: {
            item_list: [
              {
                item_id: 100,
                item_name: "Kaos Polos",
                item_sku: "KAOS",
                item_status: "NORMAL",
                has_model: true,
                weight: "0.25",
                image: { image_url_list: ["https://cf.shopee.co.id/file/kaos"] },
                brand: { original_brand_name: "NoBrand" },
              },
              {
                item_id: 200,
                item_name: "Topi",
                item_sku: "TOPI-01",
                item_status: "UNLIST",
                has_model: false,
                weight: "0.1",
                price_info: [{ current_price: 45000, original_price: 50000 }],
                stock_info_v2: {
                  summary_info: { total_available_stock: 7 },
                  seller_stock: [{ location_id: "IDZ", stock: 7 }],
                },
              },
            ],
          },
        };
      },
      "GET /api/v2/product/get_model_list": (url) => {
        expect(url.searchParams.get("item_id")).toBe("100");
        return {
          error: "",
          response: {
            tier_variation: [
              {
                name: "Warna",
                option_list: [{ option: "Hitam", image: { image_url: "https://cf.shopee.co.id/file/hitam" } }],
              },
              { name: "Ukuran", option_list: [{ option: "M" }, { option: "L" }] },
            ],
            model: [
              {
                model_id: 11,
                model_sku: "KAOS-HTM-M",
                tier_index: [0, 0],
                model_status: "MODEL_NORMAL",
                price_info: [{ current_price: 65000, original_price: 70000 }],
                stock_info_v2: {
                  summary_info: { total_available_stock: 12 },
                  seller_stock: [{ location_id: "IDZ", stock: 12 }],
                },
              },
              {
                model_id: 12,
                model_sku: "",
                tier_index: [0, 1],
                model_status: "MODEL_UNAVAILABLE",
                price_info: [{ current_price: 65000 }],
              },
            ],
          },
        };
      },
    });
    const page = await connector(f.fn).catalog.listListings(shop, {});
    expect(page.nextCursor).toBe("3");
    expect(page.deletedItemIds).toEqual(["300"]);
    expect(
      page.listings.map((l) => [
        l.externalItemId,
        l.externalVariantId,
        l.sku,
        l.variantName,
        l.status,
        l.price,
        l.stock,
      ]),
    ).toEqual([
      ["100", "11", "KAOS-HTM-M", "Hitam, M", "active", 65000, 12],
      ["100", "12", null, "Hitam, L", "inactive", 65000, null],
      ["200", "", "TOPI-01", null, "inactive", 45000, 7],
    ]);
    expect(page.listings[0]).toMatchObject({
      attributes: { Warna: "Hitam", Ukuran: "M" },
      imageUrl: "https://cf.shopee.co.id/file/hitam",
      itemSku: "KAOS",
      weightG: 250,
      brand: null,
      stockByWarehouse: { IDZ: 12 },
    });
  });

  it("adds an update-time window for incremental pulls", async () => {
    const f = fakeFetch({
      "GET /api/v2/product/get_item_list": (url) => {
        expect(Number(url.searchParams.get("update_time_from"))).toBe(1_790_000_000);
        expect(url.searchParams.get("update_time_to")).toMatch(/^\d{10}$/);
        return { error: "", response: { item: [], has_next_page: false } };
      },
    });
    const page = await connector(f.fn).catalog.listListings(shop, { updatedSince: new Date(1_790_000_000_000) });
    expect(page).toMatchObject({ listings: [], nextCursor: null });
  });

  it("unlists and relists items, reporting Shopee's per-item failures", async () => {
    const f = fakeFetch({
      "POST /api/v2/product/unlist_item": (_u, init) => {
        expect(JSON.parse(String(init.body))).toEqual({
          item_list: [
            { item_id: 100, unlist: true },
            { item_id: 200, unlist: true },
          ],
        });
        return {
          error: "",
          response: {
            success_list: [{ item_id: 100, unlist: true }],
            failure_list: [{ item_id: 200, failed_reason: "Can't unlist item when item is under promotion" }],
          },
        };
      },
    });
    expect(await connector(f.fn).catalog.setListingStatus(shop, ["100", "200"], false)).toEqual([
      { externalItemId: "100", ok: true },
      { externalItemId: "200", ok: false, error: "Can't unlist item when item is under promotion" },
    ]);
  });

  it("turns banned, violation, and price pushes into listing changes", () => {
    for (const code of [6, 16, 22]) {
      const [e] = parseShopeePush(
        Buffer.from(
          `{"data":{"item_id":2500139861,"item_status":"BANNED"},"shop_id":727720655,"code":${code},"timestamp":1}`,
        ),
      );
      expect(e).toMatchObject({
        kind: "listing.changed",
        externalShopIds: ["727720655"],
        data: { externalItemId: "2500139861" },
      });
    }
  });
});

describe("Shopee stock (v2.product.update_stock)", () => {
  const shop = { externalShopId: "1", shopCipher: null, accessToken: "t" };
  type Body = { item_id: number; stock_list: { model_id: number; seller_stock: object[] }[] };

  it("sends one call per item with all its models, mirroring each model's location structure", async () => {
    const bodies: Body[] = [];
    const f = fakeFetch({
      "POST /api/v2/product/update_stock": (_url, init) => {
        const body = JSON.parse(String(init.body)) as Body;
        bodies.push(body);
        return {
          error: "",
          response: { success_list: body.stock_list.map((s) => ({ model_id: s.model_id })), failure_list: [] },
        };
      },
    });
    const results = await connector(f.fn).inventory.updateStock(shop, [
      { externalItemId: "100", externalVariantId: "11", warehouses: [{ externalWarehouseId: "IDZ", quantity: 5 }] },
      {
        externalItemId: "200",
        externalVariantId: "",
        warehouses: [{ externalWarehouseId: SHOPEE_DEFAULT_WAREHOUSE_ID, quantity: 0 }],
      },
      { externalItemId: "100", externalVariantId: "12", warehouses: [{ externalWarehouseId: "IDZ", quantity: 3 }] },
    ]);
    expect(bodies).toEqual([
      {
        item_id: 100,
        stock_list: [
          { model_id: 11, seller_stock: [{ location_id: "IDZ", stock: 5 }] },
          { model_id: 12, seller_stock: [{ location_id: "IDZ", stock: 3 }] },
        ],
      },
      // stock without a location stays without one: Shopee refuses a change of stock structure
      { item_id: 200, stock_list: [{ model_id: 0, seller_stock: [{ stock: 0 }] }] },
    ]);
    expect(results.map((r) => [r.externalItemId, r.externalVariantId, r.ok])).toEqual([
      ["100", "11", true],
      ["200", "", true],
      ["100", "12", true],
    ]);
  });

  it("reads failure_list next to a top-level error and keeps the models that succeeded", async () => {
    const f = fakeFetch({
      "POST /api/v2/product/update_stock": () => ({
        error: "error_busi_update_stock_failed",
        message: "Update stock failed, please check failure_list for detailed reason",
        response: {
          success_list: [{ model_id: 11, location_id: "IDZ", stock: 5 }],
          failure_list: [{ model_id: 12, failed_reason: "Can not update item with stock less than reserved stock" }],
        },
      }),
    });
    const results = await connector(f.fn).inventory.updateStock(shop, [
      { externalItemId: "100", externalVariantId: "11", warehouses: [{ externalWarehouseId: "IDZ", quantity: 5 }] },
      { externalItemId: "100", externalVariantId: "12", warehouses: [{ externalWarehouseId: "IDZ", quantity: 0 }] },
    ]);
    expect(results).toEqual([
      { externalItemId: "100", externalVariantId: "11", ok: true },
      {
        externalItemId: "100",
        externalVariantId: "12",
        ok: false,
        error: "Can not update item with stock less than reserved stock",
        retryable: false,
      },
    ]);
  });

  it("splits an item with more than 50 models into several calls", async () => {
    const sizes: number[] = [];
    const f = fakeFetch({
      "POST /api/v2/product/update_stock": (_url, init) => {
        sizes.push((JSON.parse(String(init.body)) as Body).stock_list.length);
        return { error: "", response: { success_list: [], failure_list: [] } };
      },
    });
    const updates = Array.from({ length: 60 }, (_, i) => ({
      externalItemId: "100",
      externalVariantId: String(i + 1),
      warehouses: [{ externalWarehouseId: "IDZ", quantity: i }],
    }));
    const results = await connector(f.fn).inventory.updateStock(shop, updates);
    expect(sizes).toEqual([50, 10]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("marks busy-marketplace failures retryable, refusals not, and throws authorization errors", async () => {
    const f = fakeFetch({
      "POST /api/v2/product/update_stock": (_url, init) => {
        const item = (JSON.parse(String(init.body)) as Body).item_id;
        if (item === 100)
          return new Response(
            JSON.stringify({ error: "error_server", message: "Something wrong. Please try later." }),
            {
              status: 500,
            },
          );
        if (item === 200) return { error: "error_item_not_found", message: "Item_id is not found." };
        return { error: "error_busi", message: "The merchant/shop has multi warehouse, please input location id" };
      },
    });
    const results = await connector(f.fn).inventory.updateStock(shop, [
      { externalItemId: "100", externalVariantId: "", warehouses: [{ externalWarehouseId: "IDZ", quantity: 1 }] },
      { externalItemId: "200", externalVariantId: "", warehouses: [{ externalWarehouseId: "IDZ", quantity: 1 }] },
      { externalItemId: "300", externalVariantId: "", warehouses: [{ externalWarehouseId: "default", quantity: 1 }] },
    ]);
    expect(results.map((r) => [r.ok, r.retryable])).toEqual([
      [false, true],
      [false, false],
      [false, false],
    ]);
    expect(results[1]!.error).toContain("Item_id is not found");

    const expired = fakeFetch({
      "POST /api/v2/product/update_stock": () => ({ error: "invalid_acceess_token", message: "Invalid access_token." }),
    });
    await expect(
      connector(expired.fn).inventory.updateStock(shop, [
        { externalItemId: "100", externalVariantId: "", warehouses: [{ externalWarehouseId: "IDZ", quantity: 1 }] },
      ]),
    ).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("keeps seller stock without a location under the shop-level warehouse when pulling", async () => {
    const f = fakeFetch({
      "GET /api/v2/product/get_item_base_info": () => ({
        error: "",
        response: {
          item_list: [
            {
              item_id: 200,
              item_name: "Topi",
              item_status: "NORMAL",
              has_model: false,
              price_info: [{ current_price: 45000 }],
              stock_info_v2: {
                summary_info: { total_available_stock: 6 },
                seller_stock: [{ stock: 4 }],
                shopee_stock: [{ location_id: "IDG", stock: 2 }],
              },
            },
          ],
        },
      }),
    });
    const page = await connector(f.fn).catalog.getListings(shop, ["200"]);
    expect(page.listings[0]!.stockByWarehouse).toEqual({
      [SHOPEE_DEFAULT_WAREHOUSE_ID]: 4,
      [SHOPEE_FBS_WAREHOUSE_ID]: 2,
    });
  });
});
