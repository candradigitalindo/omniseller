import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { productFixture } from "@/features/products/fixtures";
import type { UnmappedListing } from "@/features/products/product-meta";
import { currentUrl, setUrl } from "@/test/navigation";
import { mockApi, renderApp, testMe } from "@/test/render";
import { ListingsView } from "./listings-view";

const STORE = "01JSTORE000000000000000001";

function unmapped(over: Partial<UnmappedListing>): UnmappedListing {
  return {
    id: "01JLISTING0000000000000001",
    storeId: STORE,
    store: { name: "Toko Utama", channel: "shopee", channelName: "Shopee" },
    externalItemId: "7001",
    externalVariantId: "70011",
    sku: "KP-HTM-L",
    title: "Kaos Polos Premium Hitam L",
    variantName: "Hitam, L",
    attributes: {},
    imageUrl: null,
    price: 65_000,
    originalPrice: null,
    status: "active",
    statusDetail: {},
    stock: 10,
    stockByWarehouse: {},
    mapping: null,
    lastPulledAt: "2026-10-05T00:00:00.000Z",
    suggestions: [],
    ...over,
  };
}

const bySku = unmapped({
  // the api lists a name match first; the same SKU still wins
  suggestions: [
    {
      variantId: "01JVARIANT0000000000000003",
      sku: "KAOS-HTM-XL",
      variantName: "Hitam, XL",
      productId: "01JPRODUCT0000000000000001",
      productName: "Kaos Polos Cotton Combed 30s",
      score: 0.8,
      reason: "name",
    },
    {
      variantId: "01JVARIANT0000000000000001",
      sku: "KAOS-HTM-L",
      variantName: "Hitam, L",
      productId: "01JPRODUCT0000000000000001",
      productName: "Kaos Polos Cotton Combed 30s",
      score: 1,
      reason: "sku",
    },
  ],
});
const byNothing = unmapped({
  id: "01JLISTING0000000000000002",
  sku: "TOPI-01",
  title: "Topi Rajut",
  variantName: null,
});

function api() {
  return mockApi({
    "GET /v1/listings/summary": () => ({ total: 430, mapped: 412, unmapped: 18 }),
    "GET /v1/listings/unmapped": () => ({ items: [bySku, byNothing], next_cursor: null }),
    "PUT /v1/listings/01JLISTING0000000000000001/mapping": () => ({
      ...bySku,
      mapping: { ...bySku.suggestions[1]!, source: "manual", mappedAt: "2026-10-05T01:00:00.000Z" },
    }),
    "PUT /v1/listings/01JLISTING0000000000000002/mapping": () => ({
      ...byNothing,
      mapping: {
        variantId: "01JVARIANT0000000000000002",
        sku: "KAOS-PTH-L",
        variantName: "Putih, L",
        productId: "p",
        productName: "Kaos",
        source: "manual",
        mappedAt: "2026-10-05T01:00:00.000Z",
      },
    }),
    "POST /v1/listings/auto-map": () => ({ mapped: 3 }),
    "POST /v1/listings/create-products": () => ({
      created: [{ productId: "01JPRODUCT0000000000000009", sku: "TOPI-01", listingIds: [byNothing.id] }],
      mappedToExisting: [],
      failed: [],
    }),
    "GET /v1/products": () => ({ items: [productFixture()], next_cursor: null }),
    "GET /v1/stores": () => ({ items: [] }),
  });
}

describe("ListingsView", () => {
  beforeEach(() => setUrl("/listing"));

  it("shows how far mapping got and connects a listing to the suggested variant", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<ListingsView />);

    expect(await screen.findByText("412 dari 430 listing sudah terhubung (95%)")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Belum terhubung\s*18/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("SKU sama")).toBeInTheDocument();
    expect(screen.getByText("Tidak ada saran")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hubungkan" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      path: "/v1/listings/01JLISTING0000000000000001/mapping",
      body: { variantId: "01JVARIANT0000000000000001" },
    });
  });

  it("finds a variant by hand for a listing without a suggestion", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<ListingsView />);

    const row = (await screen.findByText("Topi Rajut")).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Cari manual" }));
    const dialog = await screen.findByRole("dialog");
    const box = within(dialog).getByLabelText("Cari nama produk atau SKU");
    expect(box).toHaveValue("TOPI-01");
    await user.clear(box);
    await user.type(box, "kaos");
    await user.click(await within(dialog).findByRole("button", { name: /KAOS-PTH-L/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/v1/listings/01JLISTING0000000000000002/mapping")).toBe(true),
    );
    // the picker starts from the listing's own SKU
    const searches = calls.filter((c) => c.path === "/v1/products").map((c) => c.query.q);
    expect(searches[0]).toBe("TOPI-01");
    expect(searches.at(-1)).toBe("kaos");
  });

  it("maps by SKU everywhere at once and creates products from listings", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<ListingsView />);

    await user.click(await screen.findByRole("button", { name: "Terapkan saran SKU" }));
    expect(await screen.findByText("3 listing terhubung lewat SKU yang sama.")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/v1/listings/auto-map")?.body).toEqual({});

    const row = screen.getByText("Topi Rajut").closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Buat produk baru" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/listings/create-products")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/listings/create-products")?.body).toEqual({ listingIds: [byNothing.id] });
  });

  it("keeps the tab in the URL", async () => {
    api();
    const user = userEvent.setup();
    renderApp(<ListingsView />);
    await user.click(await screen.findByRole("tab", { name: "Semua" }));
    expect(currentUrl()).toBe("/listing?tab=all");
  });
});

describe("ListingsView: switching listings on and off at the marketplace", () => {
  const OLD_STORE = "01JSTORE000000000000000002";
  const blackL = unmapped({ id: "01JLISTING0000000000000011", externalItemId: "7001", title: "Kaos Hitam L" });
  const blackXl = unmapped({
    id: "01JLISTING0000000000000012",
    externalItemId: "7001",
    externalVariantId: "70012",
    title: "Kaos Hitam XL",
  });
  const hat = unmapped({
    id: "01JLISTING0000000000000013",
    externalItemId: "7002",
    title: "Topi Rajut",
    status: "inactive",
  });
  const gone = unmapped({
    id: "01JLISTING0000000000000014",
    externalItemId: "7003",
    title: "Tas Lama",
    status: "deleted",
  });
  const elsewhere = unmapped({
    id: "01JLISTING0000000000000015",
    storeId: OLD_STORE,
    store: { name: "Toko Lama", channel: "shopee", channelName: "Shopee" },
    externalItemId: "8001",
    title: "Sandal Jepit",
  });

  function allApi() {
    return mockApi({
      "GET /v1/listings/summary": () => ({ total: 5, mapped: 0, unmapped: 5 }),
      "GET /v1/listings": () => ({ items: [blackL, blackXl, hat, gone, elsewhere], next_cursor: null }),
      "GET /v1/stores": () => ({
        items: [
          { id: STORE, name: "Toko Utama", channel: "shopee", status: "active", syncMode: "live" },
          { id: OLD_STORE, name: "Toko Lama", channel: "shopee", status: "reauth_required", syncMode: "live" },
        ],
      }),
      "POST /v1/listings/status": (c) => {
        const ids = (c.body as { listingIds: string[] }).listingIds;
        return Response.json(
          { stores: 1, items: new Set(ids.map((id) => (id === hat.id ? "7002" : "7001"))).size },
          { status: 202 },
        );
      },
    });
  }
  const box = (title: string) => screen.queryByRole("checkbox", { name: `Pilih listing ${title}` });

  beforeEach(() => setUrl("/listing?tab=all"));

  it("offers listings that can change, and switches them off by marketplace product after asking", async () => {
    const calls = allApi();
    const user = userEvent.setup();
    renderApp(<ListingsView />);
    await screen.findByText("Kaos Hitam L");
    // deleted at the marketplace, or of a store waiting to be connected again: nothing to switch
    expect(box("Tas Lama")).not.toBeInTheDocument();
    await waitFor(() => expect(box("Kaos Hitam L")).toBeInTheDocument());
    expect(box("Sandal Jepit")).not.toBeInTheDocument();

    for (const title of ["Kaos Hitam L", "Kaos Hitam XL", "Topi Rajut"]) await user.click(box(title)!);
    expect(screen.getByText("3 dipilih")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Nonaktifkan di marketplace" }));
    const dialog = await screen.findByRole("dialog", { name: "Nonaktifkan di marketplace?" });
    expect(dialog).toHaveTextContent("3 listing dipilih, 2 produk di marketplace.");
    await user.click(within(dialog).getByRole("button", { name: "Nonaktifkan di marketplace" }));

    await waitFor(() => expect(calls.some((c) => c.path === "/v1/listings/status")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/listings/status")?.body).toEqual({
      listingIds: [blackL.id, blackXl.id, hat.id],
      active: false,
    });
    expect(await screen.findByText(/Permintaan nonaktif dikirim untuk 2 produk di 1 toko/)).toBeInTheDocument();
    expect(screen.queryByText("3 dipilih")).not.toBeInTheDocument();
  });

  it("switches a listing on", async () => {
    const calls = allApi();
    const user = userEvent.setup();
    renderApp(<ListingsView />);
    await waitFor(() => expect(box("Topi Rajut")).toBeInTheDocument());
    await user.click(box("Topi Rajut")!);
    await user.click(screen.getByRole("button", { name: "Aktifkan di marketplace" }));
    const dialog = await screen.findByRole("dialog", { name: "Aktifkan di marketplace?" });
    await user.click(within(dialog).getByRole("button", { name: "Aktifkan di marketplace" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/listings/status")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/listings/status")?.body).toEqual({ listingIds: [hat.id], active: true });
  });

  it("offers nothing to switch without catalog:publish", async () => {
    allApi();
    renderApp(<ListingsView />, { me: testMe(["catalog:read", "catalog:map"]) });
    await screen.findByText("Kaos Hitam L");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});
