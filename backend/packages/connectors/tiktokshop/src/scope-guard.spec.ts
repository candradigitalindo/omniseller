import { withGrantedScopes } from "@omniseller/connector-core";
import { describe, expect, it, vi } from "vitest";
import { TiktokShopClient } from "./client.js";
import { TIKTOK_RUNTIME_SCOPE_CONTRACTS } from "./runtime-scope-contracts.js";
import { tiktokRuntimeScopeContract } from "./scope-guard.js";

function harness() {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify({ code: 0, data: { ok: true } })),
  );
  const client = new TiktokShopClient({
    appKey: "app",
    appSecret: "secret",
    serviceId: "service",
    apiBaseUrl: "https://example.test",
    authBaseUrl: "https://auth.example.test",
    authorizeUrl: "https://example.test/authorize",
    http: { fetch },
  });
  return { fetch, client };
}
const product = "/product/202309/products/576486316948490012";
describe("TikTok per-request documented grant scope checks", () => {
  it("covers all390versions and preserves method/version/dynamic identifiers", () => {
    expect(TIKTOK_RUNTIME_SCOPE_CONTRACTS).toHaveLength(390);
    expect(tiktokRuntimeScopeContract("GET", product)?.path).toBe("/product/202309/products/{product_id}");
    expect(tiktokRuntimeScopeContract("PUT", product)?.scopes.map((s) => s.name)).toEqual(["seller.product.write"]);
    expect(tiktokRuntimeScopeContract("GET", "/order/202309/orders")?.path).toBe("/order/202309/orders");
    expect(tiktokRuntimeScopeContract("GET", "/order/202507/orders")?.path).toBe("/order/202507/orders");
    expect(tiktokRuntimeScopeContract("GET", "/order/190001/orders")).toBeUndefined();
  });
  it("refuses denied read/write and unknown contracts before transport", async () => {
    const h = harness();
    await withGrantedScopes({ principalKind: "seller", scopes: ["seller.product.basic"] }, async () => {
      await h.client.call({ method: "GET", path: product, accessToken: "token" });
      await expect(
        h.client.call({ method: "PUT", path: product, accessToken: "token", body: {} }),
      ).rejects.toMatchObject({ code: "missing_scope" });
      await expect(
        h.client.call({ method: "GET", path: "/unknown/202309/path", accessToken: "token" }),
      ).rejects.toMatchObject({ code: "scope_contract_unverified" });
      await expect(
        h.client.call({
          method: "POST",
          path: "/product/202609/products/package/predict",
          accessToken: "token",
          body: {},
        }),
      ).rejects.toMatchObject({ code: "scope_contract_unverified" });
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it("filters scope package principal types before checking an applicable documented package", async () => {
    const h = harness();
    await withGrantedScopes({ principalKind: "creator", scopes: ["creator.video.write"] }, () =>
      h.client.call({ method: "POST", path: "/open/202512/file/init", accessToken: "creator", body: {} }),
    );
    await withGrantedScopes({ principalKind: "seller", scopes: ["seller.customer_service"] }, () =>
      h.client.call({ method: "POST", path: "/open/202512/file/init", accessToken: "seller", body: {} }),
    );
    await expect(
      withGrantedScopes({ principalKind: "creator", scopes: ["seller.customer_service"] }, () =>
        h.client.call({ method: "POST", path: "/open/202512/file/init", accessToken: "wrong", body: {} }),
      ),
    ).rejects.toMatchObject({ code: "missing_scope" });
    // Ordinary seller Order Information is independently valid; the full-service program's
    // separate package in the raw metadata is not a prerequisite for the ordinary API flow.
    await withGrantedScopes({ principalKind: "seller", scopes: ["seller.order.info"] }, () =>
      h.client.call({ method: "POST", path: "/order/202309/orders/search", accessToken: "seller", body: {} }),
    );
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
  it("supports ordinary seller order and fulfillment APIs without a full-service grant", async () => {
    const h = harness();
    await withGrantedScopes(
      {
        principalKind: "seller",
        scopes: ["seller.authorization.info", "seller.order.info", "seller.fulfillment.basic"],
      },
      async () => {
        await h.client.call({ method: "GET", path: "/authorization/202309/shops", accessToken: "ordinary" });
        await h.client.call({ method: "GET", path: "/order/202309/orders", accessToken: "ordinary" });
        await h.client.call({ method: "GET", path: "/order/202507/orders", accessToken: "ordinary" });
        await h.client.call({
          method: "POST",
          path: "/fulfillment/202309/packages/739123/ship",
          accessToken: "ordinary",
          body: {},
        });
        await h.client.call({
          method: "GET",
          path: "/fulfillment/202309/packages/739123/shipping_documents",
          accessToken: "ordinary",
        });
      },
    );
    expect(h.fetch).toHaveBeenCalledTimes(5);
    await expect(
      withGrantedScopes({ principalKind: "seller", scopes: ["seller.fulfillment.basic"] }, () =>
        h.client.call({ method: "GET", path: "/order/202507/orders", accessToken: "missing-order" }),
      ),
    ).rejects.toMatchObject({ code: "missing_scope" });
  });
  it("keeps marketplace authorization authoritative after a necessary package precheck", async () => {
    const h = harness();
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 105005, message: "Permission denied" })));
    await expect(
      withGrantedScopes({ principalKind: "seller", scopes: ["seller.fs.order&fufillment.management"] }, () =>
        h.client.call({
          method: "POST",
          path: "/order/202309/orders/search",
          accessToken: "program-unverified",
          body: {},
        }),
      ),
    ).rejects.toMatchObject({ kind: "permanent", code: "105005" });
    expect(h.fetch).toHaveBeenCalledOnce();
  });
  it("checks multipart uploads too, while token transport and independent connector fixtures remain usable", async () => {
    const h = harness();
    await withGrantedScopes({ principalKind: "seller", scopes: [] }, async () => {
      await expect(
        h.client.upload({
          path: "/product/202309/images/upload",
          accessToken: "token",
          form: { body: new FormData(), logBody: {} },
        }),
      ).rejects.toMatchObject({ code: "missing_scope" });
      await h.client.token("/api/v2/token/refresh", { refresh_token: "refresh", grant_type: "refresh_token" });
    });
    // There is no ambient authorization in isolated transport fixtures; production enters via gateway.
    await h.client.call({ method: "GET", path: product, accessToken: "fixture" });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});
