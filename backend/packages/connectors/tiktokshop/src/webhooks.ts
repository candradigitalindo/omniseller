import {
  hmacSha256Hex,
  type NormalizedWebhookEvent,
  parseJsonSafe,
  sha256Hex,
  signatureEquals,
  type WebhookEventKind,
  type WebhookRequest,
} from "@omniseller/connector-core";

/**
 * TikTok Shop webhooks ("TikTok Shop webhooks, Overview").
 *
 * Verification: the `Authorization` header is lower-case hex HMAC-SHA256(app_secret, app_key +
 * raw_body), without a Bearer prefix. The raw body must be used exactly as received.
 *
 * Payload: { type, tts_notification_id, shop_id, timestamp, data }. The documentation warns against
 * branching on the numeric `type` alone; some samples carry the topic as `event_type` instead, so both
 * are read, with the topic name winning.
 */
export function verifyTiktokWebhook(appKey: string, appSecret: string, req: WebhookRequest): boolean {
  const expected = hmacSha256Hex(appSecret, `${appKey}${req.rawBody.toString("utf8")}`);
  return signatureEquals(expected, req.headers.authorization);
}

/** Topics OmniSeller subscribes each shop to (Update Shop Webhook, event_type). */
export const TIKTOK_WEBHOOK_TOPICS = [
  "SELLER_DEAUTHORIZATION",
  "UPCOMING_AUTHORIZATION_EXPIRATION",
  "ORDER_STATUS_CHANGE",
  "CANCELLATION_STATUS_CHANGE",
  "RETURN_STATUS_CHANGE",
  "PACKAGE_UPDATE",
  "RECIPIENT_ADDRESS_UPDATE",
  "PRODUCT_STATUS_CHANGE",
  "PRODUCT_AUDIT_STATUS_CHANGE",
] as const;

/** Numeric `type` values confirmed on the topic reference pages. */
const TYPE_TOPICS: Record<number, string> = {
  1: "ORDER_STATUS_CHANGE",
  5: "PRODUCT_STATUS_CHANGE",
  6: "SELLER_DEAUTHORIZATION",
  7: "UPCOMING_AUTHORIZATION_EXPIRATION",
  37: "PRODUCT_AUDIT_STATUS_CHANGE",
};

const TOPIC_KINDS: Record<string, WebhookEventKind> = {
  SELLER_DEAUTHORIZATION: "authorization.revoked",
  UPCOMING_AUTHORIZATION_EXPIRATION: "authorization.expiring",
  ORDER_STATUS_CHANGE: "order.status_changed",
  PRODUCT_STATUS_CHANGE: "listing.changed",
  PRODUCT_AUDIT_STATUS_CHANGE: "listing.changed",
};

interface TiktokWebhookBody {
  type?: unknown;
  event_type?: unknown;
  tts_notification_id?: unknown;
  shop_id?: unknown;
  timestamp?: unknown;
  data?: Record<string, unknown>;
}

export function parseTiktokWebhook(rawBody: Buffer): NormalizedWebhookEvent[] {
  let body: TiktokWebhookBody;
  try {
    // product_id arrives as a 19-digit JSON number; parseJsonSafe keeps it exact.
    body = parseJsonSafe(rawBody.toString("utf8")) as TiktokWebhookBody;
  } catch {
    return [];
  }
  const type = Number(body.type);
  const topic =
    typeof body.event_type === "string" && body.event_type
      ? body.event_type
      : (TYPE_TOPICS[type] ?? (Number.isFinite(type) ? `type_${type}` : "unknown"));
  const kind = TOPIC_KINDS[topic] ?? "other";
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
  const ts = Number(body.timestamp);
  const shopId =
    body.shop_id === undefined || body.shop_id === null || body.shop_id === "" ? null : String(body.shop_id);
  const notificationId =
    typeof body.tts_notification_id === "string" || typeof body.tts_notification_id === "number"
      ? String(body.tts_notification_id)
      : null;

  const event: NormalizedWebhookEvent = {
    eventId: notificationId ?? sha256Hex(rawBody),
    kind,
    code: topic,
    externalShopIds: shopId ? [shopId] : [],
    occurredAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
    data: {},
  };
  if (kind === "authorization.expiring") {
    const at = Number(data.expiration_time);
    if (Number.isFinite(at) && at > 0) event.data.expiresAt = new Date(at * 1000);
  }
  if (kind === "authorization.revoked" && typeof data.message === "string") event.data.reason = data.message;
  if (kind === "listing.changed") {
    if (data.product_id !== undefined && data.product_id !== null) event.data.externalItemId = String(data.product_id);
    if (typeof data.status === "string") event.data.status = data.status;
  }
  if (kind === "order.status_changed") {
    if (data.order_id !== undefined) event.data.externalOrderId = String(data.order_id);
    if (typeof data.order_status === "string") event.data.status = data.order_status;
  }
  return [event];
}
