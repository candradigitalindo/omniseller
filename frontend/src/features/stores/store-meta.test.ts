import { describe, expect, it } from "vitest";
import { callbackBody, isFinal, needsReconnect, type Store, sortStores } from "./store-meta";

describe("callbackBody", () => {
  it("passes Shopee's code, shop, and state to the api", () => {
    const params = new URLSearchParams("code=abc123&shop_id=777001&state=st-1");
    expect(callbackBody("shopee", params)).toEqual({
      channel: "shopee",
      state: "st-1",
      code: "abc123",
      shopId: "777001",
    });
    const main = new URLSearchParams("code=abc&main_account_id=55&state=st-2");
    expect(callbackBody("shopee", main)).toEqual({
      channel: "shopee",
      state: "st-2",
      code: "abc",
      mainAccountId: "55",
    });
  });

  it("passes a declined TikTok Shop consent as its error", () => {
    const params = new URLSearchParams("error=auth_denied&state=st-3");
    expect(callbackBody("tiktokshop", params)).toEqual({ channel: "tiktokshop", state: "st-3", error: "auth_denied" });
  });

  it("refuses links that are no marketplace's answer", () => {
    expect(callbackBody("shopee", new URLSearchParams("code=abc"))).toBeNull();
    expect(callbackBody("lazada", new URLSearchParams("code=abc&state=x"))).toBeNull();
  });
});

describe("store helpers", () => {
  const store = (over: Partial<Store>): Store =>
    ({ id: over.name ?? "x", name: "x", channel: "shopee", status: "active", ...over }) as Store;

  it("lists marketplace stores, then manual channels, then disconnected ones", () => {
    const sorted = sortStores([
      store({ name: "Zeta", status: "disconnected" }),
      store({ name: "WhatsApp", channel: "manual" }),
      store({ name: "Toko B" }),
      store({ name: "Toko A", status: "reauth_required" }),
    ]);
    expect(sorted.map((s) => s.name)).toEqual(["Toko A", "Toko B", "WhatsApp", "Zeta"]);
  });

  it("offers reconnecting when the authorization ended or is ending", () => {
    expect(needsReconnect("reauth_required")).toBe(true);
    expect(needsReconnect("token_expiring")).toBe(true);
    expect(needsReconnect("active")).toBe(false);
    expect(isFinal("exchanging")).toBe(false);
    expect(isFinal("expired")).toBe(true);
  });
});
