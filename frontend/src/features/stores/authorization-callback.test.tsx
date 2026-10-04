import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl } from "@/test/navigation";
import { mockApi, problem, renderApp } from "@/test/render";
import { AuthorizationCallback } from "./authorization-callback";
import type { Authorization } from "./store-meta";

const base: Authorization = {
  id: "01JAUTH0000000000000000001",
  channel: "shopee",
  storeId: null,
  status: "exchanging",
  expiresAt: "2026-10-04T16:00:00.000Z",
  callbackAt: "2026-10-04T15:00:00.000Z",
  completedAt: null,
  result: { stores: [], skipped: [], failed: [] },
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-10-04T14:59:00.000Z",
};

describe("AuthorizationCallback", () => {
  beforeEach(() => setUrl("/integrasi/callback/shopee?code=abc123&shop_id=777001&state=st-1"));

  it("hands the answer over once and follows the authorization until the shops are connected", async () => {
    let polls = 0;
    const calls = mockApi({
      "POST /v1/store-authorizations/callback": () => base,
      [`GET /v1/store-authorizations/${base.id}`]: () => {
        polls += 1;
        return polls < 2
          ? base
          : {
              ...base,
              status: "succeeded",
              completedAt: "2026-10-04T15:00:05.000Z",
              result: {
                stores: [
                  {
                    storeId: "01JSTORE000000000000000001",
                    externalShopId: "777001",
                    name: "Toko Rina",
                    reconnected: false,
                  },
                ],
                skipped: [{ externalShopId: "888", region: "MY", reason: "region_not_supported" }],
                failed: [],
              },
            };
      },
    });
    renderApp(<AuthorizationCallback channel="shopee" />);

    expect(await screen.findByText("Menghubungkan toko Shopee…")).toBeInTheDocument();
    expect(await screen.findByText("1 toko terhubung", {}, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByText("Toko Rina terhubung")).toBeInTheDocument();
    expect(screen.getByText("Toko 888 dilewati: region MY belum didukung.")).toBeInTheDocument();

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ channel: "shopee", state: "st-1", code: "abc123", shopId: "777001" });
  }, 10_000);

  it("says why when the marketplace or the api refuses", async () => {
    mockApi({
      "POST /v1/store-authorizations/callback": () =>
        problem(409, "store_authorization.not_pending", "Otorisasi ini sudah dipakai. Mulai hubungkan toko dari awal."),
    });
    renderApp(<AuthorizationCallback channel="shopee" />);
    expect(await screen.findByText("Toko Shopee belum terhubung")).toBeInTheDocument();
    expect(screen.getByText("Otorisasi ini sudah dipakai. Mulai hubungkan toko dari awal.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ke Toko Terhubung" })).toHaveAttribute("href", "/integrasi");
  });

  it("does not call the api for a link without the marketplace's answer", async () => {
    setUrl("/integrasi/callback/shopee");
    const calls = mockApi({});
    renderApp(<AuthorizationCallback channel="shopee" />);
    expect(await screen.findByText("Tautan ini tidak lengkap")).toBeInTheDocument();
    await waitFor(() => expect(calls).toHaveLength(0));
  });
});
