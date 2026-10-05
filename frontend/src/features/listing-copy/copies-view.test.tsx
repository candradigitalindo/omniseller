import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { mockApi, problem, renderApp, testMe } from "@/test/render";
import { CopiesView } from "./copies-view";
import { COPY_ID, copyFixture, draftItem, SHOPEE_STORE, stores, TIKTOK_STORE } from "./fixtures";

const listing = (id: string, itemId: string, title: string) => ({
  id,
  storeId: SHOPEE_STORE,
  store: null,
  externalItemId: itemId,
  externalVariantId: `${itemId}-1`,
  sku: null,
  title,
  variantName: null,
  attributes: {},
  imageUrl: null,
  price: 55_000,
  originalPrice: null,
  status: "active",
  statusDetail: {},
  stock: 3,
  stockByWarehouse: {},
  mapping: null,
  lastPulledAt: null,
});

function api(
  copies = [copyFixture()],
  create: () => unknown = () => ({ items: [copyFixture({ status: "preparing" })] }),
) {
  return mockApi({
    "GET /v1/stores": () => stores,
    "GET /v1/listing-copies": () => ({ items: copies, next_cursor: null }),
    "POST /v1/listing-copies": create,
    [`POST /v1/listing-copies/${COPY_ID}/cancel`]: () => copyFixture({ status: "cancelled" }),
    "GET /v1/listing-drafts": () => ({ items: [draftItem()], next_cursor: null }),
    "GET /v1/listings": () => ({
      items: [
        listing("01JLISTING0000000000000001", "5101", "Kaos Polos Katun"),
        listing("01JLISTING0000000000000002", "5101", "Kaos Polos Katun"),
        listing("01JLISTING0000000000000003", "5102", "Topi Rajut Wol"),
      ],
      next_cursor: null,
    }),
  });
}

describe("CopiesView (FR-PRD-13)", () => {
  beforeEach(() => setUrl("/listing/salin"));

  it("shows each copy with its progress and opens its drafts", async () => {
    const calls = api([
      copyFixture(),
      copyFixture({
        id: "01JCOPY0000000000000000002",
        status: "preparing",
        itemsDrafted: 3,
        itemsSkipped: 0,
        itemsFailed: 0,
        failures: [],
        drafts: {},
      }),
    ]);
    const user = userEvent.setup();
    renderApp(<CopiesView />);

    expect(await screen.findByText("Siap ditinjau")).toBeInTheDocument();
    expect(screen.getByText("10 draf · 1 dilewati · 1 gagal")).toBeInTheDocument();
    expect(screen.getByText("8 perlu ditinjau")).toBeInTheDocument();
    expect(screen.getAllByText(/Seluruh toko · harga 10%/)).toHaveLength(2);
    expect(screen.getByText("3 dari 12 produk disiapkan")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Kemajuan persiapan draf" })).toBeInTheDocument();
    await user.click(screen.getByText("1 produk tidak bisa disiapkan"));
    expect(screen.getByText(/Produk tidak ditemukan di Shopee/)).toBeInTheDocument();

    // a copy still preparing can be stopped
    await user.click(screen.getByRole("button", { name: "Hentikan" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(true));

    await user.click(screen.getByRole("button", { name: "Tinjau draf" }));
    expect(currentUrl()).toBe(`/listing/salin?tab=draf&copy=${COPY_ID}`);
    expect((await screen.findAllByText("Kaos Polos Katun Combed 30s Unisex")).length).toBeGreaterThan(0);
  });

  it("copies chosen products to a store with a price change, once", async () => {
    const calls = api([]);
    const user = userEvent.setup();
    renderApp(<CopiesView />);
    await user.click((await screen.findAllByRole("button", { name: "Salin listing" }))[0]!);
    const dialog = await screen.findByRole("dialog");

    // nothing chosen yet: said next to each field, nothing sent
    await user.click(within(dialog).getByRole("button", { name: "Mulai salin" }));
    expect(within(dialog).getByText("Pilih toko asal.")).toBeInTheDocument();
    expect(within(dialog).getByText("Pilih paling sedikit satu toko tujuan.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("combobox", { name: "Toko asal" }));
    await user.click(await screen.findByRole("option", { name: "Toko Rina Shopee" }));
    // manual sales channels are no marketplace and cannot be a target
    expect(within(dialog).queryByRole("checkbox", { name: "WhatsApp" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByText("Pilih produk"));
    const items = await within(dialog).findByRole("list", { name: "Produk toko asal" });
    // one row per marketplace item, not per variant
    expect(within(items).getAllByRole("checkbox")).toHaveLength(2);
    await user.click(within(items).getByRole("checkbox", { name: "Kaos Polos Katun" }));
    expect(within(dialog).getByText("1 produk dipilih.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: "Toko Rina TTS" }));
    expect(within(dialog).getByText(/Toko Rina TTS masih mode uji berdampingan/)).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Ubah harga"));
    await user.type(within(dialog).getByLabelText("Ubah harga"), "-95");
    await user.click(within(dialog).getByRole("button", { name: "Mulai salin" }));
    expect(within(dialog).getByText("Isi angka dari -90 sampai 500.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Ubah harga"));
    await user.type(within(dialog).getByLabelText("Ubah harga"), "10");
    await user.click(within(dialog).getByRole("button", { name: "Mulai salin" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const post = calls.filter((c) => c.method === "POST");
    expect(post).toHaveLength(1);
    expect(post[0]?.body).toEqual({
      sourceStoreId: SHOPEE_STORE,
      listingIds: ["01JLISTING0000000000000002"],
      targetStoreIds: [TIKTOK_STORE],
      priceChangePercent: 10,
      skipListed: true,
    });
    expect(post[0]?.headers?.["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText("Menyiapkan 1 salinan. Draf muncul sedikit demi sedikit.")).toBeInTheDocument();
  });

  it("shows the api's refusal in the dialog", async () => {
    api([], () => problem(422, "store.not_active", "Toko tujuan belum terhubung."));
    const user = userEvent.setup();
    renderApp(<CopiesView />);
    await user.click((await screen.findAllByRole("button", { name: "Salin listing" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Toko asal" }));
    await user.click(await screen.findByRole("option", { name: "Toko Rina Shopee" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "Toko Rina TTS" }));
    await user.click(within(dialog).getByRole("button", { name: "Mulai salin" }));
    expect(await within(dialog).findByText("Toko tujuan belum terhubung.")).toBeInTheDocument();
  });

  it("shows copies but no copy button to users who may only look", async () => {
    api();
    renderApp(<CopiesView />, { me: testMe(["catalog:read"]) });
    expect(await screen.findByText("Siap ditinjau")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salin listing" })).not.toBeInTheDocument();
  });
});
