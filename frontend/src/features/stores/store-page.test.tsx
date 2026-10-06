import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setUrl } from "@/test/navigation";
import { type ApiCall, mockApi, renderApp, testMe } from "@/test/render";
import type { StoreDetail } from "./store-admin-meta";
import { StorePage } from "./store-page";

const leaveTo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/navigate", () => ({ leaveTo }));

const ID = "01JSTORE000000000000000001";
const JKT = "01JWAREHOUSE00000000000001";
const SBY = "01JWAREHOUSE00000000000002";

function store(over: Partial<StoreDetail> = {}): StoreDetail {
  return {
    id: ID,
    channel: "shopee",
    channelName: "Shopee",
    externalShopId: "777001",
    name: "Toko Utama",
    region: "ID",
    status: "active",
    statusReason: null,
    statusMessage: null,
    statusChangedAt: "2026-10-01T00:00:00.000Z",
    syncMode: "live",
    syncModeChangedAt: null,
    defaultWarehouseId: JKT,
    connectedAt: "2026-10-01T03:00:00.000Z",
    disconnectedAt: null,
    authorizationExpiresAt: "2027-10-01T03:00:00.000Z",
    accessTokenExpiresAt: null,
    lastTokenRefreshAt: null,
    tokenRefreshFailures: 0,
    unmappedWarehouses: 0,
    lastProductSyncAt: null,
    lastOrderSyncAt: "2026-10-04T14:58:00.000Z",
    marketplaceInfo: {},
    autoAllocate: true,
    failingSince: null,
    dataDeletion: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

const warehouse = (id: string, name: string) => ({
  id,
  code: name.slice(7, 10).toUpperCase(),
  name,
  isDefault: id === JKT,
  active: true,
  address: {},
  createdAt: "2026-09-01T00:00:00.000Z",
});

function api(s: StoreDetail, extra: Record<string, (c: ApiCall) => unknown> = {}) {
  return mockApi({
    [`GET /v1/stores/${ID}`]: () => Response.json(s, { headers: { etag: '"7"' } }),
    [`PATCH /v1/stores/${ID}`]: (c) => Response.json({ ...s, ...(c.body as object) }, { headers: { etag: '"8"' } }),
    [`POST /v1/stores/${ID}/disconnect`]: () => ({
      store: { ...s, status: "disconnected" },
      revokeUrl: s.channel === "shopee" ? "https://partner.shopeemobile.com/revoke" : null,
    }),
    "POST /v1/store-authorizations": () => ({ authorizeUrl: "https://partner.shopeemobile.com/auth?state=x" }),
    "POST /v1/inventory/resync": () => undefined,
    "GET /v1/warehouses": () => ({ items: [warehouse(JKT, "Gudang Jakarta"), warehouse(SBY, "Gudang Surabaya")] }),
    "GET /v1/stock-allocation-rules": () => ({ items: [] }),
    [`GET /v1/stores/${ID}/channel-warehouses`]: () => ({ items: [] }),
    [`GET /v1/stores/${ID}/sync-jobs`]: () => ({ items: [], next_cursor: null }),
    ...extra,
  });
}
const sent = (calls: ApiCall[], method: string) => calls.filter((c) => c.method === method);

beforeEach(() => {
  leaveTo.mockClear();
  setUrl(`/integrasi/${ID}`);
});

describe("Kelola toko: koneksi", () => {
  it("shows the connection and reconnects through the marketplace", async () => {
    const calls = api(store());
    const user = userEvent.setup();
    renderApp(<StorePage id={ID} />);

    expect(await screen.findByRole("heading", { name: "Toko Utama", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Koneksi" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Terhubung sejak")).toBeInTheDocument();
    expect(screen.getByText("Izin OmniSeller berakhir")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hubungkan ulang" }));
    await waitFor(() => expect(leaveTo).toHaveBeenCalledWith("https://partner.shopeemobile.com/auth?state=x"));
    expect(sent(calls, "POST").find((c) => c.path === "/v1/store-authorizations")?.body).toEqual({
      channel: "shopee",
      storeId: ID,
    });
  });

  it("says when calls to the marketplace keep failing", async () => {
    api(store({ failingSince: "2026-10-06T01:00:00.000Z" }));
    renderApp(<StorePage id={ID} />);
    expect(await screen.findByText(/Panggilan ke marketplace gagal sejak/)).toBeInTheDocument();
  });

  it("disconnects keeping the history, then points to revoking on the marketplace", async () => {
    const calls = api(store());
    const user = userEvent.setup();
    renderApp(<StorePage id={ID} />);
    await user.click(await screen.findByRole("button", { name: "Putuskan toko" }));
    const dialog = await screen.findByRole("dialog", { name: "Putuskan Toko Utama?" });
    expect(within(dialog).getByRole("radio", { name: /Simpan riwayat/ })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Putuskan toko" }));

    await waitFor(() => expect(sent(calls, "POST").some((c) => c.path.endsWith("/disconnect"))).toBe(true));
    expect(sent(calls, "POST").find((c) => c.path.endsWith("/disconnect"))?.body).toEqual({ keepData: true });
    expect(await within(dialog).findByRole("link", { name: /Buka halaman izin Shopee/ })).toHaveAttribute(
      "href",
      "https://partner.shopeemobile.com/revoke",
    );
  });

  it("deletes the store's data only after its name is typed", async () => {
    const calls = api(store());
    const user = userEvent.setup();
    renderApp(<StorePage id={ID} />);
    await user.click(await screen.findByRole("button", { name: "Putuskan toko" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /Hapus semua data toko/ }));
    const confirm = within(dialog).getByRole("button", { name: "Putuskan toko" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Ketik Toko Utama untuk menghapus datanya"), "Toko Utam");
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Ketik Toko Utama untuk menghapus datanya"), "a");
    await user.click(confirm);
    await waitFor(() => expect(sent(calls, "POST").some((c) => c.path.endsWith("/disconnect"))).toBe(true));
    expect(sent(calls, "POST").find((c) => c.path.endsWith("/disconnect"))?.body).toEqual({ keepData: false });
  });

  it("leaves out the end of an authorization the marketplace no longer accepts", async () => {
    api(store({ status: "reauth_required", statusMessage: "Masa izin OmniSeller di marketplace sudah habis." }));
    renderApp(<StorePage id={ID} />);
    expect(await screen.findByText("Masa izin OmniSeller di marketplace sudah habis.")).toBeInTheDocument();
    expect(screen.queryByText("Izin OmniSeller berakhir")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hubungkan ulang" })).toBeInTheDocument();
  });

  it("offers connecting again, and no disconnect, for a store already disconnected", async () => {
    api(store({ status: "disconnected", disconnectedAt: "2026-10-05T00:00:00.000Z" }));
    renderApp(<StorePage id={ID} />);
    expect(await screen.findByRole("button", { name: "Hubungkan lagi" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Putuskan toko" })).not.toBeInTheDocument();
  });
});

describe("Kelola toko: pengaturan", () => {
  beforeEach(() => setUrl(`/integrasi/${ID}?tab=pengaturan`));

  it("saves the name and the home warehouse with the version it read", async () => {
    const calls = api(store());
    const user = userEvent.setup();
    renderApp(<StorePage id={ID} />);
    const name = await screen.findByLabelText("Nama toko");
    expect(screen.getByRole("button", { name: "Simpan nama" })).toBeDisabled();
    await user.clear(name);
    expect(await screen.findByText("Isi nama toko.")).toBeInTheDocument();
    await user.type(name, "Toko Utama Jakarta");
    await user.click(screen.getByRole("button", { name: "Simpan nama" }));
    await waitFor(() => expect(sent(calls, "PATCH")).toHaveLength(1));
    expect(sent(calls, "PATCH")[0]?.body).toEqual({ name: "Toko Utama Jakarta" });
    expect(sent(calls, "PATCH")[0]?.headers?.["if-match"]).toBe('"7"');
    expect(await screen.findByText("Nama toko disimpan.")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Gudang utama" }));
    await user.click(await screen.findByRole("option", { name: "Gudang Surabaya" }));
    await waitFor(() => expect(sent(calls, "PATCH")).toHaveLength(2));
    expect(sent(calls, "PATCH")[1]?.body).toEqual({ defaultWarehouseId: SBY });
    // the next save carries the version the last one answered with
    expect(sent(calls, "PATCH")[1]?.headers?.["if-match"]).toBe('"8"');
  });

  it("turns automatic warehouse choice off, sends the stock again, and goes back to the test mode", async () => {
    const calls = api(store());
    const user = userEvent.setup();
    renderApp(<StorePage id={ID} />);
    await user.click(await screen.findByRole("switch", { name: /Alokasi gudang otomatis/ }));
    await waitFor(() => expect(sent(calls, "PATCH")).toHaveLength(1));
    expect(sent(calls, "PATCH")[0]?.body).toEqual({ autoAllocate: false });

    await user.click(screen.getByRole("button", { name: "Kirim ulang semua stok" }));
    await waitFor(() => expect(sent(calls, "POST").some((c) => c.path === "/v1/inventory/resync")).toBe(true));
    expect(sent(calls, "POST").find((c) => c.path === "/v1/inventory/resync")?.body).toEqual({ storeId: ID });

    await user.click(screen.getByRole("button", { name: "Kembali ke mode uji" }));
    const dialog = await screen.findByRole("dialog", { name: "Kembali ke mode uji berdampingan?" });
    await user.click(within(dialog).getByRole("button", { name: "Kembali ke mode uji" }));
    await waitFor(() => expect(sent(calls, "PATCH")).toHaveLength(2));
    expect(sent(calls, "PATCH")[1]?.body).toEqual({ syncMode: "read_only" });
    expect(await screen.findByText(/Toko kembali ke mode uji berdampingan/)).toBeInTheDocument();
  });

  it("sends no stock again while the store waits to be connected again", async () => {
    api(store({ status: "reauth_required" }));
    renderApp(<StorePage id={ID} />);
    expect(await screen.findByRole("button", { name: "Kirim ulang semua stok" })).toBeDisabled();
    expect(screen.getByText("Stok bisa dikirim ulang setelah toko terhubung lagi (tab Koneksi).")).toBeInTheDocument();
  });

  it("sends a store in the test mode to Migrasi Data to go live", async () => {
    api(store({ syncMode: "read_only" }));
    renderApp(<StorePage id={ID} />);
    expect(await screen.findByRole("link", { name: "Pindah ke aktif penuh" })).toHaveAttribute(
      "href",
      "/migrasi?tab=pindah",
    );
    expect(screen.queryByRole("button", { name: "Kirim ulang semua stok" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kembali ke mode uji" })).not.toBeInTheDocument();
  });

  it("gives a manual sales channel its name and home warehouse only", async () => {
    api(store({ channel: "manual", channelName: "Penjualan langsung", name: "WhatsApp" }));
    renderApp(<StorePage id={ID} />);
    expect(await screen.findByLabelText("Nama toko")).toHaveValue("WhatsApp");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByText("Mode sinkron")).not.toBeInTheDocument();
    expect(screen.queryByText("Aturan pembagian stok")).not.toBeInTheDocument();
  });

  it("says so to those who may not manage stores", () => {
    const calls = api(store());
    renderApp(<StorePage id={ID} />, { me: testMe(["order:read"]) });
    expect(screen.getByText("Anda tidak punya izin mengelola toko terhubung.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
