import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { currentUrl, setUrl } from "@/test/navigation";
import { mockApi, renderApp, testMe } from "@/test/render";
import type { ReturnDetail } from "./return-meta";
import { ReturnsView } from "./returns-view";

const ID = "01JRETURN00000000000000001";

function request(over: Partial<ReturnDetail> = {}): ReturnDetail {
  return {
    id: ID,
    store: { id: "01JSTORE000000000000000001", name: "Toko Utama", channel: "shopee", channelName: "Shopee" },
    orderId: "01JORDER000000000000000001",
    externalOrderId: "2610050AB1",
    warehouseId: "01JWH00000000000000000000A",
    kind: "return_refund",
    externalReturnId: "R-1",
    status: "requested",
    statusChangedAt: "2026-10-05T01:00:00.000Z",
    externalStatus: "REQUESTED",
    initiator: "buyer",
    reasonCode: "WRONG_SIZE",
    reason: "Ukuran tidak sesuai",
    evidence: [{ type: "image", url: "https://cf.shopee.co.id/file/bukti-1", thumbnailUrl: null, by: "buyer" }],
    refundAmount: 120_000,
    currency: "IDR",
    respondByAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
    sellerAction: null,
    awaitingDecision: true,
    goodsReturn: true,
    returnTrackingNumber: null,
    returnCarrier: null,
    decisions: [
      { code: "accept_refund", action: "accept", label: "Terima retur", reasons: [], needsEmail: false },
      {
        code: "dispute",
        action: "reject",
        label: "Sanggah",
        reasons: [
          {
            code: "R_OK",
            label: "Barang sudah sesuai pesanan",
            evidence: [{ module: 1, requirement: "Foto barang sebelum dikirim", required: true }],
          },
        ],
        needsEmail: true,
      },
    ],
    decisionsReadAt: "2026-10-05T01:00:00.000Z",
    sellerEvidence: [],
    response: null,
    receivedAt: null,
    receivedBy: null,
    receivedWarehouseId: null,
    receiptNote: null,
    items: [
      {
        id: "01JRITEM000000000000000001",
        orderItemId: "01JOITEM000000000000000001",
        sku: "KAOS-HTM-L",
        title: "Kaos Polos Hitam L",
        qty: 2,
        refundAmount: 120_000,
        sellableQty: null,
        damagedQty: null,
        missingQty: null,
        receivedAt: null,
      },
    ],
    createdAt: "2026-10-05T01:00:00.000Z",
    updatedAt: "2026-10-05T01:00:00.000Z",
    ...over,
  };
}

function api(detail: ReturnDetail) {
  return mockApi({
    "GET /v1/returns/summary": () => ({
      awaitingDecision: 1,
      dueSoon: 1,
      toReceive: 1,
      cancellations: 2,
      rto: 0,
      failedResponses: 0,
    }),
    "GET /v1/returns": () => ({ items: [detail], next_cursor: null }),
    [`GET /v1/returns/${ID}`]: () => detail,
    [`POST /v1/returns/${ID}/accept`]: () => ({ ...detail, response: null }),
    [`POST /v1/returns/${ID}/reject`]: () => detail,
    [`POST /v1/returns/${ID}/evidence`]: () => ({
      fileId: "01JFILE0000000000000000001",
      contentType: "image/jpeg",
      size: 5,
      uploadedAt: "2026-10-05T02:00:00.000Z",
    }),
    [`POST /v1/returns/${ID}/receive`]: () => ({ ...detail, receivedAt: "2026-10-05T03:00:00.000Z" }),
    "GET /v1/orders/01JORDER000000000000000001": () => ({
      items: [{ id: "01JOITEM000000000000000001", variantId: "01JVARIANT0000000000000001" }],
    }),
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
  });
}

describe("ReturnsView", () => {
  beforeEach(() => setUrl("/retur"));

  it("lists requests with their kind, reason, and answer window, and opens one", async () => {
    const calls = api(request());
    const user = userEvent.setup();
    renderApp(<ReturnsView />);

    expect(await screen.findByRole("tab", { name: /Pembatalan\s*2/ })).toBeInTheDocument();
    expect((await screen.findAllByText("Retur dan refund")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ukuran tidak sesuai").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/jam .*lagi/).length).toBeGreaterThan(0);
    expect(calls.find((c) => c.path === "/v1/returns")?.query).toMatchObject({ group: "returns", limit: "50" });

    await user.click(screen.getAllByText("2610050AB1")[0]!);
    expect(currentUrl()).toBe(`/retur?id=${ID}`);
    expect(await screen.findByRole("button", { name: "Terima retur" })).toBeInTheDocument();
  });

  it("asks the api for the chosen tab and filter", async () => {
    const calls = api(request({ kind: "cancellation" }));
    const user = userEvent.setup();
    renderApp(<ReturnsView />);

    await user.click(await screen.findByRole("tab", { name: /Pembatalan/ }));
    expect(currentUrl()).toBe("/retur?tab=cancellations");
    await user.click(screen.getByRole("button", { name: "Menunggu keputusan" }));
    expect(currentUrl()).toBe("/retur?tab=cancellations&awaiting=true");
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/v1/returns").at(-1)?.query).toMatchObject({
        group: "cancellations",
        awaitingDecision: "true",
      }),
    );
  });

  it("accepts with the marketplace's decision code after confirming", async () => {
    setUrl(`/retur?id=${ID}`);
    const calls = api(request());
    const user = userEvent.setup();
    renderApp(<ReturnsView />);

    await user.click(await screen.findByRole("button", { name: "Terima retur" }));
    const dialog = await screen.findByRole("dialog", { name: "Terima retur" });
    expect(within(dialog).getByText(/Rp 120\.000/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Kirim keputusan" }));
    await waitFor(() => expect(calls.some((c) => c.path === `/v1/returns/${ID}/accept`)).toBe(true));
    expect(calls.find((c) => c.path === `/v1/returns/${ID}/accept`)?.body).toEqual({ decision: "accept_refund" });
  });

  it("disputes with the reason, the photo the marketplace asks for, and a contact email", async () => {
    setUrl(`/retur?id=${ID}`);
    const calls = api(request());
    const user = userEvent.setup();
    renderApp(<ReturnsView />);

    await user.click(await screen.findByRole("button", { name: "Sanggah" }));
    const dialog = await screen.findByRole("dialog", { name: "Sanggah" });
    await user.click(within(dialog).getByRole("button", { name: "Kirim keputusan" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Foto barang sebelum dikirim");

    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      input,
      new File([new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x41])], "kemasan.jpg", { type: "image/jpeg" }),
    );
    await waitFor(() => expect(within(dialog).getByAltText("kemasan.jpg")).toBeInTheDocument());
    expect(calls.find((c) => c.path === `/v1/returns/${ID}/evidence`)?.body).toEqual({ content: "/9j/AEE=" });

    await user.type(within(dialog).getByLabelText("Email kontak"), "rina@example.test");
    await user.click(within(dialog).getByRole("button", { name: "Kirim keputusan" }));
    await waitFor(() => expect(calls.some((c) => c.path === `/v1/returns/${ID}/reject`)).toBe(true));
    expect(calls.find((c) => c.path === `/v1/returns/${ID}/reject`)?.body).toEqual({
      decision: "dispute",
      reason: "R_OK",
      email: "rina@example.test",
      evidence: [{ fileId: "01JFILE0000000000000000001", module: 1 }],
    });
  });

  it("records what came back, and refuses counts that do not add up", async () => {
    setUrl(`/retur?id=${ID}`);
    const calls = api(request({ awaitingDecision: false, status: "in_transit", decisions: [] }));
    const user = userEvent.setup();
    renderApp(<ReturnsView />);

    const damaged = await screen.findByLabelText("Rusak");
    await user.clear(damaged);
    await user.type(damaged, "1");
    expect(screen.getByText("Jumlah ketiganya harus 2.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simpan penerimaan" })).toBeDisabled();

    const sellable = screen.getByLabelText("Layak jual");
    await user.clear(sellable);
    await user.type(sellable, "1");
    await user.type(screen.getByLabelText("Catatan penerimaan (opsional)"), "Satu kaos sobek");
    await user.click(screen.getByRole("button", { name: "Simpan penerimaan" }));
    await waitFor(() => expect(calls.some((c) => c.path === `/v1/returns/${ID}/receive`)).toBe(true));
    expect(calls.find((c) => c.path === `/v1/returns/${ID}/receive`)?.body).toEqual({
      warehouseId: "01JWH00000000000000000000A",
      note: "Satu kaos sobek",
      items: [{ returnItemId: "01JRITEM000000000000000001", sellable: 1, damaged: 1, missing: 0 }],
    });
  });

  it("offers no decisions for a store still in parallel mode, and says where to answer", async () => {
    setUrl(`/retur?id=${ID}`);
    const detail = request();
    mockApi({
      [`GET /v1/returns/${ID}`]: () => detail,
      "GET /v1/returns/summary": () => ({
        awaitingDecision: 1,
        dueSoon: 0,
        toReceive: 1,
        cancellations: 0,
        rto: 0,
        failedResponses: 0,
      }),
      "GET /v1/returns": () => ({ items: [detail], next_cursor: null }),
      "GET /v1/stores": () => ({
        items: [
          { id: detail.store!.id, name: "Toko Utama", channel: "shopee", status: "active", syncMode: "read_only" },
        ],
      }),
    });
    renderApp(<ReturnsView />);
    expect(await screen.findByText(/Toko Utama masih mode uji berdampingan/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terima retur" })).toBeNull();
    // the goods may still come back into stock
    expect(screen.getByRole("button", { name: "Simpan penerimaan" })).toBeInTheDocument();
  });

  it("shows decisions and the receipt only to those allowed", async () => {
    setUrl(`/retur?id=${ID}`);
    api(request());
    renderApp(<ReturnsView />, { me: testMe(["order:read"]) });
    expect(await screen.findByText("Ukuran tidak sesuai", { selector: "dd" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terima retur" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Simpan penerimaan" })).toBeNull();
  });
});
