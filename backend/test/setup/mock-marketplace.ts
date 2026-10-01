import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake Shopee Open Platform and TikTok Shop Partner API for integration tests (backend doc 13.2).
 * It enforces what the real platforms document, so tests prove our side of the protocol:
 *
 * Shopee: HMAC-SHA256(partner_key, partner_id + path + timestamp [+ access_token + shop_id]) in `sign`,
 * a 5-minute timestamp window, single-use codes, refresh tokens usable once per shop, 4-hour tokens.
 * TikTok Shop: HMAC-SHA256(app_secret, secret + path + sorted params + body + secret), the token in
 * x-tts-access-token (never in the signature), shop_cipher for shop calls, rotating refresh tokens.
 */

export const SHOPEE = { partnerId: 1000016, partnerKey: "shopee-partner-key-for-tests" };
export const TIKTOK = {
  appKey: "tts-app-key",
  appSecret: "tts-app-secret-for-tests",
  serviceId: "7000000000000000001",
};

export interface MockShopeeShop {
  shopId: string;
  name: string;
  region: string;
  fulfillmentFlag?: string;
  /** "not_whitelisted" answers warehouse.error_not_in_whitelist, like a shop without multi-warehouse. */
  warehouses: "not_whitelisted" | { warehouse_id: number; warehouse_name: string; location_id: string }[];
  /** Authorization end, epoch seconds. */
  expireTime?: number;
}

export interface MockTiktokShop {
  id: string;
  name: string;
  region: string;
  cipher: string;
  warehouses: { id: string; name: string; type: "SALES_WAREHOUSE" | "RETURN_WAREHOUSE"; is_default: boolean }[];
  fbt?: { fbt_warehouse_id: string; name: string; subscribed: boolean }[];
}

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
  headers: IncomingMessage["headers"];
}

type Reply = { status: number; body: unknown };

const now = () => Math.floor(Date.now() / 1000);
const token = (prefix: string) => `${prefix}${randomBytes(12).toString("hex")}`;
const hmac = (key: string, msg: string) => createHmac("sha256", key).update(msg, "utf8").digest("hex");

export class MockMarketplace {
  url = "";
  readonly calls: Call[] = [];
  /** Every access and refresh token handed out, to prove none is stored in plain text. */
  readonly issued: string[] = [];
  private server: Server | undefined;
  private readonly queued = new Map<string, Reply[]>();

  // ---- Shopee state ----
  readonly shopeeShops = new Map<string, MockShopeeShop>();
  private readonly shopeeCodes = new Map<string, { shopIds: string[]; shopId?: string; mainAccountId?: string }>();
  private readonly shopeeAccess = new Map<string, { shopIds: string[]; expiresAt: number }>();
  /** refresh token -> shops that may still use it once */
  private readonly shopeeRefresh = new Map<string, Set<string>>();

  // ---- TikTok Shop state ----
  private readonly tiktokSellers = new Map<string, { openId: string; name: string; shops: MockTiktokShop[] }>();
  private readonly tiktokCodes = new Map<string, string>();
  private readonly tiktokAccess = new Map<string, { sellerId: string; expiresAt: number }>();
  private readonly tiktokRefresh = new Map<string, string>();
  /** shop cipher -> event_type -> address */
  readonly tiktokWebhooks = new Map<string, Map<string, string>>();

  /** Port 0 picks a free port (tests); a fixed port lets separately started processes find it. */
  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** The next call to `METHOD path` gets this answer instead of the normal one. */
  failNext(method: string, path: string, status: number, body: unknown): void {
    const key = `${method} ${path}`;
    this.queued.set(key, [...(this.queued.get(key) ?? []), { status, body }]);
  }

  callsTo(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  // ---- Shopee setup ----

  addShopeeShop(shop: MockShopeeShop): void {
    this.shopeeShops.set(shop.shopId, shop);
  }

  /** What Shopee appends to redirect_uri after the seller authorizes. */
  shopeeCode(input: { shopId: string } | { mainAccountId: string; shopIds: string[] }): string {
    const code = randomBytes(16).toString("hex");
    this.shopeeCodes.set(code, "shopId" in input ? { shopIds: [input.shopId], shopId: input.shopId } : { ...input });
    return code;
  }

  /** Makes every Shopee access token invalid, as after 4 hours. */
  expireShopeeAccessTokens(): void {
    for (const t of this.shopeeAccess.values()) t.expiresAt = now() - 1;
  }

  revokeShopeeRefreshTokens(): void {
    this.shopeeRefresh.clear();
  }

  signShopeePush(callbackUrl: string, body: string): string {
    return hmac(SHOPEE.partnerKey, `${callbackUrl}|${body}`);
  }

  // ---- TikTok Shop setup ----

  addTiktokSeller(input: { openId: string; name: string; shops: MockTiktokShop[] }): string {
    const id = `seller-${input.openId}`;
    this.tiktokSellers.set(id, input);
    return id;
  }

  tiktokCode(sellerId: string): string {
    const code = `TTP_${randomBytes(12).toString("hex")}`;
    this.tiktokCodes.set(code, sellerId);
    return code;
  }

  signTiktokWebhook(body: string): string {
    return hmac(TIKTOK.appSecret, `${TIKTOK.appKey}${body}`);
  }

  // ---- HTTP ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://mock");
    const call: Call = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: req.headers,
    };
    this.calls.push(call);
    const key = `${call.method} ${call.path}`;
    const forced = this.queued.get(key)?.shift();
    const reply = forced ?? this.route(call);
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  }

  private route(call: Call): Reply {
    if (call.path.startsWith("/api/v2/token/")) return this.tiktokToken(call);
    if (call.path.startsWith("/api/v2/")) return this.shopee(call);
    return this.tiktok(call);
  }

  // ---- Shopee endpoints ----

  private shopeeError(error: string, message: string, status = 403): Reply {
    return { status, body: { error, message, request_id: token("rq") } };
  }

  private shopee(call: Call): Reply {
    const q = call.query;
    const ts = Number(q.timestamp);
    if (Number(q.partner_id) !== SHOPEE.partnerId) return this.shopeeError("error_param", "Invalid partner_id.");
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > 300)
      return this.shopeeError("error_param", "Timestamp is expired.");
    const shopLevel = q.access_token !== undefined;
    const base = `${SHOPEE.partnerId}${call.path}${ts}${shopLevel ? `${q.access_token}${q.shop_id}` : ""}`;
    if (q.sign !== hmac(SHOPEE.partnerKey, base)) return this.shopeeError("error_sign", "Wrong sign.");

    if (call.path === "/api/v2/auth/token/get") return this.shopeeTokenGet(JSON.parse(call.body));
    if (call.path === "/api/v2/auth/access_token/get") return this.shopeeRefreshToken(JSON.parse(call.body));

    const shopId = q.shop_id ?? "";
    const access = this.shopeeAccess.get(q.access_token ?? "");
    if (!access?.shopIds.includes(shopId) || access.expiresAt <= now()) {
      return this.shopeeError("invalid_acceess_token", "Invalid access_token, please have a check.");
    }
    const shop = this.shopeeShops.get(shopId);
    if (!shop) return this.shopeeError("error_auth", "Invalid partner_id or shopid.");
    const ok = (extra: object) => ({
      status: 200,
      body: { error: "", message: "", request_id: token("rq"), ...extra },
    });

    switch (call.path) {
      case "/api/v2/shop/get_shop_info":
        return ok({
          shop_name: shop.name,
          region: shop.region,
          status: "NORMAL",
          is_cb: false,
          is_sip: false,
          merchant_id: null,
          shop_fulfillment_flag: shop.fulfillmentFlag ?? "Others",
          auth_time: now() - 10,
          expire_time: shop.expireTime ?? now() + 365 * 86400,
        });
      case "/api/v2/shop/get_profile":
        return ok({ response: { shop_logo: `https://cf.shopee.co.id/file/${shopId}`, shop_name: shop.name } });
      case "/api/v2/shop/get_warehouse_detail":
        if (shop.warehouses === "not_whitelisted") {
          return this.shopeeError(
            "warehouse.error_not_in_whitelist",
            "Your shop is not in multi-warehouse whitelist.",
            200,
          );
        }
        return ok({ response: shop.warehouses.map((w) => ({ ...w, warehouse_type: 1, region: shop.region })) });
      case "/api/v2/logistics/get_address_list":
        return ok({
          response: {
            show_pickup_address: true,
            address_list: [
              { address_id: 1, region: shop.region, city: "Jakarta Barat", address_type: ["PICK_UP_ADDRESS"] },
            ],
          },
        });
      default:
        return this.shopeeError(
          "error_param",
          "Permission denied. This API is currently offline or the request path is incorrect.",
          404,
        );
    }
  }

  private issueShopee(shopIds: string[]) {
    const access = token("a");
    const refresh = token("r");
    this.issued.push(access, refresh);
    this.shopeeAccess.set(access, { shopIds, expiresAt: now() + 4 * 3600 });
    this.shopeeRefresh.set(refresh, new Set(shopIds));
    return { access_token: access, refresh_token: refresh, expire_in: 14400 };
  }

  private shopeeTokenGet(body: {
    code?: string;
    partner_id?: number;
    shop_id?: number;
    main_account_id?: number;
  }): Reply {
    if (body.partner_id !== SHOPEE.partnerId) return this.shopeeError("error_param", "partner_id in body", 400);
    const grant = this.shopeeCodes.get(body.code ?? "");
    if (!grant)
      return this.shopeeError("invalid_code", "The code is expired or used or invalid, please check the code.", 400);
    const matches = body.shop_id
      ? grant.shopId === String(body.shop_id)
      : grant.mainAccountId === String(body.main_account_id);
    if (!matches)
      return this.shopeeError(
        "invalid_shop_id",
        "The code or shop_id is wrong, please check the code or the shop_id.",
        400,
      );
    this.shopeeCodes.delete(body.code!);
    const tokens = this.issueShopee(grant.shopIds);
    return {
      status: 200,
      body: {
        error: "",
        message: "",
        request_id: token("rq"),
        ...tokens,
        ...(grant.mainAccountId ? { shop_id_list: grant.shopIds.map(Number), merchant_id_list: [] } : {}),
      },
    };
  }

  private shopeeRefreshToken(body: { refresh_token?: string; partner_id?: number; shop_id?: number }): Reply {
    const shopId = String(body.shop_id);
    const allowed = this.shopeeRefresh.get(body.refresh_token ?? "");
    if (!allowed?.has(shopId)) {
      return this.shopeeError(
        "error_shop_refresh_token",
        "Your refresh token is error ,please check refresh token or shopid.",
        403,
      );
    }
    allowed.delete(shopId);
    return {
      status: 200,
      body: {
        error: "",
        message: "",
        request_id: token("rq"),
        partner_id: SHOPEE.partnerId,
        shop_id: body.shop_id,
        ...this.issueShopee([shopId]),
      },
    };
  }

  // ---- TikTok Shop endpoints ----

  private tiktokReply(code: number, message: string, data: unknown = {}, status = 200): Reply {
    return { status, body: { code, message, request_id: token("rq"), data } };
  }

  private issueTiktok(sellerId: string, user: { openId: string; name: string }) {
    const access = `TTP_${token("a")}`;
    const refresh = `TTP_${token("r")}`;
    const expiresAt = now() + 7 * 86400;
    this.issued.push(access, refresh);
    this.tiktokAccess.set(access, { sellerId, expiresAt });
    this.tiktokRefresh.set(refresh, sellerId);
    return {
      access_token: access,
      access_token_expire_in: expiresAt,
      refresh_token: refresh,
      refresh_token_expire_in: now() + 365 * 86400,
      open_id: user.openId,
      seller_name: user.name,
      seller_base_region: "ID",
      user_type: 0,
      granted_scopes: ["seller.authorization.info", "seller.logistics", "seller.fulfillment.basic"],
    };
  }

  private tiktokToken(call: Call): Reply {
    const q = call.query;
    if (q.app_key !== TIKTOK.appKey || q.app_secret !== TIKTOK.appSecret) {
      return this.tiktokReply(36009004, "Invalid credentials. Invalid app_key query parameter.");
    }
    if (call.path === "/api/v2/token/get") {
      if (q.grant_type !== "authorized_code") return this.tiktokReply(36004004, "Invalid grant_type");
      const sellerId = this.tiktokCodes.get(q.auth_code ?? "");
      if (!sellerId) return this.tiktokReply(36004004, "Invalid auth code.");
      this.tiktokCodes.delete(q.auth_code!);
      return this.tiktokReply(0, "success", this.issueTiktok(sellerId, this.tiktokSellers.get(sellerId)!));
    }
    if (q.grant_type !== "refresh_token") return this.tiktokReply(36004004, "Invalid grant_type");
    const sellerId = this.tiktokRefresh.get(q.refresh_token ?? "");
    if (!sellerId) return this.tiktokReply(36004004, "Invalid refresh token.");
    this.tiktokRefresh.delete(q.refresh_token!);
    return this.tiktokReply(0, "success", this.issueTiktok(sellerId, this.tiktokSellers.get(sellerId)!));
  }

  private tiktok(call: Call): Reply {
    const q = call.query;
    const ts = Number(q.timestamp);
    if (q.app_key !== TIKTOK.appKey)
      return this.tiktokReply(36009004, "Invalid credentials. Invalid app_key query parameter.", {}, 401);
    if (!Number.isFinite(ts) || ts < now() - 300 || ts > now() + 30) {
      return this.tiktokReply(36009004, "Invalid timestamp.", {}, 401);
    }
    if (q.access_token !== undefined)
      return this.tiktokReply(36009004, "access_token must be sent in x-tts-access-token", {}, 401);
    const params = Object.keys(q)
      .filter((k) => k !== "sign" && k !== "access_token")
      .sort()
      .map((k) => `${k}${q[k]}`)
      .join("");
    const expected = hmac(TIKTOK.appSecret, `${TIKTOK.appSecret}${call.path}${params}${call.body}${TIKTOK.appSecret}`);
    if (q.sign !== expected)
      return this.tiktokReply(106001, "Invalid credentials. The sign query parameter is invalid.", {}, 401);
    const auth = this.tiktokAccess.get(String(call.headers["x-tts-access-token"] ?? ""));
    if (!auth)
      return this.tiktokReply(36009004, "Invalid credentials. The x-tts-access-token header is invalid.", {}, 401);
    if (auth.expiresAt <= now()) return this.tiktokReply(105002, "Expired credentials.", {}, 401);
    const seller = this.tiktokSellers.get(auth.sellerId)!;

    if (call.path === "/authorization/202309/shops") {
      return this.tiktokReply(0, "Success", {
        shops: seller.shops.map((s) => ({
          id: s.id,
          name: s.name,
          region: s.region,
          seller_type: "LOCAL",
          cipher: s.cipher,
          code: `IDLC${s.id.slice(-4)}`,
        })),
      });
    }
    const shop = seller.shops.find((s) => s.cipher === q.shop_cipher);
    if (!shop) return this.tiktokReply(106013, "Missing identifier. The shop_cipher query parameter is required.");

    switch (`${call.method} ${call.path}`) {
      case "GET /logistics/202309/warehouses":
        return this.tiktokReply(0, "Success", {
          warehouses: shop.warehouses.map((w) => ({
            ...w,
            effect_status: "ENABLED",
            sub_type: "DOMESTIC_WAREHOUSE",
            address: {
              region: "Indonesia",
              region_code: "ID",
              city: "Jakarta",
              contact_person: "Rina",
              phone_number: "0812****",
            },
          })),
        });
      case "GET /fbt/202409/merchants/onboarded_regions":
        return this.tiktokReply(0, "Success", shop.fbt ? { onboarded_regions: [{ region_code: "ID" }] } : {});
      case "GET /fbt/202408/warehouses":
        return this.tiktokReply(0, "Success", {
          warehouses: (shop.fbt ?? []).map((w) => ({ ...w, warehouse_ids: [], addresses: [] })),
        });
      case "GET /event/202309/webhooks": {
        const hooks = this.tiktokWebhooks.get(shop.cipher) ?? new Map();
        return this.tiktokReply(0, "Success", {
          webhooks: [...hooks.entries()].map(([event_type, address]) => ({ event_type, address })),
          total_count: hooks.size,
        });
      }
      case "PUT /event/202309/webhooks": {
        const body = JSON.parse(call.body) as { address: string; event_type: string };
        const hooks = this.tiktokWebhooks.get(shop.cipher) ?? new Map<string, string>();
        hooks.set(body.event_type, body.address);
        this.tiktokWebhooks.set(shop.cipher, hooks);
        return this.tiktokReply(0, "Success");
      }
      default:
        return this.tiktokReply(36009009, "Invalid path.", {}, 404);
    }
  }
}
