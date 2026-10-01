import {
  AuthExpiredError,
  AuthRevokedError,
  PermanentConnectorError,
  TransientConnectorError,
} from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
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
