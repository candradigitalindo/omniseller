import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl } from "@/test/navigation";
import { mockApi, problem, renderApp, testMe } from "@/test/render";
import { WarehousesView } from "./warehouses-view";

const JKT = {
  id: "W1",
  code: "JKT",
  name: "Gudang Jakarta",
  isDefault: true,
  active: true,
  address: { line1: "Jl. Melati 5", province: "DKI Jakarta" },
  createdAt: "2026-10-01T00:00:00.000Z",
};
const SBY = {
  id: "W2",
  code: "SBY",
  name: "Gudang Surabaya",
  isDefault: false,
  active: true,
  address: {},
  createdAt: "2026-10-02T00:00:00.000Z",
};

function api(over: Record<string, () => unknown> = {}) {
  return mockApi({
    "GET /v1/warehouses": () => ({ items: [JKT, SBY] }),
    "GET /v1/warehouses/W2": () =>
      new Response(JSON.stringify(SBY), { headers: { "content-type": "application/json", etag: '"7"' } }),
    "PATCH /v1/warehouses/W2": () => ({ ...SBY, name: "Gudang Surabaya Timur" }),
    "POST /v1/warehouses": () => ({ ...SBY, id: "W3", code: "BDG", name: "Gudang Bandung" }),
    "POST /v1/warehouses/W2/default": () => ({ ...SBY, isDefault: true }),
    "DELETE /v1/warehouses/W2": () =>
      problem(409, "warehouse.has_stock", "Gudang masih punya stok. Pindahkan dulu stoknya."),
    "GET /v1/stores": () => ({
      items: [{ id: "S1", name: "Toko Rina TTS", channel: "tiktokshop", status: "active", syncMode: "live" }],
    }),
    "GET /v1/stores/S1/channel-warehouses": () => ({
      items: [
        {
          id: "CW1",
          externalWarehouseId: "730001",
          name: "Warehouse Bandung",
          kind: "seller",
          mappingStatus: "unmapped",
          warehouseId: null,
          isDefault: false,
          active: true,
          address: null,
          lastSeenAt: "2026-10-06T00:00:00.000Z",
        },
        {
          id: "CW2",
          externalWarehouseId: "730002",
          name: "Gudang Tokopedia",
          kind: "fulfillment",
          mappingStatus: "marketplace_managed",
          warehouseId: null,
          isDefault: false,
          active: true,
          address: null,
          lastSeenAt: "2026-10-06T00:00:00.000Z",
        },
      ],
    }),
    "PUT /v1/stores/S1/channel-warehouses/CW1": () => ({}),
    ...over,
  });
}

describe("WarehousesView (L20)", () => {
  beforeEach(() => setUrl("/stok/gudang"));

  it("shows warehouses with their address and asks for a missing one", async () => {
    api();
    renderApp(<WarehousesView />);
    expect(await screen.findByText("Gudang Jakarta")).toBeInTheDocument();
    expect(screen.getByText("Jl. Melati 5")).toBeInTheDocument();
    expect(screen.getByText(/Alamat belum diisi/)).toBeInTheDocument();
  });

  it("adds a warehouse with a checked code", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<WarehousesView />);
    await user.click(await screen.findByRole("button", { name: "Tambah gudang" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Kode"), "b");
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(within(dialog).getByText("Isi 2 sampai 20 huruf, angka, atau tanda hubung.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Kode"), "dg");
    await user.type(within(dialog).getByLabelText("Nama gudang"), "Gudang Bandung");
    await user.type(within(dialog).getByLabelText("Kota atau kabupaten"), "Kota Bandung");
    await user.click(within(dialog).getByRole("switch", { name: "Jadikan gudang utama" }));
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST" && c.path === "/v1/warehouses")?.body).toEqual({
        code: "BDG",
        name: "Gudang Bandung",
        address: { city: "Kota Bandung" },
        isDefault: true,
      }),
    );
  });

  it("edits with If-Match from the warehouse's ETag", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<WarehousesView />);
    const card = (await screen.findByText("Gudang Surabaya")).closest("[data-slot=card]") as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Ubah" }));
    const dialog = await screen.findByRole("dialog");
    const name = await within(dialog).findByLabelText("Nama gudang");
    await user.clear(name);
    await user.type(name, "Gudang Surabaya Timur");
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.headers?.["if-match"]).toBe('"7"'));
  });

  it("says why a warehouse cannot be deleted", async () => {
    api();
    const user = userEvent.setup();
    renderApp(<WarehousesView />);
    const card = (await screen.findByText("Gudang Surabaya")).closest("[data-slot=card]") as HTMLElement;
    // the default warehouse has neither "make default" nor "delete"
    const jakarta = screen.getByText("Gudang Jakarta").closest("[data-slot=card]") as HTMLElement;
    expect(within(jakarta).queryByRole("button", { name: "Hapus" })).not.toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Hapus" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Hapus" }));
    expect(await within(dialog).findByText("Gudang masih punya stok. Pindahkan dulu stoknya.")).toBeInTheDocument();
  });

  it("maps a marketplace warehouse and warns while one is unmapped", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<WarehousesView />);
    expect(await screen.findByText(/Sinkron stok toko ini dijeda/)).toBeInTheDocument();
    expect(screen.getByText("Tidak perlu dipetakan")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Petakan Warehouse Bandung ke" }));
    await user.click(await screen.findByRole("option", { name: "Gudang Surabaya" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ warehouseId: "W2" }));
  });

  it("only shows warehouses to users who may not change them", async () => {
    api();
    renderApp(<WarehousesView />, { me: testMe(["inventory:read"]) });
    expect(await screen.findByText("Gudang Jakarta")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Tambah gudang" })).not.toBeInTheDocument();
    expect(screen.queryByText("Gudang marketplace")).not.toBeInTheDocument();
  });
});
