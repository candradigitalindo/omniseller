import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setUrl } from "@/test/navigation";
import { ALL_PERMISSIONS, type ApiCall, mockApi, problem, renderApp, testMe } from "@/test/render";
import type { OrderRule } from "./order-rules-meta";
import { OrderRulesView } from "./order-rules-view";

const S1 = "01JSTORE000000000000000001";
const S2 = "01JSTORE000000000000000002";
const W1 = "01JWAREHOUSE00000000000001";
const W2 = "01JWAREHOUSE00000000000002";
const T1 = "01JTAG00000000000000000001";

const SPX: OrderRule = {
  id: "01JRULE0000000000000000001",
  name: "SPX satuan",
  priority: 1,
  active: true,
  conditions: {
    storeIds: [S1],
    couriers: ["SPX"],
    warehouseIds: [],
    skus: [],
    items: "single",
    minTotal: null,
    maxTotal: null,
    withinOperatingHours: false,
  },
  actions: { warehouseId: null, tagIds: [T1], accept: true, arrange: "pickup" },
  createdAt: "2026-10-10T01:00:00.000Z",
  updatedAt: "2026-10-10T01:00:00.000Z",
  rowVersion: 2,
};
const BIG: OrderRule = {
  ...SPX,
  id: "01JRULE0000000000000000002",
  name: "Pesanan besar",
  priority: 2,
  active: false,
  conditions: { ...SPX.conditions, storeIds: [], couriers: [], items: "any", minTotal: 500_000 },
  actions: { warehouseId: W2, tagIds: [], accept: false, arrange: null },
};
const store = (id: string, name: string, extra: object = {}) => ({
  id,
  name,
  channel: "shopee",
  status: "active",
  syncMode: "live",
  ...extra,
});
const CHOICES = {
  "GET /v1/stores": () => ({
    items: [
      store(S1, "Toko Shopee"),
      store(S2, "Toko Uji", { syncMode: "read_only" }),
      store("01JSTORE000000000000000009", "WhatsApp", { channel: "manual" }),
    ],
  }),
  "GET /v1/warehouses": () => ({
    items: [
      { id: W1, name: "Gudang Jakarta", code: "JKT" },
      { id: W2, name: "Gudang Surabaya", code: "SBY" },
    ],
    next_cursor: null,
  }),
  "GET /v1/tags": () => ({ items: [{ id: T1, name: "Kilat", color: null, orders: 3 }] }),
  "GET /v1/orders/couriers": () => ({ items: [{ courier: "SPX Standard", orders: 9 }], next_cursor: null }),
};
const LIST = "Aturan, urut seperti diperiksa";
const called = (calls: ApiCall[], method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path);

describe("Aturan Otomatis (L55)", () => {
  beforeEach(() => setUrl("/pesanan/aturan"));

  it("lists the rules in the order they are checked, each as a sentence", async () => {
    mockApi({ ...CHOICES, "GET /v1/order-rules": () => ({ items: [SPX, BIG], next_cursor: null }) });
    renderApp(<OrderRulesView />);
    const list = await screen.findByRole("list", { name: LIST });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first).toHaveTextContent("Urutan 1:SPX satuan");
    expect(first).toHaveTextContent("Jika: toko Toko Shopee · kurir SPX · 1 barang");
    expect(first).toHaveTextContent("Maka: beri tag Kilat → terima dan atur pickup");
    expect(second).toHaveTextContent("Pesanan besarMati");
    expect(second).toHaveTextContent("Jika: total paling sedikit Rp 500.000");
    expect(second).toHaveTextContent("Maka: pindah ke Gudang Surabaya");
    // the first cannot go up, the last cannot go down
    expect(screen.getByRole("button", { name: "Naikkan urutan SPX satuan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Turunkan urutan Pesanan besar" })).toBeDisabled();
  });

  it("switches a rule with the version it read, moves it, and removes it after asking", async () => {
    const calls = mockApi({
      ...CHOICES,
      "GET /v1/order-rules": () => ({ items: [SPX, BIG], next_cursor: null }),
      [`PATCH /v1/order-rules/${BIG.id}`]: (c) => ({ ...BIG, ...(c.body as object), rowVersion: 3 }),
      "PUT /v1/order-rules/priority": () => ({
        items: [
          { ...BIG, priority: 1 },
          { ...SPX, priority: 2 },
        ],
        next_cursor: null,
      }),
      [`DELETE /v1/order-rules/${SPX.id}`]: () => undefined,
    });
    const user = userEvent.setup();
    renderApp(<OrderRulesView />);
    await user.click(await screen.findByRole("switch", { name: "Aktifkan aturan Pesanan besar" }));
    await waitFor(() => expect(called(calls, "PATCH", `/v1/order-rules/${BIG.id}`)).toHaveLength(1));
    const patch = called(calls, "PATCH", `/v1/order-rules/${BIG.id}`)[0]!;
    expect(patch.body).toEqual({ active: true });
    expect(patch.headers?.["if-match"]).toBe('"2"');
    expect(await screen.findByText("Aturan Pesanan besar aktif.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Naikkan urutan Pesanan besar" }));
    await waitFor(() => expect(called(calls, "PUT", "/v1/order-rules/priority")).toHaveLength(1));
    expect(called(calls, "PUT", "/v1/order-rules/priority")[0]!.body).toEqual({ ids: [BIG.id, SPX.id] });
    // the answer is the new order
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: LIST }))
          .getAllByRole("heading")
          .map((h) => h.textContent),
      ).toEqual(["Urutan 1:Pesanan besarMati", "Urutan 2:SPX satuan"]),
    );

    await user.click(screen.getByRole("button", { name: "Hapus aturan SPX satuan" }));
    const ask = await screen.findByRole("dialog", { name: "Hapus aturan SPX satuan?" });
    await user.click(within(ask).getByRole("button", { name: "Hapus" }));
    expect(await screen.findByText("Aturan SPX satuan dihapus.")).toBeInTheDocument();
  });

  it("makes a rule from what is chosen, after checking what is missing", async () => {
    const calls = mockApi({
      ...CHOICES,
      "GET /v1/order-rules": () => ({ items: [], next_cursor: null }),
      "POST /v1/order-rules": (c) => ({ ...SPX, id: "01JRULE0000000000000000003", ...(c.body as object) }),
    });
    const user = userEvent.setup();
    renderApp(<OrderRulesView />);
    expect(await screen.findByText("Belum ada aturan")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Buat aturan" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Aturan baru" });
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(within(dialog).getByText("Isi nama aturan.")).toBeInTheDocument();
    expect(within(dialog).getByText("Pilih paling sedikit satu tindakan.")).toBeInTheDocument();

    // marketplace stores only; one still in parallel mode says so
    const stores = within(dialog).getByRole("group", { name: "Toko" });
    expect(
      within(stores)
        .getAllByRole("checkbox")
        .map((c) => c.id),
    ).toHaveLength(2);
    expect(within(stores).getByText("Toko Uji (mode uji, belum berjalan)")).toBeInTheDocument();
    expect(within(dialog).queryByText("WhatsApp")).not.toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Nama aturan"), "Pickup SPX");
    await user.click(within(stores).getByLabelText("Toko Shopee"));
    await user.type(within(dialog).getByLabelText("Kurir"), "SPX, J&T");
    await user.click(within(dialog).getByLabelText("1 barang"));
    await user.type(within(dialog).getByLabelText("Total paling sedikit"), "Rp 50.000");
    await user.click(within(dialog).getByRole("switch", { name: "Hanya selama jam operasional" }));
    await user.click(within(within(dialog).getByRole("group", { name: "Beri tag" })).getByLabelText("Kilat"));
    await user.click(within(dialog).getByLabelText("Terima dan atur pickup"));
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));

    await waitFor(() => expect(called(calls, "POST", "/v1/order-rules")).toHaveLength(1));
    expect(called(calls, "POST", "/v1/order-rules")[0]!.body).toEqual({
      name: "Pickup SPX",
      active: true,
      conditions: {
        storeIds: [S1],
        couriers: ["SPX", "J&T"],
        warehouseIds: [],
        skus: [],
        items: "single",
        minTotal: 50_000,
        maxTotal: null,
        withinOperatingHours: true,
      },
      actions: { warehouseId: null, tagIds: [T1], accept: true, arrange: "pickup" },
    });
    expect(await screen.findByText("Aturan Pickup SPX disimpan.")).toBeInTheDocument();
  });

  it("shows the api's refusal under the field it names", async () => {
    mockApi({
      ...CHOICES,
      "GET /v1/order-rules": () => ({ items: [SPX], next_cursor: null }),
      [`PATCH /v1/order-rules/${SPX.id}`]: () =>
        problem(422, "validation.failed", "Periksa kembali isian yang ditandai.", {
          errors: [{ path: "conditions.storeIds.0", message: "Toko tidak ditemukan." }],
        }),
    });
    const user = userEvent.setup();
    renderApp(<OrderRulesView />);
    await user.click(await screen.findByRole("button", { name: "Ubah aturan SPX satuan" }));
    const dialog = await screen.findByRole("dialog", { name: "Ubah aturan SPX satuan" });
    expect(within(dialog).getByLabelText("Nama aturan")).toHaveValue("SPX satuan");
    expect(within(dialog).getByLabelText("Terima dan atur pickup")).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    expect(await within(within(dialog).getByRole("group", { name: "Toko" })).findByRole("alert")).toHaveTextContent(
      "Toko tidak ditemukan.",
    );
  });

  it("offers only the actions the person may do", async () => {
    const calls = mockApi({
      ...CHOICES,
      "GET /v1/order-rules": () => ({ items: [], next_cursor: null }),
      "POST /v1/order-rules": () =>
        problem(
          403,
          "order_rule.permission_not_held",
          'Aturan ini menjalankan "Beri tag pesanan", izin yang tidak Anda miliki.',
        ),
    });
    const user = userEvent.setup();
    renderApp(<OrderRulesView />, { me: testMe(["order:read", "order:accept"]) });
    await user.click((await screen.findAllByRole("button", { name: "Buat aturan" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Terima dan atur pickup")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("group", { name: "Beri tag" })).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Nama aturan"), "Terima");
    await user.click(within(dialog).getByLabelText("Terima pesanan"));
    await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
    // a refusal without a field shows by the button
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("izin yang tidak Anda miliki");
    expect(called(calls, "POST", "/v1/order-rules")).toHaveLength(1);
  });

  it("is closed to whoever cannot accept orders", async () => {
    const calls = mockApi({ ...CHOICES });
    renderApp(<OrderRulesView />, { me: testMe(["order:read", "order:tag"]) });
    expect(await screen.findByText("Halaman ini untuk pengguna yang boleh menerima pesanan.")).toBeInTheDocument();
    expect(called(calls, "GET", "/v1/order-rules")).toHaveLength(0);
  });

  it("on Starter: explains the plan, and keeps rules made before visible and deletable only", async () => {
    const starter = { ...testMe(ALL_PERMISSIONS), plan: { code: "starter", name: "Starter", features: [] } };
    mockApi({ ...CHOICES, "GET /v1/order-rules": () => ({ items: [], next_cursor: null }) });
    const { unmount } = renderApp(<OrderRulesView />, { me: starter });
    expect(await screen.findByText("Tersedia mulai paket Growth")).toBeInTheDocument();
    expect(screen.getByText(/Aturan proses otomatis tidak termasuk paket Starter/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lihat paket" })).toHaveAttribute("href", "/langganan");
    expect(screen.queryByRole("button", { name: "Buat aturan" })).not.toBeInTheDocument();
    unmount();

    mockApi({ ...CHOICES, "GET /v1/order-rules": () => ({ items: [SPX], next_cursor: null }) });
    renderApp(<OrderRulesView />, { me: starter });
    expect(await screen.findByRole("status")).toHaveTextContent("Aturan di bawah sedang berhenti");
    expect(await screen.findByRole("list", { name: LIST })).toHaveTextContent("SPX satuan");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ubah aturan SPX satuan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buat aturan" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hapus aturan SPX satuan" })).toBeInTheDocument();
  });
});
