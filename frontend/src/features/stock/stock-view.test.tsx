import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl } from "@/test/navigation";
import { mockApi, renderApp, testMe } from "@/test/render";
import { JKT, SBY } from "./fixtures";
import type { StockRow, Warehouse } from "./stock-meta";
import { StockView } from "./stock-view";

const warehouse = (id: string, name: string): Warehouse => ({
  id,
  code: name.slice(7, 10).toUpperCase(),
  name,
  isDefault: id === JKT,
  active: true,
  address: {},
  createdAt: "2026-09-01T00:00:00.000Z",
});

const ROW: StockRow = {
  id: "01JVARIANT0000000000000001",
  productId: "01JPRODUCT0000000000000001",
  sku: "KAOS-HTM-L",
  name: "Hitam, L",
  productName: "Kaos Polos",
  imageUrl: null,
  status: "active",
  available: 12,
  established: true,
  warehouses: [
    {
      warehouseId: JKT,
      onHand: 12,
      reserved: 0,
      buffer: 0,
      damaged: 0,
      available: 12,
      minStock: 5,
      binLocation: "A-01-03",
      stockSetAt: "2026-09-02T00:00:00.000Z",
    },
  ],
  push: [],
};

function api() {
  return mockApi({
    "GET /v1/warehouses": () => ({ items: [warehouse(JKT, "Gudang Jakarta"), warehouse(SBY, "Gudang Surabaya")] }),
    "GET /v1/inventory/summary": () => ({ skus: 1, low: 0, out: 0, negative: 0, unset: 0, value: null }),
    "GET /v1/inventory": () => ({ items: [ROW], next_cursor: null }),
  });
}

beforeEach(() => setUrl(`/stok?warehouse=${JKT}`));

describe("Stok (L19) row actions", () => {
  it("opens the stock card and the minimum and bin settings of a row", async () => {
    api();
    const user = userEvent.setup();
    renderApp(<StockView />);
    const table = await screen.findByRole("table");

    await user.click(within(table).getByRole("button", { name: "Aksi lain untuk KAOS-HTM-L" }));
    // the menu is not modal: the page behind it stays readable (a modal menu hides it with aria-hidden)
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(await screen.findByRole("menuitem", { name: "Lihat riwayat stok" })).toHaveAttribute(
      "href",
      `/stok/riwayat?variant=${ROW.id}&sku=KAOS-HTM-L&warehouse=${JKT}`,
    );
    await user.click(screen.getByRole("menuitem", { name: "Atur minimum & rak" }));
    const dialog = await screen.findByRole("dialog", { name: "Atur stok minimum dan lokasi rak" });
    expect(within(dialog).getByText("KAOS-HTM-L")).toBeInTheDocument();
    expect(
      within(within(dialog).getByRole("group", { name: "Gudang Jakarta" })).getByLabelText("Stok minimum"),
    ).toHaveValue("5");
  });

  it("reads the list again after saving the minimum", async () => {
    const calls = mockApi({
      "GET /v1/warehouses": () => ({ items: [warehouse(JKT, "Gudang Jakarta")] }),
      "GET /v1/inventory/summary": () => ({ skus: 1, low: 0, out: 0, negative: 0, unset: 0, value: null }),
      "GET /v1/inventory": () => ({ items: [ROW], next_cursor: null }),
      [`PUT /v1/inventory/${ROW.id}/warehouses/${JKT}`]: () => ({ ...ROW.warehouses[0], variantId: ROW.id }),
    });
    const user = userEvent.setup();
    renderApp(<StockView />);
    const table = await screen.findByRole("table");
    const lists = () => calls.filter((c) => c.method === "GET" && c.path === "/v1/inventory").length;
    const before = lists();

    await user.click(within(table).getByRole("button", { name: "Aksi lain untuk KAOS-HTM-L" }));
    await user.click(await screen.findByRole("menuitem", { name: "Atur minimum & rak" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Stok minimum"), "0");
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));

    await waitFor(() => expect(lists()).toBe(before + 1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("gives those who only read stock the stock card", async () => {
    api();
    renderApp(<StockView />, { me: testMe(["inventory:read"]) });
    const table = await screen.findByRole("table");

    expect(within(table).getByRole("link", { name: "Riwayat" })).toHaveAttribute(
      "href",
      `/stok/riwayat?variant=${ROW.id}&sku=KAOS-HTM-L&warehouse=${JKT}`,
    );
    expect(within(table).queryByRole("button", { name: "Sesuaikan" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: /Aksi lain/ })).not.toBeInTheDocument();
  });
});
