import { hmacSha256Hex } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { parseTiktokWebhook, verifyTiktokWebhook } from "./webhooks.js";

describe("Creator deauthorization (official webhook type 20)", () => {
  const payload = {
    type: 20,
    tts_notification_id: "7327112393057371910",
    creator_open_id: "VIyStQAAAADCBQ40s4TzOSSOEIW-bM5O9cod3vK8OytW8m-bnBYlXw",
    timestamp: 1644412999,
    data: { cancel_time: "1644412885" },
  };
  it("routes the creator identity and uses cancellation time rather than delivery time", () => {
    const [event] = parseTiktokWebhook(Buffer.from(JSON.stringify({ ...payload, shop_id: "unrelated-shop" })));
    expect(event).toMatchObject({
      kind: "account.authorization_revoked",
      code: "CREATOR_DEAUTHORIZATION",
      eventId: payload.tts_notification_id,
      externalShopIds: [],
      externalAccount: { kind: "creator", id: payload.creator_open_id },
      occurredAt: new Date(1644412885 * 1000),
    });
    expect(
      parseTiktokWebhook(Buffer.from(JSON.stringify({ ...payload, event_type: "CREATOR_DEAUTHORIZATION" }))),
    ).toHaveLength(1);
  });
  it("verifies the exact body with this application's key and secret", () => {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const headers = { authorization: hmacSha256Hex("secret", `app${rawBody.toString("utf8")}`) };
    const request = { rawBody, headers, url: "https://hooks.example/webhooks/tiktokshop" };
    expect(verifyTiktokWebhook("app", "secret", request)).toBe(true);
    expect(verifyTiktokWebhook("other-app", "secret", request)).toBe(false);
    expect(verifyTiktokWebhook("app", "other-secret", request)).toBe(false);
    expect(verifyTiktokWebhook("app", "secret", { ...request, rawBody: Buffer.from(`${rawBody} `) })).toBe(false);
  });
  it.each([
    { creator_open_id: null },
    { creator_open_id: "" },
    { creator_open_id: "   " },
    { creator_open_id: 123 },
    { data: {} },
    { data: { cancel_time: "bad" } },
    { data: { cancel_time: -1 } },
    { data: { cancel_time: 1.5 } },
    { data: { cancel_time: Number.MAX_SAFE_INTEGER } },
  ])("ignores incomplete identity or cancellation time: %j", (patch) => {
    expect(parseTiktokWebhook(Buffer.from(JSON.stringify({ ...payload, ...patch })))).toEqual([]);
  });
  it.each(["null", "[]", "not json"])("ignores malformed envelope %s", (raw) => {
    expect(parseTiktokWebhook(Buffer.from(raw))).toEqual([]);
  });
});
