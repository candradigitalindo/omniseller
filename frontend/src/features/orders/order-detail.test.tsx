import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type ApiCall, mockApi, renderApp, testMe } from "@/test/render";
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
    internalShipByAt: null,
    internalSla: null,
    warehouseId: null,
    problems: [],
    cancelRequested: false,
    tags: [],
    labelPrintedAt: null,
    orderedAt: "2026-10-05T01:00:00.000Z",
    items: [],
    buyerUsername: null,
    buyerPhone: null,
    shippingAddress: null,
    addressHidden: false,
    buyerNote: null,
    buyerAnonymizedAt: null,
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

  it("names each step of the history and who took it", async () => {
    const event = (type: string, over: Partial<OrderDetail["events"][number]> = {}): OrderDetail["events"][number] => ({
      id: `01JEVENT${type
        .padEnd(18, "0")
        .slice(0, 18)
        .toUpperCase()
        .replace(/[^0-9A-Z]/g, "0")}`,
      type,
      fromStatus: null,
      toStatus: null,
      actorType: "user",
      actorId: "01JUSER0000000000000000002",
      actorName: "Budi Santoso",
      payload: {},
      createdAt: "2026-10-05T02:00:00.000Z",
      ...over,
    });
    mockApi({
      "GET /v1/orders/01JORDER000000000000000001": () =>
        order({
          events: [
            event("created", { actorType: "marketplace", actorId: null, actorName: null }),
            // an automatic rule (backend doc 8.37): its name, and what it could not do with the reason
            event("auto_processed", {
              actorType: "system",
              actorId: null,
              actorName: null,
              payload: {
                ruleId: "01JRULE0000000000000000001",
                rule: "SPX satuan",
                done: ["tags"],
                refused: [{ action: "arrange", code: "store.read_only", message: "Toko masih mode baca saja." }],
              },
            }),
            event("shipment_requested", { actorName: "Rina Wulandari" }),
            // the rule's later steps, each telling its outcome
            event("auto_arrange", {
              actorType: "system",
              actorId: null,
              actorName: null,
              payload: {
                status: "skipped",
                code: "shipment.already_arranged",
                message: "Pengiriman pesanan ini sudah diatur sebelum jamnya.",
              },
            }),
            event("auto_print", {
              actorType: "system",
              actorId: null,
              actorName: null,
              payload: { status: "queued", agent: "PC Packing" },
            }),
            event("pick_list_printed"),
            event("status_changed", { fromStatus: "ready_to_pack", toStatus: "packed" }),
            event("handed_over"),
            event("label_ready", { actorType: "system", actorId: null, actorName: null }),
            // a user who left keeps the entry without a name
            event("packing_list_printed", { actorName: null }),
            event("something_new"),
          ],
        }),
      "GET /v1/orders/01JORDER000000000000000001/shipments": () => ({ items: [] }),
      "GET /v1/stores": () => ({
        items: [{ id: STORE, name: "Toko Utama", channel: "shopee", status: "active", syncMode: "live" }],
      }),
    });
    renderApp(<OrderDetailSheet orderId="01JORDER000000000000000001" onClose={() => {}} />);
    const history = (await screen.findByRole("heading", { name: "Riwayat" })).parentElement as HTMLElement;
    const entries = within(history)
      .getAllByRole("listitem")
      .map((li) => [li.firstChild?.textContent, li.lastChild?.textContent?.replace(/^.* · /, "")]);
    expect(entries).toEqual([
      ["Pesanan diperbarui", "oleh Budi Santoso"],
      ["Daftar kemas dicetak", "oleh pengguna"],
      ["Label siap dicetak", "otomatis"],
      ["Diserahkan ke kurir", "oleh Budi Santoso"],
      ["Status: Siap Dikemas → Dikemas", "oleh Budi Santoso"],
      ["Masuk pick list yang dicetak", "oleh Budi Santoso"],
      ["Label dicetak otomatis ke PC Packing", "otomatis"],
      ["Atur kirim otomatis dilewati: Pengiriman pesanan ini sudah diatur sebelum jamnya.", "otomatis"],
      ["Atur kirim diminta", "oleh Rina Wulandari"],
      ['Diproses aturan otomatis "SPX satuan"', "otomatis"],
      ["Pesanan masuk", "dari marketplace"],
    ]);
    expect(
      within(history).getByText("Tidak dijalankan: atur pengiriman (Toko masih mode baca saja.)"),
    ).toBeInTheDocument();
  });

  it("offers no seller step for a store still in parallel mode", async () => {
    api("read_only");
    renderApp(<OrderDetailSheet orderId="01JORDER000000000000000001" onClose={() => {}} />);
    expect(await screen.findByText(/Toko Utama masih mode uji berdampingan/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terima pesanan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Aksi lain" })).toBeNull();
  });
});

describe("OrderDetailSheet: warehouse, tracking, and tags", () => {
  const ID = "01JORDER000000000000000001";
  const JKT = "01JWAREHOUSE00000000000001";
  const SBY = "01JWAREHOUSE00000000000002";
  const TAG = { id: "01JTAG00000000000000000001", name: "Prioritas", color: "#E34948" };
  const warehouse = (id: string, name: string) => ({
    id,
    code: name.slice(7, 10).toUpperCase(),
    name,
    isDefault: id === JKT,
    active: true,
    address: {},
    createdAt: "2026-09-01T00:00:00.000Z",
  });

  function setup(
    o: OrderDetail,
    opts: { warehouses?: string[]; extra?: Record<string, (c: ApiCall) => unknown> } = {},
  ) {
    const names: Record<string, string> = { [JKT]: "Gudang Jakarta", [SBY]: "Gudang Surabaya" };
    return mockApi({
      [`GET /v1/orders/${ID}`]: () => o,
      [`GET /v1/orders/${ID}/shipments`]: () => ({ items: [] }),
      "GET /v1/stores": () => ({
        items: [
          { id: STORE, name: "Toko Utama", channel: o.store?.channel ?? "shopee", status: "active", syncMode: "live" },
        ],
      }),
      "GET /v1/warehouses": () => ({ items: (opts.warehouses ?? [JKT, SBY]).map((id) => warehouse(id, names[id]!)) }),
      "GET /v1/tags": () => ({ items: [{ ...TAG, orders: 1 }] }),
      [`PUT /v1/orders/${ID}/warehouse`]: () => undefined,
      ...opts.extra,
    });
  }
  const open = (me?: ReturnType<typeof testMe>) =>
    renderApp(<OrderDetailSheet orderId={ID} onClose={() => {}} />, me ? { me } : undefined);

  it("moves an order nobody packed to another warehouse", async () => {
    const calls = setup(order({ warehouseId: JKT }));
    const user = userEvent.setup();
    open();
    expect(await screen.findByText("Gudang Jakarta")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Aksi lain" }));
    await user.click(await screen.findByRole("menuitem", { name: "Pindah gudang" }));
    const dialog = await screen.findByRole("dialog", { name: "Pindah gudang" });
    expect(within(dialog).getByText("Sekarang dikirim dari Gudang Jakarta.")).toBeInTheDocument();
    // only the other warehouses
    expect(within(dialog).getAllByRole("radio")).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "Pindahkan" })).toBeDisabled();
    await user.click(within(dialog).getByRole("radio", { name: "Gudang Surabaya" }));
    await user.click(within(dialog).getByRole("button", { name: "Pindahkan" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      path: `/v1/orders/${ID}/warehouse`,
      body: { warehouseId: SBY },
    });
    expect(await screen.findByText("Pesanan dipindah ke Gudang Surabaya.")).toBeInTheDocument();
  });

  it("opens the move from the shipping card and from a short-stock problem", async () => {
    setup(
      order({
        warehouseId: JKT,
        status: "problem",
        problems: [
          {
            id: "01JPROB0000000000000000001",
            code: "insufficient_stock",
            detail: null,
            resolvedAt: null,
            resolution: null,
          },
        ],
      }),
    );
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "Pindah" }));
    expect(await screen.findByRole("dialog", { name: "Pindah gudang" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Batal" }));
    await user.click(screen.getByRole("button", { name: "Pindah gudang" }));
    expect(await screen.findByRole("dialog", { name: "Pindah gudang" })).toBeInTheDocument();
  });

  it.each([
    ["the marketplace placed it", { warehouseFixed: true }, undefined, undefined],
    ["it is packed", { status: "packed" as const }, undefined, undefined],
    ["there is no other warehouse", {}, [JKT], undefined],
    ["the user may not accept orders", {}, undefined, ["order:read", "shipment:arrange"] as const],
  ])("keeps the warehouse when %s", async (_, over, warehouses, permissions) => {
    setup(order({ warehouseId: JKT, ...over }), warehouses ? { warehouses } : {});
    const user = userEvent.setup();
    open(permissions ? testMe([...permissions]) : undefined);
    expect(await screen.findByText("Gudang Jakarta")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pindah" })).not.toBeInTheDocument();
    const more = screen.queryByRole("button", { name: "Aksi lain" });
    if (more) {
      await user.click(more);
      await screen.findByRole("menu");
      expect(screen.queryByRole("menuitem", { name: "Pindah gudang" })).not.toBeInTheDocument();
    }
  });

  it("reads a shipped parcel again, at most every 10 minutes", async () => {
    let queued = true;
    const calls = setup(order({ status: "shipped", trackingNumber: "SPXID0123" }), {
      extra: {
        [`POST /v1/orders/${ID}/tracking/refresh`]: () => Response.json({ queued }, { status: 202 }),
        [`GET /v1/orders/${ID}/tracking`]: () => ({ trackingNumber: "SPXID0123", events: [], error: null }),
      },
    });
    const user = userEvent.setup();
    open();

    await user.click(await screen.findByRole("button", { name: "Perbarui" }));
    expect(await screen.findByText("Pelacakan sedang diperbarui.")).toBeInTheDocument();
    // the tracking opens and is read
    await waitFor(() => expect(calls.some((c) => c.path === `/v1/orders/${ID}/tracking`)).toBe(true));
    expect(screen.getByRole("button", { name: "Tutup pelacakan" })).toBeInTheDocument();

    queued = false;
    await user.click(screen.getByRole("button", { name: "Perbarui" }));
    expect(await screen.findByText("Pelacakan sudah diperbarui dalam 10 menit terakhir.")).toBeInTheDocument();
  });

  it("says when the buyer's data was anonymized, keeping the city and the parcel's steps", async () => {
    setup(
      order({
        status: "completed",
        trackingNumber: "SPXID0456",
        buyerName: null,
        buyerPhone: null,
        shippingAddress: { city: "Jakarta Barat", province: "DKI Jakarta" },
        buyerAnonymizedAt: "2026-10-09T17:30:00.000Z",
      }),
      {
        extra: {
          [`GET /v1/orders/${ID}/tracking`]: () => ({
            trackingNumber: "SPXID0456",
            events: [{ at: "2026-09-01T09:00:00.000Z", description: "", code: "DELIVERED", stage: "delivered" }],
            error: null,
          }),
        },
      },
    );
    const user = userEvent.setup();
    open();
    expect(
      await screen.findByText("Data pembeli dianonimkan 10 Okt 2026 sesuai masa simpan data pembeli."),
    ).toBeInTheDocument();
    expect(screen.getByText("Jakarta Barat, DKI Jakarta")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Lacak paket" }));
    expect(await screen.findByText("Keterangan dihapus bersama data pembeli")).toBeInTheDocument();
  });

  it("offers no tracking refresh for a manual order or one the marketplace ships", async () => {
    setup(
      order({
        status: "shipped",
        trackingNumber: "MN-RESI-1",
        store: { id: STORE, name: "WhatsApp", channel: "manual", channelName: "Penjualan langsung" },
      }),
    );
    const { unmount } = open();
    await screen.findByText("MN-RESI-1");
    expect(screen.queryByRole("button", { name: "Perbarui" })).not.toBeInTheDocument();
    unmount();

    setup(order({ status: "shipped", trackingNumber: "SPXID0123", fulfillmentMode: "marketplace" }));
    open();
    await screen.findByText("SPXID0123");
    expect(screen.queryByRole("button", { name: "Perbarui" })).not.toBeInTheDocument();
  });

  it("shows the order's tags and changes them for this order", async () => {
    const calls = setup(order({ tags: [TAG] }), {
      extra: {
        "POST /v1/orders/tags": () => ({ items: [{ orderId: ID, tags: [] }] }),
      },
    });
    const user = userEvent.setup();
    open();
    const card = (await screen.findByRole("heading", { name: "Tag" })).closest("section")!;
    expect(within(card).getByText("Prioritas")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Ubah tag" }));
    expect(await screen.findByText("Tag pesanan ini")).toBeInTheDocument();
    await user.click(await screen.findByRole("checkbox", { name: "Prioritas" }));
    await user.click(screen.getByRole("button", { name: "Terapkan" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/orders/tags")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/orders/tags")?.body).toEqual({
      orderIds: [ID],
      add: [],
      remove: [TAG.id],
    });
  });

  it("shows the tags without the editor to those who may not tag orders", async () => {
    setup(order({ tags: [] }));
    open(testMe(["order:read"]));
    const card = (await screen.findByRole("heading", { name: "Tag" })).closest("section")!;
    expect(within(card).getByText("Belum ada tag.")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Ubah tag" })).not.toBeInTheDocument();
  });
});
