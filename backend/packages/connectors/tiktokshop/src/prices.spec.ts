import { describe, expect, it } from "vitest";
import { detailToListings } from "./catalog.js";
import { createTiktokShopConnector } from "./connector.js";

const shop = { externalShopId: "123", accessToken: "test-token", shopCipher: "cipher" };
function harness(code = 0) {
  const calls: { url: URL; body: Record<string, unknown> }[] = [];
  const connector = createTiktokShopConnector({
    appKey: "key",
    appSecret: "secret",
    apiBaseUrl: "https://open-api.tiktokglobalshop.com",
    authBaseUrl: "https://auth.tiktok-shops.com",
    authorizeUrl: "https://services.tiktokshop.com/open/authorize",
    http: {
      fetch: (async (input, init) => {
        calls.push({ url: new URL(String(input)), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ code, message: "test result", data: {} }));
      }) as typeof fetch,
    },
  });
  return { update: connector.catalog.updatePrices!, calls };
}
describe("Tokopedia & Shop regular prices", () => {
  it("groups SKUs by product, uses exact string IDs, signs POST and sends IDR", async () => {
    const h = harness();
    const changes = ["9007199254740993", "9007199254740994"].map((id) => ({
      externalItemId: "9007199254740992",
      externalVariantId: id,
      price: 65000,
    }));
    expect(await h.update(shop, changes)).toEqual(changes.map((r) => ({ ...r, ok: true })));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url.pathname).toBe("/product/202309/products/9007199254740992/prices/update");
    expect(h.calls[0]!.url.searchParams.get("shop_cipher")).toBe("cipher");
    expect(h.calls[0]!.url.searchParams.has("sign")).toBe(true);
    expect(h.calls[0]!.body.skus).toEqual(
      changes.map((r) => ({ id: r.externalVariantId, price: { amount: "65000", currency: "IDR" } })),
    );
  });
  it("uses the final display price for cross-border sellers, and reads it back separately from pre-tax", async () => {
    const h = harness();
    await h.update(shop, [{ externalItemId: "1", externalVariantId: "2", price: 65000 }], { crossBorder: true });
    expect(h.calls[0]!.body.skus).toEqual([{ id: "2", price: { sale_price: "65000", currency: "IDR" } }]);
    expect(
      detailToListings({
        id: "1",
        skus: [{ id: "2", price: { sale_price: "65000", tax_exclusive_price: "60000" } }],
      })[0],
    ).toMatchObject({ originalPrice: 65000 });
  });
  it("keeps promotion refusals permanent, propagating expired tokens and throttling", async () => {
    const change = { externalItemId: "1", externalVariantId: "2", price: 5000 };
    expect(await harness(12052038).update(shop, [change])).toMatchObject([{ ok: false, errorCode: "12052038" }]);
    await expect(harness(105002).update(shop, [change])).rejects.toMatchObject({ kind: "auth_expired" });
    await expect(harness(36009002).update(shop, [change])).rejects.toMatchObject({ kind: "transient" });
  });
  it("rejects duplicate SKUs and fractions before any network call", async () => {
    const h = harness();
    const change = { externalItemId: "1", externalVariantId: "2", price: 5000 };
    await expect(h.update(shop, [change, change])).rejects.toMatchObject({ code: "invalid_request" });
    await expect(h.update(shop, [{ ...change, price: 1.5 }])).rejects.toMatchObject({ code: "invalid_request" });
    expect(h.calls).toHaveLength(0);
  });
});
