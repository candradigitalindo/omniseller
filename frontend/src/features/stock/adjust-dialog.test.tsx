import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { mockApi, problem, renderApp } from "@/test/render";
import { AdjustStockDialog } from "./adjust-dialog";
import type { StockRow, Warehouse } from "./stock-meta";

const jakarta: Warehouse = {
  id: "01JWH00000000000000000000A",
  code: "JKT",
  name: "Gudang Jakarta",
  isDefault: true,
  active: true,
  address: {},
  createdAt: "2026-09-01T00:00:00.000Z",
};

const row: StockRow = {
  id: "01JVARIANT0000000000000001",
  productId: "01JPRODUCT0000000000000001",
  sku: "KAOS-HTM-L",
  name: "Hitam, L",
  productName: "Kaos Polos",
  imageUrl: null,
  status: "active",
  available: 1,
  established: true,
  warehouses: [
    {
      warehouseId: jakarta.id,
      onHand: 3,
      reserved: 2,
      buffer: 0,
      damaged: 0,
      available: 1,
      minStock: null,
      binLocation: null,
      stockSetAt: "2026-09-02T00:00:00.000Z",
    },
  ],
  push: [],
};

function open(onClose = vi.fn()) {
  renderApp(<AdjustStockDialog open row={row} warehouses={[jakarta]} warehouseId={null} onClose={onClose} />);
  return onClose;
}

describe("AdjustStockDialog", () => {
  it("refuses to take more than is on hand before asking the api", async () => {
    const calls = mockApi({});
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("radio", { name: /Tambah atau kurangi/ }));
    await user.type(screen.getByLabelText("Selisih"), "-5");
    expect(screen.getByText("Stok fisik: 3 → -2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Simpan penyesuaian" }));

    expect(await screen.findByText("Stok fisik hanya 3; tidak bisa dikurangi sebanyak itu.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("asks for a note when the reason is Lainnya", async () => {
    const calls = mockApi({});
    const user = userEvent.setup();
    open();
    await user.type(screen.getByLabelText("Jumlah hasil hitung"), "4");
    await user.click(screen.getByRole("combobox", { name: "Alasan" }));
    await user.click(await screen.findByRole("option", { name: "Lainnya" }));
    await user.click(screen.getByRole("button", { name: "Simpan penyesuaian" }));
    expect(await screen.findByText("Tulis catatan untuk alasan Lainnya.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("sends a counted quantity for the variant and warehouse", async () => {
    const calls = mockApi({
      "POST /v1/inventory/adjustments": () => ({
        items: [
          {
            variantId: row.id,
            warehouseId: jakarta.id,
            onHandBefore: 3,
            onHandAfter: 2,
            available: 0,
            changed: true,
            movementId: "01JMOVE0000000000000000001",
          },
        ],
      }),
    });
    const user = userEvent.setup();
    const onClose = open();

    await user.type(screen.getByLabelText("Jumlah hasil hitung"), "2");
    await user.click(screen.getByRole("button", { name: "Simpan penyesuaian" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls[0]?.body).toEqual({
      lines: [{ variantId: row.id, warehouseId: jakarta.id, mode: "set", quantity: 2 }],
      reason: "correction",
      note: null,
    });
  });

  it("shows the api's refusal in the form", async () => {
    mockApi({
      "POST /v1/inventory/adjustments": () =>
        problem(409, "stock.insufficient", "Stok fisik tinggal 1; tidak cukup untuk dikurangi 2."),
    });
    const user = userEvent.setup();
    const onClose = open();
    await user.type(screen.getByLabelText("Jumlah hasil hitung"), "1");
    await user.click(screen.getByRole("button", { name: "Simpan penyesuaian" }));
    expect(await screen.findByText("Stok fisik tinggal 1; tidak cukup untuk dikurangi 2.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
