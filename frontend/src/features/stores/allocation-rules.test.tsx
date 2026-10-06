import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type ApiCall, mockApi, problem, renderApp } from "@/test/render";
import { AllocationRules } from "./allocation-rules";
import type { Rule, StoreDetail } from "./store-admin-meta";

const STORE = { id: "01JSTORE000000000000000001", name: "Toko Utama", channel: "shopee" } as StoreDetail;
const CW = "01JCHWH0000000000000000001";
const VARIANT = "01JVARIANT0000000000000001";

function rule(over: Partial<Rule>): Rule {
  return {
    id: "01JRULE0000000000000000001",
    storeId: STORE.id,
    channelWarehouseId: null,
    variantId: null,
    mode: "percent",
    value: 50,
    buffer: 1,
    priority: 100,
    active: true,
    variant: null,
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    ...over,
  };
}
const STOREWIDE = rule({});
const ONE_VARIANT = rule({
  id: "01JRULE0000000000000000002",
  variantId: VARIANT,
  mode: "fixed",
  value: 3,
  buffer: 0,
  variant: { sku: "KAOS-HTM-L", productName: "Kaos Polos", variantName: "Hitam, L" },
});
const IN_WAREHOUSE = rule({
  id: "01JRULE0000000000000000003",
  channelWarehouseId: CW,
  mode: "all",
  value: 0,
  active: false,
});

function api(extra: Record<string, (c: ApiCall) => unknown> = {}) {
  return mockApi({
    "GET /v1/stock-allocation-rules": () => ({ items: [STOREWIDE, ONE_VARIANT, IN_WAREHOUSE] }),
    [`GET /v1/stores/${STORE.id}/channel-warehouses`]: () => ({
      items: [
        { id: CW, name: "Gudang Sidoarjo", kind: "seller", active: true, warehouseId: null, mappingStatus: "mapped" },
        { id: "01JCHWH0000000000000000009", name: "Dikelola Shopee", kind: "fulfillment", active: true },
      ],
    }),
    "GET /v1/inventory": (c) => ({
      items: (c.query.q ?? "").toUpperCase().includes("KAOS")
        ? [{ id: VARIANT, sku: "KAOS-HTM-L", productName: "Kaos Polos", name: "Hitam, L" }]
        : [],
      next_cursor: null,
    }),
    "POST /v1/stock-allocation-rules": (c) => Response.json({ ...rule({}), ...(c.body as object) }, { status: 201 }),
    ...extra,
  });
}

async function open() {
  const user = userEvent.setup();
  renderApp(<AllocationRules store={STORE} />);
  const table = await screen.findByRole("table");
  return { user, table };
}
const writes = (calls: ApiCall[]) => calls.filter((c) => c.method !== "GET");

describe("Aturan pembagian stok", () => {
  it("lists what each rule covers and how much it shows", async () => {
    api();
    const { table } = await open();
    const [, storewide, variant, warehouse] = within(table).getAllByRole("row");
    expect(storewide).toHaveTextContent("Seluruh toko50%1100Aktif");
    expect(variant).toHaveTextContent("KAOS-HTM-L · Kaos PolosPaling banyak 30100Aktif");
    // the marketplace warehouse names come in their own request
    await waitFor(() => expect(warehouse).toHaveTextContent("Gudang SidoarjoSemua stok1100Nonaktif"));
  });

  it("adds a rule for one variant in one marketplace warehouse, showing what it would send", async () => {
    const calls = api();
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Tambah aturan" }));
    const dialog = await screen.findByRole("dialog", { name: "Tambah aturan" });

    await user.click(within(dialog).getByRole("combobox", { name: "Gudang marketplace" }));
    // marketplace-run warehouses take no rules
    expect(screen.queryByRole("option", { name: "Dikelola Shopee" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Gudang Sidoarjo" }));
    await user.type(within(dialog).getByLabelText("Varian"), "kaos");
    await user.click(await within(dialog).findByRole("button", { name: /KAOS-HTM-L/ }));
    expect(within(dialog).getByText("KAOS-HTM-L · Kaos Polos")).toBeInTheDocument();

    expect(within(dialog).getByText("Isi angkanya untuk melihat contoh.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Persentase (%)"), "40");
    await user.clear(within(dialog).getByLabelText("Cadangan"));
    await user.type(within(dialog).getByLabelText("Cadangan"), "2");
    // (20 - 2) at 40%, rounded down
    expect(
      within(dialog).getByText("Contoh: dari 20 stok siap jual, toko ini menampilkan 7 (40%)."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]?.body).toEqual({
      storeId: STORE.id,
      channelWarehouseId: CW,
      variantId: VARIANT,
      mode: "percent",
      value: 40,
      buffer: 2,
      priority: 100,
      active: true,
    });
    expect(await screen.findByText("Aturan ditambahkan.")).toBeInTheDocument();
  });

  it("checks the numbers first, and shows a duplicate the api refuses", async () => {
    const calls = api({
      "POST /v1/stock-allocation-rules": () =>
        problem(409, "stock_rule.duplicate", "Sudah ada aturan untuk toko, gudang marketplace, dan varian yang sama."),
    });
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Tambah aturan" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Persentase (%)"), "120");
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(await within(dialog).findByText("Persentase paling besar 100.")).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);

    await user.click(within(dialog).getByRole("radio", { name: "Jumlah tetap" }));
    expect(within(dialog).queryByText("Persentase paling besar 100.")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Sudah ada aturan untuk toko, gudang marketplace, dan varian yang sama.",
    );
  });

  it("changes only what changed of a rule, with the version it read", async () => {
    const calls = api({
      [`GET /v1/stock-allocation-rules/${STOREWIDE.id}`]: () => Response.json(STOREWIDE, { headers: { etag: '"4"' } }),
      [`PATCH /v1/stock-allocation-rules/${STOREWIDE.id}`]: (c) => ({ ...STOREWIDE, ...(c.body as object) }),
    });
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Ubah aturan Seluruh toko" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah aturan" });
    expect(within(dialog).getByText(/Cakupan aturan tidak bisa diubah/)).toBeInTheDocument();
    const value = within(dialog).getByLabelText("Persentase (%)");
    expect(value).toHaveValue("50");
    await user.clear(value);
    await user.type(value, "60");
    await user.click(within(dialog).getByRole("switch", { name: /Aktif/ }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Simpan" })).toBeEnabled());
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      method: "PATCH",
      body: { value: 60, active: false },
      headers: expect.objectContaining({ "if-match": '"4"' }),
    });
  });

  it("asks before deleting a rule", async () => {
    const calls = api({ [`DELETE /v1/stock-allocation-rules/${ONE_VARIANT.id}`]: () => undefined });
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Hapus aturan KAOS-HTM-L · Kaos Polos" }));
    expect(screen.getByText(/Hapus aturan untuk KAOS-HTM-L · Kaos Polos\?/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Batal" }));
    expect(writes(calls)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Hapus aturan KAOS-HTM-L · Kaos Polos" }));
    await user.click(screen.getByRole("button", { name: "Hapus aturan" }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: "DELETE", path: `/v1/stock-allocation-rules/${ONE_VARIANT.id}` });
  });

  it("says that all ready stock goes to the store when there is no rule", async () => {
    mockApi({
      "GET /v1/stock-allocation-rules": () => ({ items: [] }),
      [`GET /v1/stores/${STORE.id}/channel-warehouses`]: () => ({ items: [] }),
    });
    renderApp(<AllocationRules store={STORE} />);
    expect(await screen.findByText("Belum ada aturan. Semua stok siap jual dikirim ke toko ini.")).toBeInTheDocument();
  });
});
