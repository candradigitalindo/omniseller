import { describe, expect, it } from "vitest";
import { tiktokSign, tiktokSignString } from "./client.js";
import { createTiktokShopConnector } from "./connector.js";

const baseToken = {
  access_token: "fixture-access",
  refresh_token: "fixture-refresh",
  access_token_expire_in: Math.floor(Date.now() / 1000) + 604800,
  refresh_token_expire_in: Math.floor(Date.now() / 1000) + 31536000,
  open_id: "9223372036854775806",
  user_type: 1,
  granted_scopes: ["creator.affiliate.info"],
};
function harness() {
  let token: Record<string, unknown> = { ...baseToken };
  let profile: unknown = {
    username: "creator_demo",
    selection_region: "ID",
    register_region: "ID",
    creator_user_open_id: "creator-open-id",
    user_type: "TIKTOK_SHOP_CREATOR",
    permissions: ["ADD_AFFILIATE_PERMISSION"],
  };
  let assets: unknown = {
    category_assets: [
      { cipher: "opaque-asset", target_market: "ID", category: { id: 123, name: "TAP fixture category" } },
    ],
  };
  let envelope: object | null = null;
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetch = (async (u: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(u));
    calls.push({ url, init });
    let data: unknown;
    if (url.pathname === "/api/v2/token/get" || url.pathname === "/api/v2/token/refresh") data = token;
    else if (url.pathname === "/affiliate_creator/202508/profiles") data = profile;
    else if (url.pathname === "/authorization/202405/category_assets") data = assets;
    else return new Response("{}", { status: 404 });
    return Response.json(envelope ?? { code: 0, data });
  }) as typeof globalThis.fetch;
  const c = createTiktokShopConnector({
    appKey: "fixture-app",
    appSecret: "fixture-secret",
    serviceId: "fixture-service",
    apiBaseUrl: "https://open-api.tiktokglobalshop.com",
    authBaseUrl: "https://auth.tiktok-shops.com",
    authorizeUrl: "https://services.tiktokshop.com/open/authorize",
    http: { fetch },
  });
  return {
    accounts: c.accounts!,
    seller: c.auth,
    calls,
    setToken: (v: Record<string, unknown>) => {
      token = { ...baseToken, ...v };
    },
    setProfile: (v: unknown) => {
      profile = v;
    },
    setAssets: (v: unknown) => {
      assets = v;
    },
    setEnvelope: (v: object) => {
      envelope = v;
    },
  };
}
describe("creator and partner authorization", () => {
  it("uses distinct official ROW authorization domains and the right public identifier", () => {
    const h = harness();
    const creator = new URL(h.accounts.authorizeUrl({ kind: "creator", state: "unguessable-state" }));
    const partner = new URL(h.accounts.authorizeUrl({ kind: "affiliate_partner", state: "unguessable-state" }));
    expect(creator.origin + creator.pathname).toBe("https://shop.tiktok.com/alliance/creator/auth");
    expect(Object.fromEntries(creator.searchParams)).toEqual({ app_key: "fixture-app", state: "unguessable-state" });
    expect(partner.origin + partner.pathname).toBe("https://partner.tiktokshop.com/open/authorize");
    expect(Object.fromEntries(partner.searchParams)).toEqual({
      service_id: "fixture-service",
      state: "unguessable-state",
    });
    expect(h.calls).toHaveLength(0);
    expect(() => h.accounts.authorizeUrl({ kind: "creator", state: " " })).toThrow();
  });
  it("exchanges creator tokens without ever calling seller shop authorization", async () => {
    const h = harness();
    const grant = await h.accounts.exchangeCode({ kind: "creator", code: "fixture-code" });
    expect(grant).toMatchObject({
      kind: "creator",
      externalPrincipalId: "9223372036854775806",
      tokens: { scopes: ["creator.affiliate.info"], accessToken: "fixture-access" },
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url.pathname).toBe("/api/v2/token/get");
    expect(h.calls[0]!.url.searchParams.get("grant_type")).toBe("authorized_code");
  });
  it.each([0, 2, 3, 4, 5, undefined])("rejects user_type %s as a creator identity", async (userType) => {
    const h = harness();
    h.setToken({ user_type: userType });
    await expect(h.accounts.exchangeCode({ kind: "creator", code: "fixture-code" })).rejects.toMatchObject({
      code: "wrong_user_type",
    });
  });
  it("requires the minimum business scopes and rejects identity swaps on refresh", async () => {
    const h = harness();
    h.setToken({ granted_scopes: [] });
    await expect(h.accounts.exchangeCode({ kind: "creator", code: "fixture-code" })).rejects.toMatchObject({
      code: "missing_scope",
    });
    h.setToken({ open_id: "someone-else" });
    await expect(
      h.accounts.refresh({ kind: "creator", externalPrincipalId: "original", refreshToken: "old-token" }),
    ).rejects.toMatchObject({ code: "principal_changed" });
  });
  it("reads a signed creator profile without shop_cipher and validates the actual selection region", async () => {
    const h = harness();
    const profile = await h.accounts.describe({
      kind: "creator",
      accessToken: "creator-token",
      scopes: ["creator.affiliate.info"],
    });
    expect(profile).toMatchObject({ region: "ID", displayName: "creator_demo", categoryAssets: [] });
    const call = h.calls[0]!;
    const query = Object.fromEntries(call.url.searchParams);
    expect(query).not.toHaveProperty("shop_cipher");
    expect((call.init.headers as Record<string, string>)["x-tts-access-token"]).toBe("creator-token");
    expect(query.sign).toBe(tiktokSign("fixture-secret", tiktokSignString({ path: call.url.pathname, query })));
    h.setProfile({ username: "foreign", selection_region: "US" });
    await expect(
      h.accounts.describe({ kind: "creator", accessToken: "creator-token", scopes: ["creator.affiliate.info"] }),
    ).rejects.toMatchObject({ code: "region_not_supported" });
  });
  it("accepts only current partner type 3 and stores asset ciphers separately from public metadata", async () => {
    const h = harness();
    h.setToken({ user_type: 3, granted_scopes: ["partner.authorization.info"] });
    expect((await h.accounts.exchangeCode({ kind: "affiliate_partner", code: "fixture-code" })).kind).toBe(
      "affiliate_partner",
    );
    const profile = await h.accounts.describe({
      kind: "affiliate_partner",
      accessToken: "partner-token",
      scopes: ["partner.authorization.info"],
    });
    expect(profile.categoryAssets).toEqual([
      { cipher: "opaque-asset", market: "ID", categoryId: 123, categoryName: "TAP fixture category" },
    ]);
    expect(JSON.stringify(profile.info)).not.toContain("opaque-asset");
    h.setAssets({
      category_assets: [{ cipher: "foreign", target_market: "US", category: { id: 123, name: "Any name" } }],
    });
    await expect(
      h.accounts.describe({
        kind: "affiliate_partner",
        accessToken: "partner-token",
        scopes: ["partner.authorization.info"],
      }),
    ).rejects.toMatchObject({ code: "region_not_supported" });
  });
  it("does not substitute a business permission refusal for an expired token", async () => {
    const h = harness();
    h.setEnvelope({ code: 105005, message: "Missing scope" });
    await expect(
      h.accounts.describe({ kind: "creator", accessToken: "creator-token", scopes: ["creator.affiliate.info"] }),
    ).rejects.toMatchObject({ kind: "permanent" });
  });
});
