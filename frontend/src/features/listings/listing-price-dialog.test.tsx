import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Listing } from "@/features/products/product-meta";
import type { components } from "@/lib/api/schema";
import { mockApi, renderApp, testMe } from "@/test/render";
import { ListingPriceDialog } from "./listing-price-dialog";

const listing: Listing = {
  id: "01JLISTING0000000000000001",
  storeId: "01JSTORE000000000000000001",
  store: { name: "Toko Utama", channel: "shopee", channelName: "Shopee" },
  externalItemId: "123",
  externalVariantId: "456",
  sku: "KAOS-M",
  title: "Kaos Merah",
  variantName: "M",
  attributes: {},
  imageUrl: null,
  price: 45000,
  originalPrice: 50000,
  status: "active",
  statusDetail: {},
  stock: 10,
  stockByWarehouse: {},
  mapping: null,
  lastPulledAt: "2026-10-17T00:00:00.000Z",
};
const request: components["schemas"]["ListingPriceChangeDto_Output"] = {
  id: "01JCHANGE00000000000000001",
  listingId: listing.id,
  expectedPrice: 50000,
  requestedPrice: 65000,
  observedPrice: null,
  status: "queued",
  canCancel: true,
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
};
function setup(initial: (typeof request)[] = [], readOnly = false) {
  let history = initial;
  return mockApi({
    "GET /v1/stores": () => ({
      items: readOnly ? [{ id: listing.storeId, channel: "shopee", syncMode: "read_only" }] : [],
    }),
    [`GET /v1/listings/${listing.id}`]: () => listing,
    [`GET /v1/listings/${listing.id}/price-changes`]: () => ({ items: history }),
    [`POST /v1/listings/${listing.id}/price-changes`]: () => {
      history = [request];
      return request;
    },
    [`POST /v1/listings/${listing.id}/price-changes/cancel`]: () => {
      history = [{ ...request, status: "cancelled" }];
    },
  });
}
describe("listing price dialog", () => {
  it("submits an integer rupiah target with the original price and an idempotency key", async () => {
    const calls = setup();
    const user = userEvent.setup();
    renderApp(<ListingPriceDialog listing={listing} onClose={vi.fn()} />, {
      me: testMe(["catalog:read", "price:write"]),
    });
    await screen.findByRole("textbox", { name: "Harga reguler baru" });
    await user.type(screen.getByRole("textbox", { name: "Harga reguler baru" }), "65000");
    expect(screen.getByRole("textbox", { name: "Harga reguler baru" })).toHaveValue("65.000");
    await user.click(screen.getByRole("button", { name: "Kirim harga baru" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")).toMatchObject({
      body: { price: 65000, expectedPrice: 50000 },
      headers: { "idempotency-key": expect.stringMatching(/^[a-z0-9-]{36}$/) },
    });
    expect(await screen.findByText("Menunggu worker")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kirim harga baru" })).not.toBeInTheDocument();
  });
  it("shows progress, prevents competing edits and cancels only queued work", async () => {
    const calls = setup([request]);
    const user = userEvent.setup();
    renderApp(<ListingPriceDialog listing={listing} onClose={vi.fn()} />);
    await screen.findByText("Menunggu worker");
    expect(screen.queryByRole("textbox", { name: "Harga reguler baru" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Batalkan antrean" }));
    await screen.findByText("Dibatalkan");
    expect(calls.find((c) => c.path.endsWith("/cancel"))).toMatchObject({ body: { changeId: request.id } });
  });
  it("does not offer cancellation after a write has been accepted and is awaiting confirmation", async () => {
    setup([
      {
        ...request,
        canCancel: false,
        errorCode: "confirmation_pending",
        errorMessage: "Harga belum dapat dikonfirmasi.",
      },
    ]);
    renderApp(<ListingPriceDialog listing={listing} onClose={vi.fn()} />);
    await screen.findByText("Harga belum dapat dikonfirmasi.");
    expect(screen.queryByRole("button", { name: "Batalkan antrean" })).not.toBeInTheDocument();
  });
  it("does not infer price permission from publishing and keeps read-only history accessible", async () => {
    setup([request]);
    const app = renderApp(<ListingPriceDialog listing={listing} onClose={vi.fn()} />, {
      me: testMe(["catalog:read", "catalog:publish"]),
    });
    await screen.findByText("Menunggu worker");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Batalkan antrean" })).not.toBeInTheDocument();
    app.unmount();
    setup([], true);
    renderApp(<ListingPriceDialog listing={listing} onClose={vi.fn()} />);
    await screen.findByText("Toko masih dalam mode uji berdampingan. Ubah harga di Seller Center.");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
