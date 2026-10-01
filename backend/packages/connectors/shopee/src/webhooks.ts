import {
  hmacSha256Hex,
  type NormalizedWebhookEvent,
  sha256Hex,
  signatureEquals,
  type WebhookEventKind,
  type WebhookRequest,
} from "@omniseller/connector-core";

/**
 * Shopee Push Mechanism (developer guide "Push Mechanism notifications").
 *
 * Verification: the `Authorization` header is HMAC-SHA256(partner_key, callback_url + "|" + raw_body)
 * in hex, where callback_url is exactly the URL configured in the console. The body must be the raw
 * bytes; re-serialized JSON does not match.
 *
 * The listener must answer 2xx with an empty body within 3 seconds; Shopee retries after 5, 30, and
 * 180 minutes and disables the subscription when the success rate stays below 30%.
 */
export function verifyShopeePush(partnerKey: string, req: WebhookRequest): boolean {
  const expected = hmacSha256Hex(partnerKey, `${req.url}|${req.rawBody.toString("utf8")}`);
  return signatureEquals(expected, req.headers.authorization);
}

/** Push codes this connector understands; everything else is kept as `other` for later consumers. */
export const SHOPEE_PUSH_CODES = {
  SHOP_AUTHORIZATION: 1,
  SHOP_AUTHORIZATION_CANCELED: 2,
  ORDER_STATUS: 3,
  ORDER_TRACKING_NO: 4,
  SHOPEE_UPDATES: 5,
  OPEN_API_AUTHORIZATION_EXPIRY: 12,
} as const;

const KINDS: Record<number, WebhookEventKind> = {
  1: "authorization.granted",
  2: "authorization.revoked",
  3: "order.status_changed",
  4: "order.tracking_updated",
  12: "authorization.expiring",
};

interface ShopeePushBody {
  code?: unknown;
  shop_id?: unknown;
  timestamp?: unknown;
  data?: Record<string, unknown>;
}

function ids(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined && v !== "").map(String);
  if (value === null || value === undefined || value === "" || value === 0) return [];
  return [String(value)];
}

/**
 * One normalized event per push. Shops come from the top-level `shop_id` (order pushes) or from the
 * data (`shop_id`, `shopid` in expiry cancellations, `shop_id_list` for main accounts,
 * `shop_expire_soon` for code 12). Shopee pushes have no id, so the event id is a hash of the body:
 * Shopee's retries resend the same body and collapse onto the same inbox row.
 */
export function parseShopeePush(rawBody: Buffer): NormalizedWebhookEvent[] {
  let body: ShopeePushBody;
  try {
    body = JSON.parse(rawBody.toString("utf8")) as ShopeePushBody;
  } catch {
    return [];
  }
  const code = Number(body.code);
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
  const kind = KINDS[code] ?? "other";
  const shops = new Set<string>([
    ...ids(body.shop_id),
    ...ids(data.shop_id),
    ...ids(data.shopid),
    ...ids(data.shop_id_list),
    ...(code === SHOPEE_PUSH_CODES.OPEN_API_AUTHORIZATION_EXPIRY ? ids(data.shop_expire_soon) : []),
  ]);
  // The documented "canceled by seller" push names the shop only in its text:
  // "extra": "shop id 22000000 (VN) has been cancelled its authorization".
  if (shops.size === 0 && typeof data.extra === "string") {
    const m = /shop\s*id[:\s]+(\d+)/i.exec(data.extra);
    if (m?.[1]) shops.add(m[1]);
  }
  const ts = Number(body.timestamp);
  const event: NormalizedWebhookEvent = {
    eventId: sha256Hex(rawBody),
    kind,
    code: Number.isFinite(code) ? String(code) : "unknown",
    externalShopIds: [...shops],
    occurredAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
    data: {},
  };
  if (kind === "authorization.expiring") {
    const before = Number(data.expire_before);
    if (Number.isFinite(before) && before > 0) event.data.expiresAt = new Date(before * 1000);
  }
  if (kind === "authorization.revoked" && typeof data.authorize_type === "string") {
    event.data.reason = data.authorize_type;
  }
  if (kind === "order.status_changed" || kind === "order.tracking_updated") {
    if (typeof data.ordersn === "string") event.data.externalOrderId = data.ordersn;
    if (typeof data.status === "string") event.data.status = data.status;
  }
  return [event];
}
