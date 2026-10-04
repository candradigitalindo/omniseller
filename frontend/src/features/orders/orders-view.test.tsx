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
