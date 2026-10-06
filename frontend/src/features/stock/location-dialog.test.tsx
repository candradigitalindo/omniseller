import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type ApiCall, mockApi, problem, renderApp } from "@/test/render";
import { JKT, SBY } from "./fixtures";
import { LocationDialog } from "./location-dialog";
import type { StockRow, Warehouse } from "./stock-meta";

const warehouse = (id: string, name: string, active = true): Warehouse => ({
  id,
  code: name.slice(7, 10).toUpperCase(),
  name,
  isDefault: id === JKT,
  active,
  address: {},
  createdAt: "2026-09-01T00:00:00.000Z",
});
const BDG = "01JWAREHOUSE00000000000003";
const WAREHOUSES = [
  warehouse(JKT, "Gudang Jakarta"),
  warehouse(SBY, "Gudang Surabaya"),
  warehouse(BDG, "Gudang Bandung", false),
];

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

const saved = (warehouseId: string) => ({
  variantId: ROW.id,
  warehouseId,
  onHand: 0,
  reserved: 0,
  buffer: 0,
  damaged: 0,
  available: 0,
  minStock: null,
  binLocation: null,
  stockSetAt: null,
});

function open(onClose = vi.fn()) {
  renderApp(<LocationDialog row={ROW} warehouses={WAREHOUSES} onClose={onClose} />);
  const group = (name: string) => within(screen.getByRole("group", { name }));
  return { onClose, jakarta: group("Gudang Jakarta"), surabaya: group("Gudang Surabaya") };
}

const puts = (calls: ApiCall[]) => calls.filter((c) => c.method === "PUT");

describe("Atur minimum & rak", () => {
  it("shows every active warehouse, filled from the stock there", () => {
    mockApi({});
    const { jakarta, surabaya } = open();
    expect(jakarta.getByLabelText("Stok minimum")).toHaveValue("5");
    expect(jakarta.getByLabelText("Lokasi rak")).toHaveValue("A-01-03");
    expect(surabaya.getByLabelText("Stok minimum")).toHaveValue("");
    expect(surabaya.getByLabelText("Lokasi rak")).toHaveValue("");
    expect(screen.queryByRole("group", { name: "Gudang Bandung" })).not.toBeInTheDocument();
  });

  it("sends only the warehouses and fields that changed, an emptied field as none", async () => {
    const calls = mockApi({
      [`PUT /v1/inventory/${ROW.id}/warehouses/${JKT}`]: () => saved(JKT),
      [`PUT /v1/inventory/${ROW.id}/warehouses/${SBY}`]: () => saved(SBY),
    });
    const user = userEvent.setup();
    const { onClose, jakarta, surabaya } = open();

    await user.clear(jakarta.getByLabelText("Stok minimum"));
    await user.type(surabaya.getByLabelText("Lokasi rak"), " B-02 ");
    await user.click(screen.getByRole("button", { name: "Simpan" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(puts(calls).map((c) => [c.path, c.body])).toEqual([
      [`/v1/inventory/${ROW.id}/warehouses/${JKT}`, { minStock: null }],
      [`/v1/inventory/${ROW.id}/warehouses/${SBY}`, { binLocation: "B-02" }],
    ]);
    expect(await screen.findByText("Pengaturan KAOS-HTM-L disimpan.")).toBeInTheDocument();
  });

  it("checks the numbers before asking the api, and says when nothing changed", async () => {
    const calls = mockApi({});
    const user = userEvent.setup();
    const { onClose, surabaya } = open();

    await user.click(screen.getByRole("button", { name: "Simpan" }));
    expect(await screen.findByText("Belum ada yang diubah.")).toBeInTheDocument();

    await user.type(surabaya.getByLabelText("Stok minimum"), "2,5");
    await user.click(screen.getByRole("button", { name: "Simpan" }));
    expect(await surabaya.findByText("Gunakan bilangan bulat 0 atau lebih.")).toBeInTheDocument();
    expect(surabaya.getByLabelText("Stok minimum")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Belum ada yang diubah.")).not.toBeInTheDocument();

    await user.clear(surabaya.getByLabelText("Stok minimum"));
    await user.type(surabaya.getByLabelText("Stok minimum"), "20000000");
    await user.click(screen.getByRole("button", { name: "Simpan" }));
    expect(await surabaya.findByText("Jumlah terlalu besar.")).toBeInTheDocument();

    // typing again clears the message of that warehouse
    await user.type(surabaya.getByLabelText("Stok minimum"), "{Backspace}");
    expect(surabaya.queryByText("Jumlah terlalu besar.")).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("puts the api's refusal under the warehouse it concerns, keeping the ones saved before", async () => {
    const calls = mockApi({
      [`PUT /v1/inventory/${ROW.id}/warehouses/${JKT}`]: () => saved(JKT),
      [`PUT /v1/inventory/${ROW.id}/warehouses/${SBY}`]: () =>
        problem(422, "validation.failed", "Data tidak valid.", {
          errors: [{ path: "binLocation", message: "Lokasi rak terlalu panjang." }],
        }),
    });
    const user = userEvent.setup();
    const { onClose, jakarta, surabaya } = open();

    await user.clear(jakarta.getByLabelText("Lokasi rak"));
    await user.type(jakarta.getByLabelText("Lokasi rak"), "A-02");
    await user.type(surabaya.getByLabelText("Lokasi rak"), "RAK-PANJANG");
    await user.click(screen.getByRole("button", { name: "Simpan" }));

    expect(await surabaya.findByText("Lokasi rak terlalu panjang.")).toBeInTheDocument();
    expect(puts(calls)).toHaveLength(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says which warehouse failed when the api names no field", async () => {
    mockApi({
      [`PUT /v1/inventory/${ROW.id}/warehouses/${JKT}`]: () =>
        problem(404, "warehouse.not_found", "Gudang tidak ditemukan."),
    });
    const user = userEvent.setup();
    const { jakarta } = open();

    await user.type(jakarta.getByLabelText("Stok minimum"), "0");
    await user.click(screen.getByRole("button", { name: "Simpan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Gudang Jakarta: Gudang tidak ditemukan.");
  });
});
