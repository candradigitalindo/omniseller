import { parseJsonSafe } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { createShopeeConnector } from "./connector.js";

const shop = { externalShopId: "123", accessToken: "test-token", shopCipher: null };
function harness(reply: (body: Record<string, unknown>) => unknown) {
  const calls: { url: URL; body: Record<string, unknown> }[] = [];
  const connector = createShopeeConnector({
    partnerId: 123,
    partnerKey: "test-key",
    apiBaseUrl: "https://partner.shopeemobile.com",
    authBaseUrl: "https://open.shopee.com",
    http: {
      fetch: (async (input, init) => {
        const body = parseJsonSafe(String(init?.body)) as Record<string, unknown>;
        calls.push({ url: new URL(String(input)), body });
        return new Response(JSON.stringify(reply(body)), { status: 200 });
      }) as typeof fetch,
    },
  });
  return { update: connector.catalog.updatePrices!, calls };
}
describe("Shopee regular prices", () => {
  it("preserves int64 IDs, batches 50 models and accepts only explicit per-model success", async () => {
    const h = harness((body) => {
      const rows = body.price_list as { model_id: number; original_price: number }[];
      return {
        response: {
          success_list: rows.slice(0, -1),
          failure_list: [{ model_id: rows.at(-1)!.model_id, failed_reason: "price locked" }],
        },
      };
    });
    const updates = Array.from({ length: 51 }, (_, i) => ({
      externalItemId: "9007199254740993",
      externalVariantId: String(i + 1),
      price: 65000,
    }));
    const result = await h.update(shop, updates);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.body.item_id).toBe("9007199254740993");
    expect(h.calls[0]!.url.pathname).toBe("/api/v2/product/update_price");
    expect(h.calls[0]!.url.searchParams.has("sign")).toBe(true);
    expect(h.calls[0]!.body.price_list as unknown[]).toHaveLength(50);
    expect(result.filter((r) => r.ok)).toHaveLength(49);
    expect(result[49]).toMatchObject({ ok: false, errorCode: "price_rejected" });
  });
  it("refuses an empty success envelope and supports items without models", async () => {
    const h = harness((body) => ({ response: { success_list: body.price_list } }));
    const update = { externalItemId: "4", externalVariantId: "", price: 5000 };
    expect(await h.update(shop, [update])).toEqual([{ ...update, ok: true }]);
    expect(h.calls[0]!.body.price_list).toEqual([{ model_id: 0, original_price: 5000 }]);
    const broken = harness(() => ({}));
    expect(await broken.update(shop, [update])).toEqual([{ ...update, ok: false, errorCode: "bad_response" }]);
  });
  it.each([0, -1, 1.25, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid price %s before a call",
    async (price) => {
      const h = harness(() => ({}));
      await expect(h.update(shop, [{ externalItemId: "1", externalVariantId: "", price }])).rejects.toMatchObject({
        code: "invalid_request",
      });
      expect(h.calls).toHaveLength(0);
    },
  );
  it("propagates token expiry and rate limits, but returns business refusals", async () => {
    const update = { externalItemId: "1", externalVariantId: "2", price: 5000 };
    const h = harness(() => ({ error: "error_in_item_promotion_item_price_lock", message: "price locked" }));
    expect(await h.update(shop, [update])).toMatchObject([
      { ok: false, errorCode: "error_in_item_promotion_item_price_lock" },
    ]);
    for (const [error, kind] of [
      ["invalid_access_token", "auth_expired"],
      ["error_rate_limit", "transient"],
    ]) {
      const failure = harness(() => ({ error, message: "failure" }));
      await expect(failure.update(shop, [update])).rejects.toMatchObject({ kind });
    }
  });
});
