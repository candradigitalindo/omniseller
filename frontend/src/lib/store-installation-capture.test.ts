import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { mockApi } from "@/test/render";
import { proxy } from "../proxy";
import { captureAppStoreInstallation, INSTALLATION_PATH, isAppStoreRedirect } from "./store-installation-capture";

describe("App Store callback capture before login", () => {
  it("keeps OAuth state callbacks on their existing path and recognizes only seller App Store callbacks", () => {
    expect(isAppStoreRedirect(new URL("https://app.example/integrasi/callback/tiktokshop?code=private"))).toBe(true);
    expect(
      isAppStoreRedirect(new URL("https://app.example/integrasi/callback/tiktokshop?code=private&state=known")),
    ).toBe(false);
    expect(isAppStoreRedirect(new URL("https://app.example/integrasi/callback/shopee?code=private"))).toBe(false);
    expect(isAppStoreRedirect(new URL("https://app.example/integrasi/callback/tiktokshop"))).toBe(false);
  });

  it("posts the private code server-side, forwards only the receipt, and redirects to a clean page", async () => {
    const calls = mockApi({
      "POST /v1/store-installations/tiktokshop/capture": () =>
        Response.json(
          { expiresAt: "2026-10-18T00:10:00Z" },
          {
            status: 201,
            headers: {
              "Set-Cookie": "os_tiktok_install=opaque-receipt; Path=/v1/store-installations; HttpOnly; SameSite=Lax",
            },
          },
        ),
    });
    const response = await proxy(
      new NextRequest(
        "http://localhost:3100/integrasi/callback/tiktokshop?code=private-provider-code&next=https://other.example",
      ),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: "/v1/store-installations/tiktokshop/capture",
      body: { code: "private-provider-code" },
      headers: { origin: "http://localhost:3100" },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`http://localhost:3100${INSTALLATION_PATH}`);
    expect(response.headers.get("set-cookie")).toContain("opaque-receipt");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify([...response.headers])).not.toContain("private-provider-code");
  });

  it("never puts a failed capture code in the login or error destination", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("transport included private-provider-code")));
    const response = await captureAppStoreInstallation(
      new NextRequest("http://localhost:3100/integrasi/callback/tiktokshop?code=private-provider-code"),
    );
    expect(response.headers.get("location")).toBe(`http://localhost:3100${INSTALLATION_PATH}?capture=failed`);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify([...response.headers])).not.toContain("private-provider-code");
    const next = await proxy(new NextRequest(`http://localhost:3100${INSTALLATION_PATH}`));
    const login = new URL(next.headers.get("location")!);
    expect(login.pathname).toBe("/masuk");
    expect(login.searchParams.get("next")).toBe(INSTALLATION_PATH);
  });

  it("rejects ambiguous duplicate code parameters before contacting the backend", async () => {
    const calls = mockApi({});
    const response = await proxy(
      new NextRequest("http://localhost:3100/integrasi/callback/tiktokshop?code=one&code=two"),
    );
    expect(calls).toHaveLength(0);
    expect(response.headers.get("location")).toContain("capture=failed");
  });
});
