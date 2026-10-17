import { currentGrantedScopes, type MarketplaceConnector, type ShopCredentials } from "@omniseller/connector-core";
import { createTiktokShopConnector, TiktokShopClient } from "@omniseller/connector-tiktokshop";
import { describe, expect, it, vi } from "vitest";
import { systemContext } from "../../common/context/request-context";
import type { RateLimiter } from "../../common/security/rate-limiter";
import type { SyncLogService } from "../sync/sync-log.service";
import type { StoreRow } from "./channel.repository";
import { ConnectorRegistry } from "./connector-registry";
import type { CredentialService } from "./credential.service";
import { MarketplaceGateway } from "./marketplace-gateway";
import type { StoresService } from "./stores.service";

const product = "/product/202309/products/576486316948490012";
const config = {
  appKey: "app",
  appSecret: "secret",
  serviceId: "service",
  apiBaseUrl: "https://example.test",
  authBaseUrl: "https://auth.example.test",
  authorizeUrl: "https://example.test/authorize",
};
function harness(initialScopes: string[], nextScopes = initialScopes, expired = false) {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(JSON.stringify({ code: 0, data: { ok: true } })),
  );
  if (expired) fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 105002, message: "Token expired" })));
  const client = new TiktokShopClient({ ...config, http: { fetch } });
  const store = { id: "store", channel: "tiktokshop", failingSince: null } as StoreRow;
  const info = (scopes: string[], accessToken: string) => ({
    store,
    scopes,
    shop: { accessToken, externalShopId: "shop", shopCipher: "private" },
  });
  const credentials = {
    forShop: vi
      .fn()
      .mockResolvedValueOnce(info(initialScopes, "old-token"))
      .mockResolvedValue(info(nextScopes, "new-token")),
    refresh: vi.fn().mockResolvedValue("refreshed"),
  };
  const stores = { markReauthRequired: vi.fn(), noteCallWorked: vi.fn(), noteCallFailed: vi.fn() };
  const syncLog = { run: vi.fn(async (_ctx: unknown, _entry: unknown, fn: () => Promise<unknown>) => fn()) };
  const limiter = { take: vi.fn().mockResolvedValue({ allowed: true }) };
  const gateway = new MarketplaceGateway(
    new ConnectorRegistry([["tiktokshop", createTiktokShopConnector(config)]]),
    credentials as unknown as CredentialService,
    stores as unknown as StoresService,
    syncLog as unknown as SyncLogService,
    limiter as unknown as RateLimiter,
  );
  const invoke = (method: "GET" | "PUT" = "GET") =>
    gateway.call(
      systemContext("tenant"),
      "store",
      { kind: "test", direction: "pull" },
      (_connector: MarketplaceConnector, shop: ShopCredentials) =>
        client.call({ method, path: product, accessToken: shop.accessToken }),
    );
  return { gateway, invoke, fetch, credentials, stores, client };
}
describe("MarketplaceGateway uses the current persisted scope grant for every TikTok HTTP request", () => {
  it("does not send a denied request or refresh a valid token to expand its scopes", async () => {
    const h = harness(["seller.product.basic"]);
    await expect(h.invoke("PUT")).rejects.toMatchObject({ code: "missing_scope" });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.credentials.refresh).not.toHaveBeenCalled();
    expect(h.stores.markReauthRequired).not.toHaveBeenCalled();
    expect(currentGrantedScopes()).toBeUndefined();
  });
  it("rechecks narrowed scope metadata after refreshing before retrying", async () => {
    const h = harness(["seller.product.basic", "seller.product.write"], ["seller.product.basic"], true);
    await expect(h.invoke("PUT")).rejects.toMatchObject({ code: "missing_scope" });
    expect(h.credentials.refresh).toHaveBeenCalledOnce();
    expect(h.credentials.forShop).toHaveBeenCalledTimes(2);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.stores.markReauthRequired).not.toHaveBeenCalled();
  });
  it("uses the replacement access token and scope grant on an authorized retry", async () => {
    const h = harness(["seller.product.basic"], ["seller.product.basic"], true);
    await expect(h.invoke()).resolves.toEqual({ ok: true });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls.map((call) => new Headers(call[1]?.headers).get("x-tts-access-token"))).toEqual([
      "old-token",
      "new-token",
    ]);
  });
  it("checks later requests within a multi-call connector operation", async () => {
    const h = harness(["seller.product.basic"]);
    await expect(
      h.gateway.call(
        systemContext("tenant"),
        "store",
        { kind: "test", direction: "pull" },
        async (_connector, shop) => {
          await h.client.call({ method: "GET", path: product, accessToken: shop.accessToken });
          await h.client.call({ method: "PUT", path: product, accessToken: shop.accessToken });
        },
      ),
    ).rejects.toMatchObject({ code: "missing_scope" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
