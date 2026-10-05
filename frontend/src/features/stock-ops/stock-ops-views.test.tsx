import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl, testRouter } from "@/test/navigation";
import { mockApi, renderApp, testMe } from "@/test/render";
import { CountsView } from "./counts-view";
import { COUNT_ID, countFixture, JAKARTA, SURABAYA, TRANSFER_ID, transferFixture } from "./fixtures";
import { TransfersView } from "./transfers-view";

const warehouses = {
  items: [
    { ...JAKARTA, isDefault: true, active: true, address: {}, createdAt: "2026-09-01T00:00:00.000Z" },
    { ...SURABAYA, isDefault: false, active: true, address: {}, createdAt: "2026-09-01T00:00:00.000Z" },
  ],
};

describe("CountsView", () => {
  beforeEach(() => setUrl("/stok/opname"));

  it("starts a blind full count in the default warehouse and opens it", async () => {
    const calls = mockApi({
      "GET /v1/stock-counts": () => ({ items: [countFixture()], next_cursor: null }),
      "GET /v1/warehouses": () => warehouses,
      "POST /v1/stock-counts": () => countFixture(),
    });
    const user = userEvent.setup();
    renderApp(<CountsView />);

    expect((await screen.findAllByText("OP-2610-0001")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Mulai opname" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /Sebagian/ }));
    await user.click(within(dialog).getByRole("button", { name: "Mulai menghitung" }));
    expect(await within(dialog).findByText("Isi awalan rak atau pilih SKU untuk opname sebagian.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Awalan lokasi rak"), "A-01");
    await user.click(within(dialog).getByRole("button", { name: "Mulai menghitung" }));
    await waitFor(() => expect(testRouter.push).toHaveBeenCalledWith(`/stok/opname/${COUNT_ID}`));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      warehouseId: JAKARTA.id,
      mode: "partial",
      binPrefix: "A-01",
      blind: true,
      note: null,
    });
  });
});

describe("TransfersView", () => {
  beforeEach(() => setUrl("/stok/transfer"));

  function api(transfer = transferFixture()) {
    return mockApi({
      "GET /v1/stock-transfers": () => ({ items: [transfer], next_cursor: null }),
      [`GET /v1/stock-transfers/${TRANSFER_ID}`]: () => transfer,
      "GET /v1/warehouses": () => warehouses,
      "GET /v1/stock-transfers/destinations": () => ({ items: [JAKARTA, SURABAYA] }),
      "GET /v1/inventory": () => ({
        items: [
          {
            id: "01JVARIANT0000000000000001",
            productId: "p",
            sku: "KAOS-HTM-L",
            name: "Hitam, L",
            productName: "Kaos Polos",
            imageUrl: null,
            status: "active",
            available: 12,
            established: true,
            warehouses: [
              {
                warehouseId: JAKARTA.id,
                onHand: 12,
                reserved: 0,
                buffer: 0,
                damaged: 0,
                available: 12,
                minStock: null,
                binLocation: null,
                stockSetAt: null,
              },
            ],
            push: [],
          },
        ],
        next_cursor: null,
      }),
      "POST /v1/stock-transfers": () => transfer,
      [`POST /v1/stock-transfers/${TRANSFER_ID}/send`]: () => ({ ...transfer, status: "sent" }),
      [`POST /v1/stock-transfers/${TRANSFER_ID}/receive`]: () => ({ ...transfer, status: "received" }),
    });
  }

  it("creates a draft once, with a key that makes a retry harmless", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<TransfersView />);

    await user.click(await screen.findByRole("button", { name: "Buat transfer" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Dari gudang" }));
    await user.click(await screen.findByRole("option", { name: "Gudang Jakarta" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Ke gudang" }));
    await user.click(await screen.findByRole("option", { name: "Gudang Surabaya" }));
    await user.type(within(dialog).getByLabelText("Tambah SKU"), "kaos");
    await user.click(await within(dialog).findByRole("button", { name: /KAOS-HTM-L/ }));
    const qty = within(dialog).getByLabelText("Jumlah KAOS-HTM-L");
    await user.clear(qty);
    await user.type(qty, "20");
    await user.click(within(dialog).getByRole("button", { name: "Simpan draf" }));
    expect(await within(dialog).findByText("KAOS-HTM-L hanya tersedia 12 di gudang asal.")).toBeInTheDocument();
    await user.clear(qty);
    await user.type(qty, "5");
    await user.click(within(dialog).getByRole("button", { name: "Simpan draf" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/stock-transfers")).toBe(true));
    const post = calls.find((c) => c.method === "POST" && c.path === "/v1/stock-transfers")!;
    expect(post.body).toEqual({
      fromWarehouseId: JAKARTA.id,
      toWarehouseId: SURABAYA.id,
      note: null,
      lines: [{ variantId: "01JVARIANT0000000000000001", qty: 5 }],
    });
    expect(post.headers?.["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sends a draft from the origin", async () => {
    setUrl(`/stok/transfer?id=${TRANSFER_ID}`);
    const calls = api();
    const user = userEvent.setup();
    renderApp(<TransfersView />);
    await user.click(await screen.findByRole("button", { name: "Kirim barang" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/send"))).toBe(true));
  });

  it("receives at the destination, listing only what did not arrive in full", async () => {
    setUrl(`/stok/transfer?id=${TRANSFER_ID}`);
    const calls = api(transferFixture({ status: "sent" }));
    const user = userEvent.setup();
    renderApp(<TransfersView />);

    const got = await screen.findByLabelText("Jumlah diterima KAOS-PTH-L");
    await user.clear(got);
    await user.type(got, "1");
    await user.click(screen.getByRole("button", { name: "Terima barang" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/receive"))).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/receive"))?.body).toEqual({
      lines: [{ lineId: "01JTLINE000000000000000002", receivedQty: 1 }],
      note: null,
    });
  });

  it("offers receiving only to the destination's people", async () => {
    setUrl(`/stok/transfer?id=${TRANSFER_ID}`);
    api(transferFixture({ status: "sent" }));
    const me = { ...testMe(), warehouseScope: [JAKARTA.id] };
    renderApp(<TransfersView />, { me });
    expect(await screen.findByRole("button", { name: "Batalkan transfer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terima barang" })).toBeNull();
  });
});
