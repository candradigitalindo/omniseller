import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthorizationCallback } from "@/features/stores/authorization-callback";
import { setUrl } from "@/test/navigation";
import { mockApi, renderApp } from "@/test/render";

describe("affiliate account callback routing", () => {
  it("routes its namespaced state to accounts and follows worker verification exactly once", async () => {
    setUrl("/integrasi/callback/tiktokshop?state=a1_fixture&code=fixture-code");
    const calls = mockApi({
      "POST /v1/affiliate/authorizations/callback": () => ({ id: "auth1", status: "verifying", errorMessage: null }),
      "GET /v1/affiliate/authorizations/auth1": () => ({ id: "auth1", status: "succeeded", errorMessage: null }),
    });
    renderApp(<AuthorizationCallback channel="tiktokshop" />);
    await screen.findByText("Akun berhasil terhubung");
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ state: "a1_fixture", code: "fixture-code" });
    expect(calls.some((c) => c.path.startsWith("/v1/store-authorizations"))).toBe(false);
    expect(screen.getByRole("link", { name: "Kembali ke akun" })).toHaveAttribute("href", "/affiliate/akun");
  });
});
