import {
  type ConnectorErrorKind,
  errorOfKind,
  type HttpConfig,
  hmacSha256Hex,
  PermanentConnectorError,
  requestJson,
  retryAfter,
  unixSeconds,
} from "@omniseller/connector-core";

/**
 * Shopee Open Platform v2 transport (open.shopee.com, developer guides "API calls" and "Authorization
 * and Authentication"). Common parameters go in the query; POST bodies are JSON. The signature is
 * HMAC-SHA256 with the partner key, lower-case hex, over the concatenation of:
 *
 *   Public API:   partner_id + api path + timestamp
 *   Shop API:     partner_id + api path + timestamp + access_token + shop_id
 *   Merchant API: partner_id + api path + timestamp + access_token + merchant_id
 *
 * The timestamp is valid for 5 minutes.
 */
export interface ShopeeConfig {
  partnerId: number;
  /** Needed to call the API and verify pushes; the api process only builds links and never has it. */
  partnerKey?: string;
  /** https://partner.shopeemobile.com (sandbox: https://openplatform.sandbox.test-stable.shopee.sg) */
  apiBaseUrl: string;
  /** https://open.shopee.com (sandbox: https://open.sandbox.test-stable.shopee.com) */
  authBaseUrl: string;
  http?: HttpConfig;
}

export function shopeeBaseString(parts: {
  partnerId: number;
  path: string;
  timestamp: number;
  accessToken?: string;
  shopId?: string;
}): string {
  const tail = parts.accessToken !== undefined ? `${parts.accessToken}${parts.shopId ?? ""}` : "";
  return `${parts.partnerId}${parts.path}${parts.timestamp}${tail}`;
}

export function shopeeSign(partnerKey: string, baseString: string): string {
  return hmacSha256Hex(partnerKey, baseString);
}

/** Envelope fields Shopee returns on every call. */
export interface ShopeeEnvelope {
  error?: string;
  message?: string;
  request_id?: string;
  warning?: string;
}

const AUTH_EXPIRED = new Set(["invalid_access_token", "invalid_acceess_token"]);
const AUTH_REVOKED = new Set([
  "partner_shop_no_link",
  "shop_no_linked",
  "shop_access_expired",
  "refresh_token_expired",
  "error_shop_refresh_token",
  "merchant_access_expired",
  "merchant_no_linked",
  "error_merchant_refresh_token",
  "shop_banned",
]);
const TRANSIENT = new Set([
  "error_server",
  "error_network",
  "error_inner",
  "error_rate_limit",
  "error_limit",
  "error_busi",
]);

/**
 * Maps a Shopee `error` value (and its message) to a connector error kind. Shopee reuses `error_auth`
 * for unrelated failures, so the message decides between an expired token, an unlinked shop, and a
 * system error.
 */
export function classifyShopeeError(error: string, message: string, httpStatus: number): ConnectorErrorKind {
  const m = message.toLowerCase();
  if (AUTH_EXPIRED.has(error)) return "auth_expired";
  if (AUTH_REVOKED.has(error)) return "auth_revoked";
  if (error === "error_auth") {
    if (m.includes("access_token")) return "auth_expired";
    if (m.includes("shopid") || m.includes("shop_id") || m.includes("no linked")) return "auth_revoked";
    if (m.includes("system error")) return "transient";
    return "permanent";
  }
  if (TRANSIENT.has(error)) return "transient";
  if (httpStatus >= 500 || httpStatus === 429) return "transient";
  return "permanent";
}

/** Milliseconds until 00:00 UTC+8, when Shopee resets the daily call limit (`error_limit`). */
function untilShopeeMidnight(now = Date.now()): number {
  const sgt = now + 8 * 3600_000;
  const next = Math.floor(sgt / 86_400_000 + 1) * 86_400_000;
  return next - sgt;
}

export class ShopeeClient {
  constructor(readonly config: ShopeeConfig) {}

  get partnerKey(): string {
    if (!this.config.partnerKey) {
      throw new PermanentConnectorError({ code: "not_configured", message: "SHOPEE_PARTNER_KEY is not set" });
    }
    return this.config.partnerKey;
  }

  /** Public API: tokens, push configuration, partner-level lists. */
  publicCall<T>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string | readonly string[]>; body?: object } = {},
  ) {
    return this.call<T>(method, path, opts);
  }

  /** Shop API: anything about one shop, with its access token. */
  shopCall<T>(
    shop: { externalShopId: string; accessToken: string },
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string | readonly string[]>; body?: object } = {},
  ) {
    return this.call<T>(method, path, { ...opts, shop });
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    opts: {
      query?: Record<string, string | readonly string[]>;
      body?: object;
      shop?: { externalShopId: string; accessToken: string };
    },
  ): Promise<T & ShopeeEnvelope> {
    const timestamp = unixSeconds();
    const sign = shopeeSign(
      this.partnerKey,
      shopeeBaseString({
        partnerId: this.config.partnerId,
        path,
        timestamp,
        ...(opts.shop ? { accessToken: opts.shop.accessToken, shopId: opts.shop.externalShopId } : {}),
      }),
    );
    const url = new URL(path, this.config.apiBaseUrl);
    url.searchParams.set("partner_id", String(this.config.partnerId));
    url.searchParams.set("timestamp", String(timestamp));
    if (opts.shop) {
      url.searchParams.set("access_token", opts.shop.accessToken);
      url.searchParams.set("shop_id", opts.shop.externalShopId);
    }
    url.searchParams.set("sign", sign);
    // Array parameters repeat the key (item_status=NORMAL&item_status=BANNED), as Shopee documents.
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (typeof v === "string") url.searchParams.set(k, v);
      else for (const item of v) url.searchParams.append(k, item);
    }

    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const res = await requestJson(
      this.config.http ?? {},
      {
        method,
        url,
        ...(body === undefined ? {} : { body, logBody: opts.body, headers: { "content-type": "application/json" } }),
      },
      (json) => (json as ShopeeEnvelope | null)?.request_id,
    );
    const env = (res.json ?? {}) as T & ShopeeEnvelope;
    const error = typeof env.error === "string" ? env.error.trim() : "";
    // Some samples fill `error` and `message` with "-" on success.
    const failed = (error !== "" && error !== "-") || res.status >= 400;
    if (!failed) return env;

    const code = error && error !== "-" ? error : `http_${res.status}`;
    const message = typeof env.message === "string" && env.message ? env.message : `HTTP ${res.status}`;
    const kind = classifyShopeeError(code, message, res.status);
    const retry =
      code === "error_limit"
        ? { retryAfterMs: untilShopeeMidnight() }
        : code === "error_rate_limit"
          ? { retryAfterMs: retryAfter(res.headers).retryAfterMs ?? 60_000 }
          : retryAfter(res.headers);
    throw errorOfKind(kind, {
      code,
      message,
      httpStatus: res.status,
      ...(env.request_id ? { requestId: env.request_id } : {}),
      ...retry,
    });
  }
}

/**
 * `expire_in` is documented as seconds (14400), but one reference sample shows an epoch timestamp.
 * Values that can only be a timestamp are read as one.
 */
export function accessExpiry(expireIn: unknown, now = new Date()): Date {
  const n = Number(expireIn);
  if (!Number.isFinite(n) || n <= 0) {
    throw new PermanentConnectorError({ code: "bad_response", message: "missing expire_in" });
  }
  return n > 1_000_000_000 ? new Date(n * 1000) : new Date(now.getTime() + n * 1000);
}
