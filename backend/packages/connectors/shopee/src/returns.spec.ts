import { PermanentConnectorError, type ReturnResponse } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { createShopeeConnector } from "./connector.js";
import { type ShopeeReturn, shopeeReturnState } from "./returns.js";

type Handler = (url: URL, init: RequestInit) => unknown;

function fakeFetch(routes: Record<string, Handler>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const route = routes[`${init.method ?? "GET"} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: "error_param", message: "no route" }), { status: 404 });
    const out = route(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

function connector(fetchImpl: typeof fetch) {
  return createShopeeConnector({
    partnerId: 2001887,
    partnerKey: "partner-key-for-tests",
    apiBaseUrl: "https://partner.shopeemobile.com",
    authBaseUrl: "https://open.shopee.com",
    http: { fetch: fetchImpl },
    variantDelayMs: 0,
  });
}

const shop = { externalShopId: "14701711", accessToken: "token", shopCipher: null };
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body));
const DAY = 86_400;

const shopeeReturn: ShopeeReturn & Record<string, unknown> = {
  return_sn: "2410180TVYXVRQ0",
  order_sn: "241016F6B94MQK",
  status: "REQUESTED",
  reason: "ITEM_WRONGDAMAGED",
  text_reason: "Ukuran tidak sesuai",
  image: ["https://cf.shopee.co.id/file/evidence-1"],
  refund_amount: 120000,
  currency: "IDR",
  create_time: 1_790_000_000,
  update_time: 1_790_000_600,
  due_date: 1_790_172_800,
  return_seller_due_date: 1_790_600_000,
  tracking_number: "",
  needs_logistics: true,
  return_solution: 0,
  negotiation_status: "TERMINATED",
  user: { username: "pembeli_rahasia", email: "pembeli@example.com", portrait: "https://cf.shopee.co.id/file/p" },
  item: [
    {
      item_id: 1_750_000_001,
      model_id: 2_100_000_001,
      name: "Kaos Polos",
      amount: 2,
      item_sku: "KAOS",
      variation_sku: "KAOS-HTM-M",
      refund_amount: 110000,
    },
    { item_id: 1_750_000_002, model_id: 0, name: "Topi", amount: 1, item_sku: "TOPI" },
    { item_id: 1_750_000_003, model_id: 0, name: "Kosong", amount: 0 },
  ],
};

describe("Shopee returns", () => {
  it("lists returns by update time in 15-day windows, page by page, and normalizes them", async () => {
    const from = 1_790_000_000;
    const to = from + 20 * DAY;
    const f = fakeFetch({
      "GET /api/v2/returns/get_return_list": (url) => ({
        error: "",
        response: {
          more: url.searchParams.get("page_no") === "0" && url.searchParams.get("update_time_from") === String(from),
          return: url.searchParams.get("page_no") === "0" ? [shopeeReturn, { status: "REQUESTED" }] : [],
        },
      }),
    });
    const c = connector(f.fn);
    const p1 = await c.returns.listReturns(shop, { from: new Date(from * 1000), to: new Date(to * 1000) });
    const p2 = await c.returns.listReturns(shop, {
      from: new Date(from * 1000),
      to: new Date(to * 1000),
      cursor: p1.nextCursor,
    });
    const p3 = await c.returns.listReturns(shop, {
      from: new Date(from * 1000),
      to: new Date(to * 1000),
      cursor: p2.nextCursor,
    });
    expect(
      f.calls.map((x) => [
        x.url.searchParams.get("page_no"),
        x.url.searchParams.get("page_size"),
        Number(x.url.searchParams.get("update_time_from")),
        Number(x.url.searchParams.get("update_time_to")),
      ]),
    ).toEqual([
      ["0", "100", from, from + 15 * DAY - 60],
      ["1", "100", from, from + 15 * DAY - 60],
      ["0", "100", from + 15 * DAY - 60, to],
    ]);
    expect(p3.nextCursor).toBeNull();
    expect(p1.returns).toEqual([
      {
        externalReturnId: "2410180TVYXVRQ0",
        externalOrderId: "241016F6B94MQK",
        kind: "return_refund",
        state: "requested",
        externalStatus: "REQUESTED",
        initiator: "buyer",
        reasonCode: "ITEM_WRONGDAMAGED",
        reason: "Ukuran tidak sesuai",
        evidence: [{ type: "image", url: "https://cf.shopee.co.id/file/evidence-1", thumbnailUrl: null, by: "buyer" }],
        refundAmount: 120_000,
        currency: "IDR",
        respondBy: new Date(1_790_172_800_000),
        sellerAction: null,
        goodsReturn: true,
        returnTrackingNumber: null,
        returnCarrier: null,
        createdAt: new Date(1_790_000_000_000),
        updatedAt: new Date(1_790_000_600_000),
        items: [
          {
            externalItemId: "1750000001",
            externalVariantId: "2100000001",
            quantity: 2,
            sku: "KAOS-HTM-M",
            title: "Kaos Polos",
            refundAmount: 110_000,
          },
          {
            externalItemId: "1750000002",
            externalVariantId: "",
            quantity: 1,
            sku: "TOPI",
            title: "Topi",
            refundAmount: null,
          },
        ],
      },
    ]);
    // the buyer's email and name never leave the connector
    expect(JSON.stringify(p1)).not.toMatch(/pembeli@example.com|pembeli_rahasia/);
  });

  it("maps statuses, negotiation, and refund-only requests", () => {
    const s = (over: Partial<ShopeeReturn>) => shopeeReturnState({ ...shopeeReturn, ...over });
    expect(s({ status: "REQUESTED", negotiation_status: "PENDING_BUYER_RESPOND" })).toBe("negotiating");
    expect(s({ status: "ACCEPTED" })).toBe("accepted");
    expect(s({ status: "ACCEPTED", tracking_number: "SPXID0001" })).toBe("in_transit");
    expect(s({ status: "ACCEPTED", needs_logistics: false })).toBe("refunded");
    expect(s({ status: "PROCESSING", needs_logistics: false, tracking_number: "x" })).toBe("accepted");
    expect(s({ status: "SELLER_DISPUTE" })).toBe("disputed");
    expect(s({ status: "JUDGING" })).toBe("disputed");
    expect(s({ status: "CANCELLED" })).toBe("cancelled");
    expect(s({ status: "CLOSED" })).toBe("closed");
  });

  it("reads returns one by one with their details, leaving unknown ones out", async () => {
    const f = fakeFetch({
      "GET /api/v2/returns/get_return_detail": (url) =>
        url.searchParams.get("return_sn") === "2410180TVYXVRQ0"
          ? {
              error: "",
              response: {
                ...shopeeReturn,
                status: "ACCEPTED",
                return_solution: 1,
                needs_logistics: false,
                buyer_videos: [{ video_url: "https://cvf.shopee.co.id/v", thumbnail_url: "https://cf.shopee.co.id/t" }],
                return_pickup_address: { name: "Budi", phone: "6281200000000", address: "Jl. Rahasia 1" },
              },
            }
          : { error: "", response: {} },
    });
    const got = await connector(f.fn).returns.getReturns(shop, ["2410180TVYXVRQ0", "UNKNOWN", "2410180TVYXVRQ0"]);
    expect(f.calls).toHaveLength(2);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      kind: "refund_only",
      state: "refunded",
      goodsReturn: false,
      respondBy: new Date(1_790_600_000_000),
    });
    expect(got[0]!.evidence).toEqual([
      { type: "image", url: "https://cf.shopee.co.id/file/evidence-1", thumbnailUrl: null, by: "buyer" },
      { type: "video", url: "https://cvf.shopee.co.id/v", thumbnailUrl: "https://cf.shopee.co.id/t", by: "buyer" },
    ]);
    expect(JSON.stringify(got)).not.toMatch(/Rahasia|6281200000000|Budi/);
  });

  it("reads cancellation requests from the orders: open in IN_CANCEL, accepted once cancelled, closed otherwise", async () => {
    const order = (sn: string, status: string) => ({
      order_sn: sn,
      order_status: status,
      currency: "IDR",
      total_amount: 75000,
      create_time: 1_790_000_000,
      update_time: 1_790_000_900,
      buyer_cancel_reason: "Ingin mengubah alamat",
      item_list: [
        {
          item_id: 1_750_000_001,
          model_id: 2_100_000_001,
          item_name: "Kaos",
          model_quantity_purchased: 3,
          model_discounted_price: 25000,
          cancelled_qty: 1,
        },
        {
          item_id: 1_750_000_002,
          model_id: 0,
          item_name: "Topi",
          model_quantity_purchased: 1,
          model_discounted_price: 25000,
          cancelled_qty: 1,
        },
      ],
    });
    const f = fakeFetch({
      "GET /api/v2/order/get_order_detail": () => ({
        error: "",
        response: { order_list: [order("A", "IN_CANCEL"), order("B", "CANCELLED"), order("C", "READY_TO_SHIP")] },
      }),
    });
    const got = await connector(f.fn).returns.cancellations(shop, ["A", "B", "C"]);
    expect(f.calls[0]!.url.searchParams.get("order_sn_list")).toBe("A,B,C");
    expect(got.map((c) => [c.externalReturnId, c.externalOrderId, c.kind, c.state, c.externalStatus])).toEqual([
      ["A", "A", "cancellation", "requested", "IN_CANCEL"],
      ["B", "B", "cancellation", "accepted", "CANCELLED"],
      ["C", "C", "cancellation", "closed", "READY_TO_SHIP"],
    ]);
    expect(got[0]).toMatchObject({
      reason: "Ingin mengubah alamat",
      refundAmount: 75_000,
      respondBy: null,
      updatedAt: new Date(1_790_000_900_000),
      items: [{ externalItemId: "1750000001", externalVariantId: "2100000001", quantity: 2, refundAmount: 75_000 }],
    });
  });

  it("offers ACCEPT and REJECT for an open cancellation without calling Shopee", async () => {
    const f = fakeFetch({});
    const c = connector(f.fn);
    const open = await c.returns.details(shop, {
      externalReturnId: "A",
      externalOrderId: "A",
      kind: "cancellation",
      externalStatus: "IN_CANCEL",
    });
    expect(open.decisions.map((d) => [d.code, d.action])).toEqual([
      ["ACCEPT", "accept"],
      ["REJECT", "reject"],
    ]);
    const done = await c.returns.details(shop, {
      externalReturnId: "B",
      externalOrderId: "B",
      kind: "cancellation",
      externalStatus: "CANCELLED",
    });
    expect(done).toEqual({ decisions: [], evidence: null });
    expect(f.calls).toHaveLength(0);
  });

  const reasons = {
    error: "",
    response: {
      dispute_reason_list: [
        {
          dispute_reason: "47",
          dispute_requirement: "Kirim bukti",
          evidence_module_list: [
            { module_index: 1, requirement: "Foto atau video membuka paket retur dengan resi.", is_required: true },
            { module_index: 2, requirement: "Foto barang retur.", is_required: false },
          ],
        },
        { dispute_reason: 999, evidence_module_list: [] },
        { dispute_reason: "" },
      ],
    },
  };

  it("offers confirm and dispute by the current status, with dispute reasons and their evidence modules", async () => {
    const f = fakeFetch({
      "GET /api/v2/returns/get_return_detail": () => ({
        error: "",
        response: { ...shopeeReturn, status: "PROCESSING" },
      }),
      "GET /api/v2/returns/get_return_dispute_reason": () => reasons,
    });
    const details = await connector(f.fn).returns.details(shop, {
      externalReturnId: "2410180TVYXVRQ0",
      externalOrderId: "241016F6B94MQK",
      kind: "return_refund",
      externalStatus: "REQUESTED",
    });
    expect(details).toEqual({
      decisions: [
        { code: "confirm", action: "accept", label: "Setujui pengembalian dana", reasons: [], needsEmail: false },
        {
          code: "dispute",
          action: "reject",
          label: "Ajukan sanggahan ke Shopee",
          reasons: [
            {
              code: "47",
              label: "Barang retur diterima dalam keadaan rusak fisik",
              evidence: [
                { module: 1, requirement: "Foto atau video membuka paket retur dengan resi.", required: true },
                { module: 2, requirement: "Foto barang retur.", required: false },
              ],
            },
            { code: "999", label: "Alasan 999", evidence: [] },
          ],
          needsEmail: true,
        },
      ],
      evidence: [{ type: "image", url: "https://cf.shopee.co.id/file/evidence-1", thumbnailUrl: null, by: "buyer" }],
    });

    // accepted: the buyer sends the goods back; a dispute is still possible, a confirmation is not
    const f3 = fakeFetch({
      "GET /api/v2/returns/get_return_detail": () => ({ error: "", response: { ...shopeeReturn, status: "ACCEPTED" } }),
      "GET /api/v2/returns/get_return_dispute_reason": () => reasons,
    });
    const accepted = await connector(f3.fn).returns.details(shop, {
      externalReturnId: "2410180TVYXVRQ0",
      externalOrderId: "241016F6B94MQK",
      kind: "return_refund",
      externalStatus: "ACCEPTED",
    });
    expect(accepted.decisions.map((d) => d.code)).toEqual(["dispute"]);

    // closed in the meantime: nothing to decide, and no reasons are asked for
    const f2 = fakeFetch({
      "GET /api/v2/returns/get_return_detail": () => ({ error: "", response: { ...shopeeReturn, status: "CLOSED" } }),
      "GET /api/v2/returns/get_return_dispute_reason": () => reasons,
    });
    const closed = await connector(f2.fn).returns.details(shop, {
      externalReturnId: "2410180TVYXVRQ0",
      externalOrderId: "241016F6B94MQK",
      kind: "return_refund",
      externalStatus: "REQUESTED",
    });
    expect(closed.decisions).toEqual([]);
    expect(f2.calls.map((x) => x.url.pathname)).toEqual(["/api/v2/returns/get_return_detail"]);
  });

  it("converts an evidence photo into a Shopee URL", async () => {
    const f = fakeFetch({
      "POST /api/v2/returns/convert_image": () => ({
        error: "",
        response: { url: "https://file-proxy.shopee.co.id/api/v2/files/e.jpg", thumbnail: "t" },
      }),
    });
    const up = await connector(f.fn).returns.uploadEvidence(shop, {
      externalReturnId: "2410180TVYXVRQ0",
      kind: "return_refund",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      contentType: "image/png",
    });
    expect(up).toEqual({
      ref: "https://file-proxy.shopee.co.id/api/v2/files/e.jpg",
      contentType: "image/png",
      width: null,
      height: null,
    });
    const form = f.calls[0]!.init.body as FormData;
    expect(form.get("return_sn")).toBe("2410180TVYXVRQ0");
    expect((form.get("upload_image") as File).name).toBe("evidence.png");
  });

  const response = (over: Partial<ReturnResponse>): ReturnResponse => ({
    externalReturnId: "2410180TVYXVRQ0",
    externalOrderId: "241016F6B94MQK",
    kind: "return_refund",
    decision: "confirm",
    reason: null,
    comment: null,
    evidence: [],
    email: null,
    idempotencyKey: "k",
    ...over,
  });

  it("confirms, disputes with grouped evidence, and handles buyer cancellations", async () => {
    const f = fakeFetch({
      "POST /api/v2/returns/confirm": () => ({ error: "", response: { return_sn: "2410180TVYXVRQ0" } }),
      "GET /api/v2/returns/get_return_dispute_reason": () => reasons,
      "POST /api/v2/returns/dispute": () => ({ error: "", response: { return_sn: "2410180TVYXVRQ0", msg: "ok" } }),
      "POST /api/v2/order/handle_buyer_cancellation": () => ({ error: "", response: { update_time: 1 } }),
    });
    const c = connector(f.fn);
    await c.returns.respond(shop, response({}));
    await c.returns.respond(
      shop,
      response({
        decision: "dispute",
        reason: "47",
        comment: "Barang retur pecah",
        email: "gudang@tokoku.id",
        evidence: [
          { ref: "https://f/1.jpg", contentType: "image/jpeg", width: null, height: null, module: 1 },
          { ref: "https://f/2.jpg", contentType: "image/jpeg", width: null, height: null, module: 1 },
          { ref: "https://f/3.jpg", contentType: "image/jpeg", width: null, height: null, module: 3 },
        ],
      }),
    );
    await c.returns.respond(
      shop,
      response({ kind: "cancellation", externalReturnId: "A", externalOrderId: "A", decision: "REJECT" }),
    );
    expect(f.calls.map((x) => [x.init.method ?? "GET", x.url.pathname, x.init.body ? bodyOf(x.init) : null])).toEqual([
      ["POST", "/api/v2/returns/confirm", { return_sn: "2410180TVYXVRQ0" }],
      ["GET", "/api/v2/returns/get_return_dispute_reason", null],
      [
        "POST",
        "/api/v2/returns/dispute",
        {
          return_sn: "2410180TVYXVRQ0",
          email: "gudang@tokoku.id",
          dispute_reason_id: 47,
          dispute_text_reason: "Barang retur pecah",
          // module 3 is not one of the reason's modules; module 2 has no photo
          image_list: [
            {
              module_index: 1,
              requirement: "Foto atau video membuka paket retur dengan resi.",
              image_url: ["https://f/1.jpg", "https://f/2.jpg"],
            },
          ],
        },
      ],
      ["POST", "/api/v2/order/handle_buyer_cancellation", { order_sn: "A", operation: "REJECT" }],
    ]);
  });

  it("refuses incomplete disputes, withdrawn reasons, and unknown decisions", async () => {
    const f = fakeFetch({ "GET /api/v2/returns/get_return_dispute_reason": () => reasons });
    const c = connector(f.fn);
    await expect(c.returns.respond(shop, response({ decision: "dispute", reason: "47" }))).rejects.toThrow(/email/);
    await expect(
      c.returns.respond(shop, response({ decision: "dispute", reason: "13", email: "a@b.id" })),
    ).rejects.toThrow(/no longer offered/);
    await expect(c.returns.respond(shop, response({ decision: "offer" }))).rejects.toBeInstanceOf(
      PermanentConnectorError,
    );
    await expect(c.returns.respond(shop, response({ kind: "cancellation", decision: "confirm" }))).rejects.toThrow(
      /not supported/,
    );
    expect(f.calls.map((x) => x.url.pathname)).toEqual(["/api/v2/returns/get_return_dispute_reason"]);
  });
});
