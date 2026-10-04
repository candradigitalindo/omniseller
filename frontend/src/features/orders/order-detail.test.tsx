import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockApi, renderApp } from "@/test/render";
import { OrderDetailSheet } from "./order-detail";
import type { OrderDetail } from "./order-meta";

const STORE = "01JSTORE000000000000000001";

function order(over: Partial<OrderDetail> = {}): OrderDetail {
  return {
    id: "01JORDER000000000000000001",
    externalOrderId: "2610050AB1",
    store: { id: STORE, name: "Toko Utama", channel: "shopee", channelName: "Shopee" },
    platform: null,
    status: "new",
    statusLabel: "Baru",
    externalStatus: "READY_TO_SHIP",
    fulfillmentMode: "seller",
    buyerName: "Dewi",
    itemCount: 1,
    firstItem: null,
    total: 120_000,
    currency: "IDR",
    isCod: false,
    shippingProvider: "SPX Express",
    shippingService: null,
    trackingNumber: null,
    shipByAt: null,
    sla: null,
    warehouseId: null,
    problems: [],
    cancelRequested: false,
    tags: [],
    orderedAt: "2026-10-05T01:00:00.000Z",
    items: [],
    buyerUsername: null,
    buyerPhone: null,
    shippingAddress: null,
    addressHidden: false,
    buyerNote: null,
    internalNote: null,
    subtotal: 120_000,
    discountTotal: 0,
    shippingFeeBuyer: 0,
    voucherSeller: 0,
    paidAt: null,
    shippedAt: null,
    deliveredAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelReason: null,
    cancelledBy: null,
    paymentMethod: null,
    warehouseFixed: false,
    events: [],
    ...over,
  };
}

function api(syncMode: "read_only" | "live") {
  mockApi({
    "GET /v1/orders/01JORDER000000000000000001": () => order(),
    "GET /v1/orders/01JORDER000000000000000001/shipments": () => ({ items: [] }),
    "GET /v1/stores": () => ({
      items: [{ id: STORE, name: "Toko Utama", channel: "shopee", status: "active", syncMode }],
    }),
  });
}

describe("OrderDetailSheet", () => {
  it("offers the next step of a live store's order", async () => {
    api("live");
    renderApp(<OrderDetailSheet orderId="01JORDER000000000000000001" onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: "Terima pesanan" })).toBeInTheDocument();
  });

  it("offers no seller step for a store still in parallel mode", async () => {
    api("read_only");
    renderApp(<OrderDetailSheet orderId="01JORDER000000000000000001" onClose={() => {}} />);
    expect(await screen.findByText(/Toko Utama masih mode uji berdampingan/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terima pesanan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Aksi lain" })).toBeNull();
  });
});
