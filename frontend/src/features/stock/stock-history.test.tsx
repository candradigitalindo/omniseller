import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Permission } from "@/lib/session";
import { currentUrl, setUrl } from "@/test/navigation";
import { ALL_PERMISSIONS, type ApiCall, mockApi, renderApp, testMe } from "@/test/render";
import { JKT, movement, SBY } from "./fixtures";
import type { Movement } from "./history-meta";
import { StockHistoryView } from "./stock-history";
import type { StockRow, Warehouse } from "./stock-meta";

const VARIANT = "01JVARIANT0000000000000001";
const ME = testMe().user.id;
const BUDI = "01JUSER0000000000000000BUD";

const warehouse = (id: string, name: string): Warehouse => ({
  id,
  code: name.slice(7, 10).toUpperCase(),
  name,
  isDefault: id === JKT,
  active: true,
  address: {},
  createdAt: "2026-09-01T00:00:00.000Z",
});
const WAREHOUSES = [warehouse(JKT, "Gudang Jakarta"), warehouse(SBY, "Gudang Surabaya")];

const cell = (warehouseId: string, onHand: number, available: number) => ({
  warehouseId,
  onHand,
  reserved: onHand - available,
  buffer: 0,
  damaged: 0,
  available,
  minStock: null,
  binLocation: null,
  stockSetAt: "2026-09-02T00:00:00.000Z",
});

const ROW: StockRow = {
  id: VARIANT,
  productId: "01JPRODUCT0000000000000001",
  sku: "KAOS-HTM-L",
  name: "Hitam, L",
  productName: "Kaos Polos",
  imageUrl: null,
  status: "active",
  available: 122,
  established: true,
  warehouses: [cell(JKT, 118, 92), cell(SBY, 30, 30)],
  push: [],
};

const MOVES: Movement[] = [
  movement({
    id: "01JMOVE0000000000000000003",
    type: "order_ship",
    onHandDelta: -2,
    reservedDelta: -2,
    onHandAfter: 118,
    reservedAfter: 26,
    availableAfter: 92,
    referenceType: "order_item",
    referenceId: "01JORDERITEM00000000000001",
    document: { type: "order", id: "01JORDER000000000000000001", number: "SP-2609-88123" },
    createdAt: "2026-10-06T03:15:00.000Z",
  }),
  movement({
    id: "01JMOVE0000000000000000002",
    warehouseId: SBY,
    type: "adjustment",
    onHandDelta: 10,
    onHandAfter: 30,
    availableAfter: 30,
    reason: "correction",
    reasonLabel: "Koreksi",
    note: "hitung ulang rak",
    actorUserId: ME,
    createdAt: "2026-10-05T07:00:00.000Z",
  }),
  movement({
    id: "01JMOVE0000000000000000001",
    type: "transfer_out",
    onHandDelta: -3,
    onHandAfter: 120,
    reservedAfter: 24,
    availableAfter: 96,
    referenceType: "stock_transfer_line",
    referenceId: "01JTRANSFERLINE00000000001",
    document: { type: "stock_transfer", id: "01JTRANSFER000000000000001", number: "TF-2610-0001" },
    note: "Transfer TF-2610-0001",
    actorUserId: BUDI,
    createdAt: "2026-10-04T02:00:00.000Z",
  }),
];

function api(
  pages: (q: Record<string, string>) => { items: Movement[]; next_cursor: string | null } = () => ({
    items: MOVES,
    next_cursor: null,
  }),
) {
  return mockApi({
    "GET /v1/warehouses": () => ({ items: WAREHOUSES }),
    "GET /v1/inventory": (c) => ({
      items: c.query.q && "KAOS-HTM-L".includes(c.query.q.toUpperCase()) ? [ROW] : [],
      next_cursor: null,
    }),
    "GET /v1/inventory/movements": (c) => pages(c.query),
    "GET /v1/users": () => ({
      items: [
        {
          id: BUDI,
          name: "Budi Santoso",
          email: "budi@example.test",
          status: "active",
          roles: [],
          storeIds: null,
          warehouseIds: null,
          lastLoginAt: null,
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      next_cursor: null,
    }),
  });
}

const movementCalls = (calls: ApiCall[]) => calls.filter((c) => c.path === "/v1/inventory/movements");
const without = (...drop: Permission[]) => testMe(ALL_PERMISSIONS.filter((p) => !drop.includes(p)));

beforeEach(() => setUrl(`/stok/riwayat?variant=${VARIANT}&sku=KAOS-HTM-L`));

describe("Riwayat Stok (L21)", () => {
  it("asks for a SKU first and opens the card of the one picked", async () => {
    setUrl("/stok/riwayat");
    const calls = api();
    const user = userEvent.setup();
    renderApp(<StockHistoryView />);

    expect(screen.getByText("Pilih SKU untuk melihat kartu stoknya")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Cari SKU"), "kaos");
    expect(await screen.findByRole("button", { name: /KAOS-HTM-L/ })).toBeInTheDocument();
    // results belong to the text in the box: typing on hides them until the new search answers
    await user.type(screen.getByLabelText("Cari SKU"), "x");
    expect(screen.queryByRole("list", { name: "Hasil pencarian SKU" })).not.toBeInTheDocument();
    expect(await screen.findByText("Tidak ada SKU yang cocok.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Cari SKU"), "{Backspace}");
    await user.click(await screen.findByRole("button", { name: /KAOS-HTM-L/ }));

    expect(currentUrl()).toBe(`/stok/riwayat?variant=${VARIANT}&sku=KAOS-HTM-L`);
    await waitFor(() => expect(movementCalls(calls)).toHaveLength(1));
    expect(movementCalls(calls)[0]?.query).toEqual({ variantId: VARIANT, limit: "50" });
    expect(screen.getByLabelText("Cari SKU lain")).toHaveValue("");
  });

  it("shows each movement: what moved it, the change, the stock after, its document, and who", async () => {
    api();
    renderApp(<StockHistoryView />);
    const table = await screen.findByRole("table");

    // the stock now in each warehouse
    expect(screen.getByText("Kaos Polos · Hitam, L", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Sekarang fisik 118 · siap jual 92")).toBeInTheDocument();
    expect(screen.getByText("Sekarang fisik 30 · siap jual 30")).toBeInTheDocument();

    const [, shipped, adjusted, sent] = within(table).getAllByRole("row");
    expect(within(shipped!).getByText("Dikirim")).toBeInTheDocument();
    expect(within(shipped!).getByText("Gudang Jakarta")).toBeInTheDocument();
    expect(within(shipped!).getAllByText("-2")).toHaveLength(2);
    expect(within(shipped!).getAllByText("-2")[0]).toHaveClass("text-danger");
    expect(within(shipped!).getByText("Fisik 118")).toBeInTheDocument();
    expect(within(shipped!).getByText("Siap jual 92")).toBeInTheDocument();
    expect(within(shipped!).getByRole("link", { name: "Buka pesanan SP-2609-88123" })).toHaveAttribute(
      "href",
      "/pesanan?id=01JORDER000000000000000001",
    );
    expect(within(shipped!).getByText("Sistem")).toBeInTheDocument();

    expect(within(adjusted!).getByText("Penyesuaian")).toBeInTheDocument();
    expect(within(adjusted!).getByText("Gudang Surabaya")).toBeInTheDocument();
    expect(within(adjusted!).getByText("+10")).toHaveClass("text-success");
    expect(within(adjusted!).getByText("Koreksi · hitung ulang rak")).toBeInTheDocument();
    expect(within(adjusted!).getByText("Anda")).toBeInTheDocument();

    expect(within(sent!).getByRole("link", { name: "Buka transfer TF-2610-0001" })).toHaveAttribute(
      "href",
      "/stok/transfer?id=01JTRANSFER000000000000001",
    );
    // the api's own note only repeats the document
    expect(within(sent!).queryByText("Transfer TF-2610-0001")).not.toBeInTheDocument();
    expect(await within(sent!).findByText("Budi Santoso")).toBeInTheDocument();
  });

  it("filters by warehouse and kind through the URL", async () => {
    setUrl(`/stok/riwayat?variant=${VARIANT}&sku=KAOS-HTM-L&warehouse=${JKT}&type=order_ship`);
    const calls = api(() => ({ items: [MOVES[0]!], next_cursor: null }));
    const user = userEvent.setup();
    renderApp(<StockHistoryView />);
    const table = await screen.findByRole("table");

    expect(movementCalls(calls)[0]?.query).toEqual({
      variantId: VARIANT,
      warehouseId: JKT,
      type: "order_ship",
      limit: "50",
    });
    // one warehouse: no warehouse column, and only its stock now
    expect(within(table).queryByRole("columnheader", { name: "Gudang" })).not.toBeInTheDocument();
    expect(screen.queryByText("Sekarang fisik 30 · siap jual 30")).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Jenis perubahan" }));
    await user.click(await screen.findByRole("option", { name: "Penyesuaian" }));
    expect(currentUrl()).toContain("type=adjustment");
    await user.click(screen.getByRole("combobox", { name: "Jenis perubahan" }));
    await user.click(await screen.findByRole("option", { name: "Semua jenis" }));
    expect(currentUrl()).not.toContain("type=");
    await user.click(screen.getByRole("combobox", { name: "Gudang" }));
    await user.click(await screen.findByRole("option", { name: "Semua gudang" }));
    expect(currentUrl()).toBe(`/stok/riwayat?variant=${VARIANT}&sku=KAOS-HTM-L`);
  });

  it("loads older movements with the cursor", async () => {
    const calls = api((q) =>
      q.cursor === "C1" ? { items: [MOVES[2]!], next_cursor: null } : { items: MOVES.slice(0, 2), next_cursor: "C1" },
    );
    const user = userEvent.setup();
    renderApp(<StockHistoryView />);
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Muat lebih banyak" }));
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(4));
    expect(movementCalls(calls)[1]?.query).toEqual({ variantId: VARIANT, limit: "50", cursor: "C1" });
    expect(screen.queryByRole("button", { name: "Muat lebih banyak" })).not.toBeInTheDocument();
  });

  it("draws ready to sell of the busiest warehouse and reads a point out under the pointer", async () => {
    api();
    renderApp(<StockHistoryView />);
    const line = await screen.findByRole("img", { name: "Siap jual dari 96 menjadi 92 dalam 2 perubahan" });
    expect(screen.getByText("Siap jual di Gudang Jakarta")).toBeInTheDocument();
    expect(screen.getByText("Terendah 92 · tertinggi 96")).toBeInTheDocument();
    expect(screen.getByText("Arahkan kursor atau ketuk garis untuk melihat angkanya.")).toBeInTheDocument();

    // jsdom lays nothing out: without a width the pointer reads nothing
    fireEvent.mouseMove(line, { clientX: 5 });
    expect(screen.getByText("Arahkan kursor atau ketuk garis untuk melihat angkanya.")).toBeInTheDocument();
    vi.spyOn(line, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 0, 300, 64));
    fireEvent.mouseMove(line, { clientX: 300 });
    expect(screen.getByText("6 Okt 2026, 10.15: siap jual 92")).toBeInTheDocument();
    fireEvent.mouseMove(line, { clientX: 20 });
    expect(screen.getByText("4 Okt 2026, 09.00: siap jual 96")).toBeInTheDocument();
    fireEvent.mouseLeave(line);
    expect(screen.getByText("Arahkan kursor atau ketuk garis untuk melihat angkanya.")).toBeInTheDocument();
  });

  it("names other people only for those who manage the team, and links documents only for those who may open them", async () => {
    const calls = api();
    renderApp(<StockHistoryView />, { me: without("settings:user", "inventory:transfer") });
    const table = await screen.findByRole("table");
    const sent = within(table).getAllByRole("row")[3]!;

    expect(within(sent).getByText("Anggota tim")).toBeInTheDocument();
    expect(within(sent).queryByRole("link")).not.toBeInTheDocument();
    expect(within(sent).getByText("TF-2610-0001")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/v1/users")).toBe(false);
  });

  it("marks a sale past the stock, and a movement without a document or note with a dash", async () => {
    const reserved = movement({
      id: "01JMOVE0000000000000000009",
      type: "order_reserve",
      reservedDelta: 3,
      onHandAfter: 2,
      reservedAfter: 3,
      availableAfter: -1,
      referenceType: "order_item",
      referenceId: "01JORDERITEM00000000000009",
    });
    api(() => ({ items: [reserved], next_cursor: null }));
    renderApp(<StockHistoryView />);
    const table = await screen.findByRole("table");
    const row = within(table).getAllByRole("row")[1]!;

    expect(within(row).getByText("Pesanan masuk")).toBeInTheDocument();
    expect(within(row).getByText("+3")).toHaveClass("text-success");
    expect(within(row).getByText("Siap jual -1")).toHaveClass("text-danger");
    expect(within(row).getByText("Fisik 2")).not.toHaveClass("text-danger");
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("says so to those who may not read stock, without asking the api", () => {
    const calls = api();
    renderApp(<StockHistoryView />, { me: testMe(["order:read"]) });
    expect(screen.getByText("Anda tidak punya izin melihat stok.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("says when nothing matches", async () => {
    api(() => ({ items: [], next_cursor: null }));
    renderApp(<StockHistoryView />);
    expect(await screen.findByText("Belum ada perubahan stok yang cocok.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
