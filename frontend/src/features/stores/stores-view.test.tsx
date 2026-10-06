import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mockApi, renderApp, testMe } from "@/test/render";
import type { Store } from "./store-meta";
import { StoresView } from "./stores-view";

const leaveTo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/navigate", () => ({ leaveTo }));

function store(over: Partial<Store>): Store {
  return {
    id: "01JSTORE000000000000000001",
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
    defaultWarehouseId: null,
    connectedAt: "2026-10-01T00:00:00.000Z",
    disconnectedAt: null,
    authorizationExpiresAt: null,
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

const stores = [
  store({}),
  store({
    id: "01JSTORE000000000000000002",
    channel: "tiktokshop",
    channelName: "Tokopedia & Shop",
    name: "Toko Kedua",
    status: "reauth_required",
    statusMessage: "Seller mencabut izin OmniSeller di marketplace.",
    syncMode: "read_only",
    unmappedWarehouses: 2,
  }),
];

describe("StoresView", () => {
  it("shows each store's connection and sends a lost one to the marketplace again", async () => {
    const calls = mockApi({
      "GET /v1/stores": () => ({ items: stores }),
      "POST /v1/store-authorizations": () => ({
        id: "01JAUTH0000000000000000001",
        channel: "tiktokshop",
        storeId: stores[1]!.id,
        status: "pending",
        expiresAt: "2026-10-04T16:00:00.000Z",
        callbackAt: null,
        completedAt: null,
        result: { stores: [], skipped: [], failed: [] },
        errorCode: null,
        errorMessage: null,
        createdAt: "2026-10-04T15:00:00.000Z",
        authorizeUrl: "https://services.tiktokshop.com/open/authorize?service_id=1&state=st",
      }),
    });
    const user = userEvent.setup();
    renderApp(<StoresView />);

    const lost = (await screen.findByText("Toko Kedua")).closest("article")!;
    expect(within(lost).getByText("Tokopedia & Shop")).toBeInTheDocument();
    expect(within(lost).getByText("Perlu hubungkan ulang")).toBeInTheDocument();
    expect(within(lost).getByText("Mode uji berdampingan")).toBeInTheDocument();
    expect(within(lost).getByText(/2 gudang marketplace belum dipetakan/)).toBeInTheDocument();
    expect(within(screen.getByText("Toko Utama").closest("article")!).queryByRole("button")).toBeNull();

    await user.click(within(lost).getByRole("button", { name: "Hubungkan ulang" }));
    await waitFor(() =>
      expect(leaveTo).toHaveBeenCalledWith("https://services.tiktokshop.com/open/authorize?service_id=1&state=st"),
    );
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ channel: "tiktokshop", storeId: stores[1]!.id });
  });

  it("adds a manual sales channel from the wizard", async () => {
    const calls = mockApi({
      "GET /v1/stores": () => ({ items: [] }),
      "GET /v1/channels": () => ({
        items: [
          { id: "shopee", name: "Shopee", available: true, regions: ["ID"] },
          { id: "tiktokshop", name: "Tokopedia & Shop", available: false, regions: ["ID"] },
        ],
      }),
      "POST /v1/stores/manual": (call) => store({ channel: "manual", name: (call.body as { name: string }).name }),
    });
    const user = userEvent.setup();
    renderApp(<StoresView />);

    await user.click((await screen.findAllByRole("button", { name: "Hubungkan toko" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /Tokopedia & Shop/ })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: /Penjualan langsung/ }));
    await user.type(within(dialog).getByLabelText("Nama kanal"), "WhatsApp");
    await user.click(within(dialog).getByRole("button", { name: "Tambah kanal" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/v1/stores/manual")?.body).toEqual({ name: "WhatsApp" }));
  });

  it("lets people without settings:store look but not change", async () => {
    mockApi({ "GET /v1/stores": () => ({ items: stores }) });
    renderApp(<StoresView />, { me: testMe(["order:read"]) });
    await screen.findByText("Toko Kedua");
    expect(screen.queryByRole("button", { name: "Hubungkan toko" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hubungkan ulang" })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Kelola/ })).toBeNull();
  });

  it("opens each store's page from its card", async () => {
    mockApi({ "GET /v1/stores": () => ({ items: stores }) });
    renderApp(<StoresView />);
    const link = await screen.findByRole("link", { name: `Kelola ${stores[0]!.name}` });
    expect(link).toHaveAttribute("href", `/integrasi/${stores[0]!.id}`);
  });
});
