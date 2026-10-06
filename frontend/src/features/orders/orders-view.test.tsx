import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { mockApi, renderApp, testMe } from "@/test/render";
import type { OrderListItem } from "./order-meta";
import { OrdersView } from "./orders-view";

function listItem(over: Partial<OrderListItem>): OrderListItem {
  return {
    id: "01JORDER000000000000000001",
    externalOrderId: "2609300AB1",
    store: { id: "01JSTORE000000000000000001", name: "Toko Utama", channel: "shopee", channelName: "Shopee" },
    platform: null,
    status: "new",
    statusLabel: "Baru",
    externalStatus: "READY_TO_SHIP",
    fulfillmentMode: "seller",
    buyerName: "Dewi A.",
    itemCount: 3,
    firstItem: { title: "Kaos Polos Hitam L", sku: "KAOS-HTM-L", variantName: "Hitam, L", imageUrl: null, qty: 2 },
    total: 245_000,
    currency: "IDR",
    isCod: false,
    shippingProvider: "J&T Express",
    shippingService: null,
    trackingNumber: null,
    shipByAt: "2026-10-04T08:00:00.000Z",
    sla: { state: "warning", remainingMs: 2 * 3_600_000 },
    warehouseId: null,
    problems: [],
    cancelRequested: false,
    tags: [],
    orderedAt: "2026-10-03T08:00:00.000Z",
    ...over,
  };
}

const ready = listItem({});
const blocked = listItem({
  id: "01JORDER000000000000000002",
  externalOrderId: "2609300AB2",
  isCod: true,
  problems: [
    { id: "01JPROB0000000000000000001", code: "unmapped_sku", detail: null, resolvedAt: null, resolution: null },
  ],
});

describe("OrdersView", () => {
  beforeEach(() => setUrl("/pesanan?status=new"));

  function api() {
    return mockApi({
      "GET /v1/orders/summary": () => ({
        statuses: { new: 2, problem: 1, ready_to_pack: 5 },
        overdue: 0,
        dueSoon: 1,
        codOutstanding: { orders: 1, total: 245_000 },
      }),
      "GET /v1/orders": () => ({ items: [ready, blocked], next_cursor: null }),
      "POST /v1/orders/accept": (call) => ({
        items: (call.body as { orderIds: string[] }).orderIds.map((id) => ({ id, ok: true })),
      }),
      "POST /v1/shipments/arrange": (call) => ({
        items: (call.body as { orderIds: string[] }).orderIds.map((id) => ({ id, ok: true })),
      }),
    });
  }

  it("lists the tab's orders by ship-by time, with counts and each order's problem", async () => {
    const calls = api();
    renderApp(<OrdersView />);

    const tab = await screen.findByRole("tab", { name: /Baru/ });
    expect(tab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(within(tab).getByText("2")).toBeInTheDocument());
    expect(screen.getAllByText("2609300AB1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SKU belum terhubung").length).toBeGreaterThan(0);
    expect(screen.getAllByText("COD").length).toBeGreaterThan(0);

    const list = calls.find((c) => c.path === "/v1/orders");
    expect(list?.query).toMatchObject({ status: "new", sort: "ship_by", limit: "50" });
  });

  it("accepts the selected orders in one request", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<OrdersView />);

    const [checkbox] = await screen.findAllByRole("checkbox", { name: "Pilih pesanan 2609300AB1" });
    await user.click(checkbox!);
    expect(screen.getByText("1 dipilih")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Terima" }));

    await waitFor(() => expect(calls.some((c) => c.path === "/v1/orders/accept")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/orders/accept")?.body).toEqual({ orderIds: [ready.id] });
    // the selection is done with
    await waitFor(() => expect(screen.queryByText("1 dipilih")).not.toBeInTheDocument());
  });

  it("processes every new order without a problem, by the chosen method", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<OrdersView />);

    await user.click(await screen.findByRole("button", { name: "Proses semua yang baru (1)" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: /Antar ke kurir/ }));
    await user.click(within(dialog).getByRole("button", { name: "Atur kirim (1)" }));

    await waitFor(() => expect(calls.some((c) => c.path === "/v1/shipments/arrange")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/shipments/arrange")?.body).toEqual({
      orderIds: [ready.id],
      method: "dropoff",
    });
  });

  it("keeps filters in the URL", async () => {
    api();
    const user = userEvent.setup();
    renderApp(<OrdersView />);

    await user.click(await screen.findByRole("button", { name: "Hanya COD" }));
    expect(currentUrl()).toBe("/pesanan?status=new&cod=true");
    await user.click(screen.getByRole("tab", { name: /Bermasalah/ }));
    expect(currentUrl()).toBe("/pesanan?status=problem&cod=true");
  });

  it("hides actions the user may not take", async () => {
    api();
    renderApp(<OrdersView />, { me: testMe(["order:read"]) });
    await screen.findAllByText("2609300AB1");
    expect(screen.queryByRole("button", { name: /Proses semua/ })).not.toBeInTheDocument();
  });
});

describe("OrdersView: stores, warehouses, tags, and reading orders again", () => {
  const TAG = { id: "01JTAG00000000000000000001", name: "Prioritas", color: "#E34948" };
  const JKT = "01JWAREHOUSE00000000000001";
  const SBY = "01JWAREHOUSE00000000000002";
  const SHOP = "01JSTORE000000000000000001";
  const warehouse = (id: string, name: string) => ({
    id,
    code: name.slice(7, 10).toUpperCase(),
    name,
    isDefault: id === JKT,
    active: true,
    address: {},
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  const store = (id: string, name: string, channel: string, status: string) => ({
    id,
    name,
    channel,
    status,
    syncMode: "live",
  });
  const tagged = listItem({ tags: [TAG], warehouseId: JKT });
  const plain = listItem({ id: "01JORDER000000000000000002", externalOrderId: "2609300AB2", warehouseId: SBY });

  function api() {
    return mockApi({
      "GET /v1/orders/summary": () => ({
        statuses: {},
        overdue: 0,
        dueSoon: 0,
        codOutstanding: { orders: 0, total: 0 },
      }),
      "GET /v1/orders": () => ({ items: [tagged, plain], next_cursor: null }),
      "GET /v1/warehouses": () => ({ items: [warehouse(JKT, "Gudang Jakarta"), warehouse(SBY, "Gudang Surabaya")] }),
      "GET /v1/tags": () => ({ items: [{ ...TAG, orders: 1 }] }),
      "GET /v1/stores": () => ({
        items: [
          store(SHOP, "Toko Utama", "shopee", "active"),
          store("01JSTORE000000000000000002", "Toko Kedua", "tiktokshop", "reauth_required"),
          store("01JSTORE000000000000000003", "WhatsApp", "manual", "active"),
        ],
      }),
      "POST /v1/orders/sync": () => undefined,
      "POST /v1/orders/tags": (c) => ({
        items: (c.body as { orderIds: string[] }).orderIds.map((orderId) => ({ orderId, tags: [TAG] })),
      }),
    });
  }
  const listQuery = (calls: { path: string; query: Record<string, string> }[]) =>
    calls.filter((c) => c.path === "/v1/orders").at(-1)?.query;

  beforeEach(() => setUrl("/pesanan"));

  it("filters by store, warehouse, and tag through the URL, and clears them together", async () => {
    setUrl(`/pesanan?store=${SHOP}&warehouse=${SBY}&tag=${TAG.id}`);
    const calls = api();
    const user = userEvent.setup();
    renderApp(<OrdersView />);

    await waitFor(() => expect(listQuery(calls)).toMatchObject({ storeId: SHOP, warehouseId: SBY, tagId: TAG.id }));
    expect(await screen.findByRole("combobox", { name: "Tag" })).toHaveTextContent("Prioritas");
    expect(screen.getByRole("combobox", { name: "Toko" })).toHaveTextContent("Toko Utama");
    expect(screen.getByRole("combobox", { name: "Gudang" })).toHaveTextContent("Gudang Surabaya");

    await user.click(screen.getByRole("button", { name: "Bersihkan" }));
    expect(currentUrl()).toBe("/pesanan");

    await user.click(screen.getByRole("combobox", { name: "Tag" }));
    await user.click(await screen.findByRole("option", { name: "Prioritas" }));
    expect(currentUrl()).toBe(`/pesanan?tag=${TAG.id}`);
  });

  it("shows each order's warehouse and tags", async () => {
    api();
    renderApp(<OrdersView />);
    const table = await screen.findByRole("table");
    await within(table).findByText("Gudang Jakarta");
    expect(within(table).getByRole("columnheader", { name: "Gudang" })).toBeInTheDocument();
    expect(within(table).getByText("Gudang Surabaya")).toBeInTheDocument();
    const [, first] = within(table).getAllByRole("row");
    expect(within(first!).getByText("Prioritas")).toBeInTheDocument();
  });

  it("tags the selected orders from the bulk bar", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<OrdersView />);
    const table = await screen.findByRole("table");

    await user.click(within(table).getByRole("checkbox", { name: "Pilih pesanan 2609300AB2" }));
    await user.click(screen.getByRole("button", { name: "Beri tag" }));
    const list = await screen.findByRole("list", { name: "Daftar tag" });
    await user.click(await within(list).findByRole("checkbox", { name: "Prioritas" }));
    await user.click(screen.getByRole("button", { name: "Terapkan" }));

    await waitFor(() => expect(calls.some((c) => c.path === "/v1/orders/tags")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/orders/tags")?.body).toEqual({
      orderIds: [plain.id],
      add: [TAG.id],
      remove: [],
    });
    // the selection is done with, and the filters are back
    await waitFor(() => expect(screen.queryByText("1 dipilih")).not.toBeInTheDocument());
    expect(screen.getByRole("combobox", { name: "Tag" })).toBeInTheDocument();
  });

  it("reads a store's orders again, offering only marketplace stores whose connection works", async () => {
    const calls = api();
    const user = userEvent.setup();
    renderApp(<OrdersView />);

    await user.click(await screen.findByRole("button", { name: "Aksi lain" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    expect(within(menu).getByRole("menuitem", { name: "Kelola tag" })).toBeInTheDocument();
    // not a store waiting for its permission again, nor a manual channel
    expect(within(menu).queryByRole("menuitem", { name: "Toko Kedua" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "WhatsApp" })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Toko Utama" }));

    await waitFor(() => expect(calls.some((c) => c.path === "/v1/orders/sync")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/orders/sync")?.body).toEqual({ storeId: SHOP });
    expect(await screen.findByText(/Pesanan Toko Utama sedang ditarik ulang/)).toBeInTheDocument();
  });

  it("manages the tags from the same menu", async () => {
    api();
    const user = userEvent.setup();
    renderApp(<OrdersView />);
    await user.click(await screen.findByRole("button", { name: "Aksi lain" }));
    await user.click(await screen.findByRole("menuitem", { name: "Kelola tag" }));
    expect(await screen.findByRole("dialog", { name: "Kelola tag" })).toBeInTheDocument();
  });

  it("gives the menu only what the user may do", async () => {
    api();
    const user = userEvent.setup();
    const { unmount } = renderApp(<OrdersView />, { me: testMe(["order:read", "settings:store"]) });
    await user.click(await screen.findByRole("button", { name: "Aksi lain" }));
    expect(await screen.findAllByRole("menuitem")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "Toko Utama" })).toBeInTheDocument();
    unmount();

    renderApp(<OrdersView />, { me: testMe(["order:read"]) });
    const table = await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: "Aksi lain" })).not.toBeInTheDocument();
    await user.click(within(table).getByRole("checkbox", { name: "Pilih pesanan 2609300AB2" }));
    expect(screen.queryByRole("button", { name: "Beri tag" })).not.toBeInTheDocument();
  });
});
