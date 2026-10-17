import { type CallRecord, parseJsonSafe } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { shopeeAccounts } from "./accounts.js";
import { classifyShopeeError, ShopeeClient, shopeeSign } from "./client.js";

const USER = "9007199254740993";
const reply = {
  error: "",
  request_id: "auth",
  user_id_list: [USER],
  access_token: "private-access",
  refresh_token: "private-refresh",
  expire_in: 14400,
};
function harness(response: unknown = reply) {
  const calls: { url: URL; body: Record<string, unknown>; raw: string }[] = [];
  const records: CallRecord[] = [];
  const client = new ShopeeClient({
    partnerId: 123,
    partnerKey: "key",
    apiBaseUrl: "https://partner.shopeemobile.com",
    authBaseUrl: "https://open.shopee.com",
    accountRedirectUri: "https://integrator.example/oauth/shopee",
    http: {
      observer: (record) => records.push(record),
      fetch: (async (input, init) => {
        const url = new URL(String(input));
        const raw = String(init?.body ?? "{}");
        calls.push({ url, raw, body: parseJsonSafe(raw) as Record<string, unknown> });
        return new Response(JSON.stringify(response));
      }) as typeof fetch,
    },
  });
  return { auth: shopeeAccounts(client), calls, records };
}

describe("Shopee creator user grants", () => {
  it.each(["user_no_linked", "user_banned"])("classifies documented user revocation as reauthorization: %s", (code) => {
    expect(classifyShopeeError(code, "", 200)).toBe("auth_revoked");
  });
  it("uses the documented user authorization link and echoes state through the registered callback", () => {
    const h = harness();
    const url = new URL(h.auth.authorizeUrl({ state: "unguessable-state", kind: "creator", program: "live" }));
    expect(url.origin + url.pathname).toBe("https://open.shopee.com/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      partner_id: "123",
      auth_type: "user",
      redirect_uri: "https://integrator.example/oauth/shopee",
      response_type: "code",
      state: "unguessable-state",
    });
    expect(h.calls).toHaveLength(0);
    expect(() => h.auth.authorizeUrl({ state: "state", kind: "affiliate_partner", program: "video" })).toThrow();
  });
  it("exchanges a code once with public signing and retains the exact 64-bit user identifier", async () => {
    const h = harness();
    const grant = await h.auth.exchangeCode({ code: "private-code", kind: "creator", program: "video" });
    expect(grant.externalPrincipalId).toBe(USER);
    expect(grant.tokens.scopes).toEqual([]);
    expect(grant.tokens.refreshExpiresAt!.getTime() - Date.now()).toBeGreaterThan(29 * 86400000);
    const call = h.calls[0]!;
    expect(call.body).toEqual({ code: "private-code", partner_id: 123 });
    expect(call.url.searchParams.has("shop_id")).toBe(false);
    expect(call.url.searchParams.has("access_token")).toBe(false);
    expect(call.url.searchParams.get("sign")).toBe(
      shopeeSign("key", `123${call.url.pathname}${call.url.searchParams.get("timestamp")}`),
    );
    expect(JSON.stringify(h.records)).not.toMatch(/private-code|private-access|private-refresh/);
  });
  it("refreshes user tokens independently using an exact numeric user_id and rejects identity changes", async () => {
    const h = harness({ ...reply, user_id: USER });
    const result = await h.auth.refresh({
      kind: "creator",
      program: "live",
      refreshToken: "old-refresh",
      externalPrincipalId: USER,
    });
    expect(result.externalPrincipalId).toBe(USER);
    expect(h.calls[0]!.raw).toContain(`"user_id":${USER}`);
    expect(h.calls[0]!.url.pathname).toBe("/api/v2/auth/access_token/get");
    await expect(
      h.auth.refresh({ kind: "creator", program: "live", refreshToken: "old-refresh", externalPrincipalId: "23" }),
    ).rejects.toMatchObject({ code: "principal_changed" });
  });
  it.each([
    { ...reply, user_id_list: [] },
    { ...reply, user_id_list: [1, 2] },
    { ...reply, user_id_list: [0] },
    { ...reply, user_id_list: [1.5] },
    { ...reply, error: undefined },
    { ...reply, access_token: "" },
    { ...reply, expire_in: "14400" },
  ])("fails closed on malformed or ambiguous grants %#", async (value) => {
    const h = harness(value);
    await expect(h.auth.exchangeCode({ code: "code", kind: "creator", program: "video" })).rejects.toThrow();
  });
  it("labels the selected Indonesian market as unverified without inventing a profile request", async () => {
    const h = harness();
    const result = await h.auth.describe({
      accessToken: "access",
      kind: "creator",
      program: "video",
      scopes: [],
      externalPrincipalId: USER,
    });
    expect(result).toMatchObject({
      region: "ID",
      regionVerified: false,
      displayName: null,
      info: { program: "video", regionVerification: "unverified" },
    });
    expect(h.calls).toHaveLength(0);
  });
  it("keeps arbitrary remote authorization error text out of observations and propagated messages", async () => {
    const secret = "PRIVATE-AUTH-ERROR-CANARY";
    const h = harness({ error: "error_param", message: secret, request_id: secret });
    const error = await h.auth
      .exchangeCode({ code: "private-code", kind: "creator", program: "video" })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "error_param", kind: "permanent" });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(h.records)).not.toContain(secret);
  });
});
