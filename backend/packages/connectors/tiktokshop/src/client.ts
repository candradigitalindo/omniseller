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
 * TikTok Shop Partner API transport (partner.tiktokshop.com, "Sign your API request", "Common
 * parameters", "Common errors"). For API version 202309 and later:
 *
 * - query: app_key, timestamp (10-digit seconds, within [now - 5 min, now + 30 s]), sign, and
 *   shop_cipher for shop-scoped endpoints
 * - header: x-tts-access-token (not part of the signature), content-type: application/json
 * - sign = hex(HMAC-SHA256(app_secret, app_secret + path + sorted(key + value) + body + app_secret)),
 *   over all query parameters except sign and access_token, with the exact body bytes sent
 */
export interface TiktokShopConfig {
  /** Needed to call the API and verify webhooks, like the secret. */
  appKey?: string;
  /** Needed to call the API and verify webhooks; the api process only builds links and never has it. */
  appSecret?: string;
  /** Service id of the app (Partner Center, App & Service), used in the seller authorization link. */
  serviceId?: string;
  /** https://open-api.tiktokglobalshop.com */
  apiBaseUrl: string;
  /** https://auth.tiktok-shops.com */
  authBaseUrl: string;
  /** https://services.tiktokshop.com/open/authorize (the US market uses services.us.tiktokshop.com) */
  authorizeUrl: string;
  creatorAuthorizeUrl?: string;
  partnerAuthorizeUrl?: string;
  http?: HttpConfig;
}

export function tiktokSignString(input: { path: string; query: Record<string, string>; body?: string }): string {
  const keys = Object.keys(input.query)
    .filter((k) => k !== "sign" && k !== "access_token")
    .sort();
  const params = keys.map((k) => `${k}${input.query[k]}`).join("");
  return `${input.path}${params}${input.body ?? ""}`;
}

export function tiktokSign(appSecret: string, signString: string): string {
  return hmacSha256Hex(appSecret, `${appSecret}${signString}${appSecret}`);
}

export interface TiktokEnvelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

/**
 * Error code classification. `36009004` is reused for several request-validation failures, so its
 * message decides (documented keyword index): an invalid access token header is an expired or revoked
 * token, everything else is a request bug. The token is named both ways ("access_token must be sent",
 * "The x-tts-access-token header is invalid"), so `_` and `-` count alike.
 */
export function classifyTiktokError(code: number, message: string, httpStatus: number): ConnectorErrorKind {
  const m = message.toLowerCase().replace(/[-_]/g, " ");
  if (code === 105002) return "auth_expired";
  if (code === 36009004 && m.includes("access token")) return "auth_expired";
  if (code === 36009002 || httpStatus === 429) return "transient";
  if (code === 36009003 || code === 36009007) return "transient";
  if (httpStatus >= 500) return "transient";
  return "permanent";
}

export class TiktokShopClient {
  constructor(readonly config: TiktokShopConfig) {}

  get appKey(): string {
    if (!this.config.appKey) {
      throw new PermanentConnectorError({ code: "not_configured", message: "TIKTOKSHOP_APP_KEY is not set" });
    }
    return this.config.appKey;
  }

  get appSecret(): string {
    if (!this.config.appSecret) {
      throw new PermanentConnectorError({ code: "not_configured", message: "TIKTOKSHOP_APP_SECRET is not set" });
    }
    return this.config.appSecret;
  }

  /** Signed Open API call. `shopCipher` is included for shop-scoped endpoints. */
  async call<T>(input: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    accessToken: string;
    shopCipher?: string | null;
    query?: Record<string, string>;
    body?: object;
  }): Promise<T> {
    const query: Record<string, string> = {
      app_key: this.appKey,
      timestamp: String(unixSeconds()),
      ...(input.shopCipher ? { shop_cipher: input.shopCipher } : {}),
      ...input.query,
    };
    // Serialize once: the signature covers these exact bytes.
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const sign = tiktokSign(this.appSecret, tiktokSignString({ path: input.path, query, ...(body ? { body } : {}) }));
    const url = new URL(input.path, this.config.apiBaseUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set("sign", sign);
    const res = await requestJson(
      this.config.http ?? {},
      {
        method: input.method,
        url,
        headers: { "content-type": "application/json", "x-tts-access-token": input.accessToken },
        ...(body === undefined ? {} : { body, logBody: input.body }),
      },
      (json) => (json as TiktokEnvelope<unknown> | null)?.request_id,
    );
    return this.unwrap<T>(res.json as TiktokEnvelope<T>, res.status, res.headers);
  }

  /**
   * Signed multipart upload (Upload Product Image). The body is not part of the signature for
   * multipart/form-data requests ("Sign your API request"); fetch sets the content type with its boundary.
   */
  async upload<T>(input: {
    path: string;
    accessToken: string;
    shopCipher?: string | null;
    form: { body: FormData; logBody: Record<string, unknown> };
  }): Promise<T> {
    const query: Record<string, string> = {
      app_key: this.appKey,
      timestamp: String(unixSeconds()),
      ...(input.shopCipher ? { shop_cipher: input.shopCipher } : {}),
    };
    const sign = tiktokSign(this.appSecret, tiktokSignString({ path: input.path, query }));
    const url = new URL(input.path, this.config.apiBaseUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set("sign", sign);
    const res = await requestJson(
      this.config.http ?? {},
      {
        method: "POST",
        url,
        headers: { "x-tts-access-token": input.accessToken },
        body: input.form.body,
        logBody: input.form.logBody,
      },
      (json) => (json as TiktokEnvelope<unknown> | null)?.request_id,
    );
    return this.unwrap<T>(res.json as TiktokEnvelope<T>, res.status, res.headers);
  }

  /** Token endpoints on auth.tiktok-shops.com: GET with app_secret in the query, no signature. */
  async token<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(path, this.config.authBaseUrl);
    url.searchParams.set("app_key", this.appKey);
    url.searchParams.set("app_secret", this.appSecret);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await requestJson(
      this.config.http ?? {},
      { method: "GET", url },
      (json) => (json as TiktokEnvelope<unknown> | null)?.request_id,
    );
    return this.unwrap<T>(res.json as TiktokEnvelope<T>, res.status, res.headers, "token");
  }

  private unwrap<T>(env: TiktokEnvelope<T>, httpStatus: number, headers: Headers, kind: "api" | "token" = "api"): T {
    const code = Number(env?.code ?? (httpStatus >= 400 ? httpStatus : 0));
    if (code === 0 && httpStatus < 400) return (env.data ?? {}) as T;
    const message = env?.message || `HTTP ${httpStatus}`;
    let errKind = classifyTiktokError(code, message, httpStatus);
    // A failed token call with a well-formed request means the code or refresh token is no longer good.
    if (kind === "token" && errKind === "permanent" && code !== 36009004) errKind = "auth_revoked";
    throw errorOfKind(errKind, {
      code: String(code),
      message,
      httpStatus,
      ...(env?.request_id ? { requestId: env.request_id } : {}),
      ...(errKind === "transient" ? retryAfter(headers) : {}),
    });
  }
}
