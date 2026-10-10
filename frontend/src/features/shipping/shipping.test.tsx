import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { mockApi, problem, renderApp, testMe } from "@/test/render";
import type { PackingView } from "./shipping-meta";
import { ShippingView } from "./shipping-view";

const ORDER = "01JORDER000000000000000001";
const AGENT = "01JDEVICE00000000000000001";

const view: PackingView = {
  order: {
    id: ORDER,
    number: "2610050AB1",
    channel: "shopee",
    storeId: "01JSTORE000000000000000001",
    status: "ready_to_pack",
    statusLabel: "Siap Dikemas",
    warehouseId: null,
    trackingNumber: "SPXID0001",
    courier: "SPX Express",
    note: "Bungkus rapi ya",
  },
  packable: true,
  packRefusal: null,
  labelRefusal: null,
  lines: [
    {
      key: "01JVARIANT0000000000000001",
      variantId: "01JVARIANT0000000000000001",
      sku: "KAOS-HTM-L",
      barcode: "8991234567891",
      name: "Kaos Polos",
      variantName: "Hitam, L",
      imageUrl: null,
      qty: 2,
    },
    {
      key: "sku:TOPI-01",
      variantId: null,
      sku: "TOPI-01",
      barcode: null,
      name: "Topi Rajut",
      variantName: null,
      imageUrl: null,
      qty: 1,
    },
  ],
};

const agents = {
  items: [
    {
      id: AGENT,
      name: "PC Gudang",
      warehouseId: null,
      connected: true,
      lastSeenAt: null,
      appVersion: "1.0.0",
      printers: [],
      labelPrinter: null,
      documentPrinter: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ],
};

describe("Pengiriman: packing by scan", () => {
  beforeEach(() => setUrl("/pengiriman"));
  afterEach(() => localStorage.clear());

  function api() {
    return mockApi({
      "GET /v1/packing/lookup": () => view,
      "GET /v1/print-agents": () => agents,
      [`POST /v1/packing/orders/${ORDER}/complete`]: () => ({
        order: { ...view.order, status: "packed", statusLabel: "Dikemas" },
        documentId: "01JDOC0000000000000000001",
        printJob: null,
        printRefusal: null,
      }),
    });
  }

  it("packs an order only once every unit is scanned, with the time it took", async () => {
    const calls = api();
    const user = userEvent.setup();
    // the station's clock: the order is scanned at 1 s and packed 95.4 s later
    let clock = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    renderApp(<ShippingView />);

    await user.type(await screen.findByLabelText("Pindai nomor pesanan atau resi"), "SPXID0001{Enter}");
    expect(await screen.findByText("Bungkus rapi ya")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/v1/packing/lookup")?.query).toEqual({ code: "SPXID0001" });

    const box = screen.getByLabelText("Pindai barang (barcode atau SKU)");
    const pack = screen.getByRole("button", { name: "Tandai dikemas" });
    await user.type(box, "8991234567891{Enter}");
    expect(screen.getByText("Kaos Polos: 1 dari 2")).toBeInTheDocument();
    await user.type(box, "SALAH-01{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("SALAH-01 tidak ada di pesanan ini.");
    await user.type(box, "kaos-htm-l{Enter}");
    expect(pack).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Tambah satu Topi Rajut" }));
    expect(pack).toBeEnabled();

    clock = 96_400;
    await user.click(pack);
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/complete"))).toBe(true));
    now.mockRestore();
    expect(calls.find((c) => c.path.endsWith("/complete"))?.body).toEqual({
      scans: [
        { code: "01JVARIANT0000000000000001", qty: 2 },
        { code: "sku:TOPI-01", qty: 1 },
      ],
      seconds: 95,
    });
    expect(await screen.findByText(/Pesanan 2610050AB1 dikemas/)).toBeInTheDocument();
  });

  it("sends the label to this station's agent with 'Cetak label dan lanjut'", async () => {
    localStorage.setItem(
      "omniseller.print",
      JSON.stringify({ deviceId: AGENT, format: "a4", template: "custom", packingList: true }),
    );
    const calls = api();
    const user = userEvent.setup();
    renderApp(<ShippingView />);

    await user.type(await screen.findByLabelText("Pindai nomor pesanan atau resi"), "2610050AB1{Enter}");
    const box = await screen.findByLabelText("Pindai barang (barcode atau SKU)");
    for (const code of ["8991234567891", "8991234567891", "TOPI-01"]) await user.type(box, `${code}{Enter}`);
    await user.click(await screen.findByRole("button", { name: "Cetak label dan lanjut" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/complete"))).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/complete"))?.body).toMatchObject({
      print: { deviceId: AGENT, copies: 1, format: "a4", template: "custom", packingList: true },
    });
  });

  it("says why an order cannot be packed", async () => {
    mockApi({
      "GET /v1/packing/lookup": () => ({
        ...view,
        packable: false,
        packRefusal: { code: "store.read_only", message: "Toko masih mode baca saja." },
      }),
      "GET /v1/print-agents": () => agents,
    });
    const user = userEvent.setup();
    renderApp(<ShippingView />);
    await user.type(await screen.findByLabelText("Pindai nomor pesanan atau resi"), "X{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Toko masih mode baca saja.");
    expect(screen.getByRole("button", { name: "Tandai dikemas" })).toBeDisabled();
  });

  it("shows an unknown order code as the api says it", async () => {
    mockApi({
      "GET /v1/packing/lookup": () => problem(404, "order.not_found", "Pesanan tidak ditemukan."),
      "GET /v1/print-agents": () => agents,
    });
    const user = userEvent.setup();
    renderApp(<ShippingView />);
    await user.type(await screen.findByLabelText("Pindai nomor pesanan atau resi"), "NGAWUR{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Pesanan tidak ditemukan.");
  });
});

describe("Pengiriman: labels", () => {
  beforeEach(() => setUrl("/pengiriman?tab=label"));

  it("makes one label document for the chosen orders and links it when ready", async () => {
    let polls = 0;
    const doc = {
      id: "01JDOC0000000000000000001",
      kind: "labels",
      status: "queued",
      format: "thermal",
      labelFormat: null,
      template: "standard",
      packingList: false,
      orderCount: 2,
      pageCount: null,
      result: { missing: [], dense: [] },
      error: null,
      downloadUrl: null,
      printJob: null,
    };
    const calls = mockApi({
      "GET /v1/orders": () => ({
        items: [
          {
            id: "01JORDER000000000000000001",
            externalOrderId: "2610050AB1",
            store: null,
            status: "ready_to_ship",
            statusLabel: "Siap Kirim",
            shippingProvider: "SPX",
            trackingNumber: "SPXID0001",
          },
          {
            id: "01JORDER000000000000000002",
            externalOrderId: "2610050AB2",
            store: null,
            status: "packed",
            statusLabel: "Dikemas",
            shippingProvider: "SPX",
            trackingNumber: null,
          },
        ],
        next_cursor: null,
      }),
      "GET /v1/print-agents": () => ({ items: [] }),
      "GET /v1/print-jobs": () => ({ items: [], next_cursor: null }),
      "POST /v1/documents": () => doc,
      "GET /v1/documents/01JDOC0000000000000000001": () => {
        polls += 1;
        return polls < 2
          ? doc
          : { ...doc, status: "ready", pageCount: 2, downloadUrl: "/v1/files/01JFILE0000000000000000001/download" };
      },
    });
    const user = userEvent.setup();
    renderApp(<ShippingView />);

    await user.click(await screen.findByRole("checkbox", { name: "Pilih semua pesanan" }));
    await user.click(screen.getByRole("button", { name: "Buat label (2)" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/documents")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/documents")?.body).toEqual({
      kind: "labels",
      orderIds: ["01JORDER000000000000000001", "01JORDER000000000000000002"],
      format: "thermal",
      template: "standard",
      packingList: false,
    });
    expect(await screen.findByRole("link", { name: "Unduh PDF" }, { timeout: 5_000 })).toHaveAttribute(
      "href",
      "/v1/files/01JFILE0000000000000000001/download",
    );
    expect(calls.find((c) => c.path === "/v1/orders")?.query).toMatchObject({
      status: "ready_to_pack,packed,ready_to_ship",
    });
  });
});

describe("Pengiriman: scan to print", () => {
  beforeEach(() => setUrl("/pengiriman?tab=label"));
  afterEach(() => localStorage.clear());
  const base = {
    "GET /v1/orders": () => ({ items: [], next_cursor: null }),
    "GET /v1/print-agents": () => agents,
    "GET /v1/print-jobs": () => ({ items: [], next_cursor: null }),
  };

  it("waits for this station to print on an agent", async () => {
    mockApi(base);
    renderApp(<ShippingView />);
    expect(
      await screen.findByText("Pilih agen cetak di Pengaturan cetak untuk mencetak label dengan memindai."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Pindai nomor pesanan atau resi untuk dicetak")).toBeDisabled();
  });

  it("prints the label of a scanned order on the station's agent, and says why another cannot print", async () => {
    localStorage.setItem(
      "omniseller.print",
      JSON.stringify({ deviceId: AGENT, format: "a4", template: "custom", packingList: true }),
    );
    let refuse = false;
    const calls = mockApi({
      ...base,
      "POST /v1/print-jobs/scan": (c) =>
        refuse
          ? problem(409, "label.not_ready", "Label belum tersedia: atur pengiriman dulu.")
          : Response.json(
              {
                order: {
                  ...view.order,
                  status: "ready_to_ship",
                  statusLabel: "Siap Kirim",
                  // a manual order's parcel may go without a tracking number
                  trackingNumber: (c.body as { code: string }).code === "MN-2610-0001" ? null : "SPXID0001",
                  number: (c.body as { code: string }).code === "MN-2610-0001" ? "MN-2610-0001" : "2610050AB1",
                },
                documentId: "01JDOC0000000000000000001",
                printJob: { id: "01JJOB0000000000000000001", deviceId: AGENT, kind: "label", status: "queued" },
              },
              { status: 201 },
            ),
    });
    const user = userEvent.setup();
    renderApp(<ShippingView />);
    expect(
      await screen.findByText("Pindai nomor pesanan atau resi; labelnya langsung tercetak di PC Gudang."),
    ).toBeInTheDocument();
    const box = screen.getByLabelText("Pindai nomor pesanan atau resi untuk dicetak");

    await user.type(box, " SPXID0001 {Enter}");
    expect(await screen.findByText("Label 2610050AB1 dikirim ke printer")).toBeInTheDocument();
    expect(screen.getByText("SPX Express · SPXID0001")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/v1/print-jobs/scan")?.body).toEqual({
      deviceId: AGENT,
      code: "SPXID0001",
      copies: 1,
      format: "a4",
      template: "custom",
      packingList: true,
    });
    expect(box).toHaveValue("");

    await user.type(box, "MN-2610-0001{Enter}");
    expect(await screen.findByText("Label MN-2610-0001 dikirim ke printer")).toBeInTheDocument();
    expect(screen.getByText("SPX Express")).toBeInTheDocument();

    refuse = true;
    await user.type(box, "2610050AB9{Enter}");
    expect(await screen.findByText("Label belum tersedia: atur pengiriman dulu.")).toBeInTheDocument();
    // the newest scan first
    const items = within(screen.getByRole("list", { name: "Hasil pindai" })).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("2610050AB9");
    expect(items[2]).toHaveTextContent("Label 2610050AB1 dikirim ke printer");
  });
});

describe("Pengiriman: courier handover", () => {
  beforeEach(() => setUrl("/pengiriman?tab=serah-terima"));

  it("offers no cancelling for a manifest already handed over", async () => {
    const H = "01JHANDOVER000000000000003";
    setUrl(`/pengiriman?tab=serah-terima&manifest=${H}`);
    mockApi({
      "GET /v1/warehouses": () => ({ items: [] }),
      "GET /v1/handovers/couriers": () => ({ items: [] }),
      "GET /v1/handovers": () => ({ items: [], next_cursor: null }),
      [`GET /v1/handovers/${H}`]: () => ({
        id: H,
        number: "MNF-2610-0003",
        warehouseId: null,
        courier: "J&T Express",
        status: "completed",
        parcels: 4,
        receivedBy: "Andi",
        createdBy: null,
        completedBy: null,
        completedAt: "2026-10-05T03:00:00.000Z",
        createdAt: "2026-10-05T01:00:00.000Z",
        items: [],
      }),
      "GET /v1/print-agents": () => ({ items: [] }),
    });
    renderApp(<ShippingView />);
    expect(await screen.findByText("MNF-2610-0003")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Batalkan manifest" })).not.toBeInTheDocument();
  });

  it("cancels an open manifest after asking, and goes back to the couriers", async () => {
    const H = "01JHANDOVER000000000000002";
    const detail = {
      id: H,
      number: "MNF-2610-0002",
      warehouseId: "01JWH00000000000000000000A",
      courier: "J&T Express",
      status: "open",
      parcels: 2,
      receivedBy: null,
      createdBy: null,
      completedBy: null,
      completedAt: null,
      createdAt: "2026-10-05T01:00:00.000Z",
      items: [],
    };
    setUrl(`/pengiriman?tab=serah-terima&manifest=${H}`);
    const calls = mockApi({
      "GET /v1/warehouses": () => ({ items: [] }),
      "GET /v1/handovers/couriers": () => ({ items: [] }),
      "GET /v1/handovers": () => ({ items: [], next_cursor: null }),
      [`GET /v1/handovers/${H}`]: () => detail,
      [`POST /v1/handovers/${H}/cancel`]: () => ({ ...detail, status: "cancelled" }),
      "GET /v1/print-agents": () => ({ items: [] }),
    });
    const user = userEvent.setup();
    renderApp(<ShippingView />);

    await user.click(await screen.findByRole("button", { name: "Batalkan manifest" }));
    let dialog = await screen.findByRole("dialog", { name: "Batalkan manifest MNF-2610-0002?" });
    expect(dialog).toHaveTextContent("2 paket yang sudah dipindai bisa dipindai lagi ke manifest lain.");
    await user.click(within(dialog).getByRole("button", { name: "Lanjutkan manifest" }));
    expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Batalkan manifest" }));
    dialog = await screen.findByRole("dialog", { name: "Batalkan manifest MNF-2610-0002?" });
    await user.click(within(dialog).getByRole("button", { name: "Batalkan manifest" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(true));
    expect(await screen.findByText("Manifest MNF-2610-0002 dibatalkan.")).toBeInTheDocument();
    await waitFor(() => expect(currentUrl()).toBe("/pengiriman?tab=serah-terima"));
  });

  it("opens a manifest for a courier, scans parcels into it, and completes it", async () => {
    const H = "01JHANDOVER000000000000001";
    let parcels = 0;
    const detail = () => ({
      id: H,
      number: "MNF-2610-0001",
      warehouseId: "01JWH00000000000000000000A",
      courier: "SPX Express",
      status: "open",
      parcels,
      receivedBy: null,
      createdBy: null,
      completedBy: null,
      completedAt: null,
      createdAt: "2026-10-05T01:00:00.000Z",
      items: parcels
        ? [
            {
              id: "01JHITEM00000000000000001",
              orderId: ORDER,
              trackingNumber: "SPXID0001",
              orderNumber: "2610050AB1",
              scannedBy: null,
              scannedAt: "2026-10-05T01:05:00.000Z",
            },
          ]
        : [],
    });
    const calls = mockApi({
      "GET /v1/warehouses": () => ({
        items: [
          {
            id: "01JWH00000000000000000000A",
            code: "JKT",
            name: "Gudang Jakarta",
            isDefault: true,
            active: true,
            address: {},
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      }),
      "GET /v1/handovers/couriers": () => ({ items: [{ courier: "SPX Express", parcels: 12 }] }),
      "GET /v1/handovers": () => ({ items: [], next_cursor: null }),
      "POST /v1/handovers": () => detail(),
      [`GET /v1/handovers/${H}`]: () => detail(),
      [`POST /v1/handovers/${H}/scan`]: () => {
        parcels = 1;
        return { item: detail().items[0], parcels: 1, duplicate: false };
      },
      [`POST /v1/handovers/${H}/complete`]: () => ({ handover: { ...detail(), status: "completed" }, document: null }),
      "GET /v1/print-agents": () => ({ items: [] }),
    });
    const user = userEvent.setup();
    renderApp(<ShippingView />);

    expect(await screen.findByText("12 paket")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Buka manifest" }));
    await waitFor(() => expect(currentUrl()).toBe(`/pengiriman?tab=serah-terima&manifest=${H}`));
    await user.type(await screen.findByLabelText("Pindai resi atau nomor pesanan"), "SPXID0001{Enter}");
    expect(await screen.findByText("SPXID0001 (2610050AB1) masuk manifest.")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "Selesaikan serah terima SPX Express (1 paket)" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nama kurir yang menerima (opsional)"), "Andi");
    await user.click(within(dialog).getByRole("button", { name: "Selesaikan serah terima" }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/complete"))).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/complete"))?.body).toEqual({ receivedBy: "Andi" });
    expect(calls.find((c) => c.method === "POST" && c.path === "/v1/handovers")?.body).toEqual({
      warehouseId: "01JWH00000000000000000000A",
      courier: "SPX Express",
    });
  });
});

describe("Pengiriman: who sees which station", () => {
  it("shows only the stations the user may use, starting at the first", async () => {
    setUrl("/pengiriman");
    mockApi({
      "GET /v1/warehouses": () => ({ items: [] }),
      "GET /v1/handovers": () => ({ items: [], next_cursor: null }),
    });
    renderApp(<ShippingView />, { me: testMe(["order:read", "shipment:handover"]) });
    expect(await screen.findByRole("tab", { name: "Serah terima" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Kemas" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Cetak label" })).toBeNull();
  });
});
