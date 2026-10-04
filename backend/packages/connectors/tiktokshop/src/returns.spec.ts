import { PermanentConnectorError, type ReturnResponse } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { tiktokSign, tiktokSignString } from "./client.js";
import { createTiktokShopConnector } from "./connector.js";
import { tiktokReturnState } from "./returns.js";
import { parseTiktokWebhook } from "./webhooks.js";

type Handler = (url: URL, init: RequestInit) => unknown;

function fakeFetch(routes: Record<string, Handler>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fn = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const route = Object.entries(routes).find(([k]) => {
      const [method, pattern] = k.split(" ");
      return method === (init.method ?? "GET") && new RegExp(`^${pattern}$`).test(url.pathname);
    })?.[1];
    if (!route) return new Response(JSON.stringify({ code: 36009009, message: "Invalid path" }), { status: 404 });
    const out = route(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

function connector(fetchImpl: typeof fetch) {
  return createTiktokShopConnector({
    appKey: "app-key",
    appSecret: "app-secret",
    apiBaseUrl: "https://open-api.tiktokglobalshop.com",
    authBaseUrl: "https://auth.tiktok-shops.com",
    authorizeUrl: "https://services.tiktokshop.com/open/authorize",
    http: { fetch: fetchImpl },
  });
}

const shop = { externalShopId: "7495000000000000001", accessToken: "TTP_access", shopCipher: "ROW_cipher" };
const ok = (data: unknown) => ({ code: 0, message: "Success", request_id: "r", data });
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body));

const line = (sku: string, refund: string) => ({
  return_line_item_id: `rl-${sku}-${refund}`,
  order_line_item_id: `ol-${sku}`,
  sku_id: sku,
  sku_name: "Hitam, M",
  product_name: "Kaos Polos",
  seller_sku: `SKU-${sku}`,
  refund_amount: { currency: "IDR", refund_total: refund },
});

const returnOrder = {
  return_id: "4035318504086604100",
  order_id: "577686530908261117",
  return_type: "RETURN_AND_REFUND",
  return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
  role: "BUYER",
  return_reason: "ecom_order_delivered_refund_and_return_reason_wrong_size",
  return_reason_text: "Ukuran tidak sesuai",
  return_tracking_number: "",
  can_buyer_keep_item: false,
  create_time: 1_790_000_000,
  update_time: 1_790_000_600,
  seller_next_action_response: [
    { action: "SELLER_RESPOND_RETURN", deadline: 1_790_172_800 },
    { action: "SELLER_RESPOND_REFUND", deadline: 1_790_100_000 },
  ],
  return_line_items: [
    line("1729000000000000001", "55000"),
    line("1729000000000000001", "55000"),
    line("1729000000000000002", "60000"),
  ],
  refund_amount: { currency: "IDR", refund_total: "170000" },
};

describe("TikTok Shop returns", () => {
  it("lists returns updated in a range, 50 a page by update time, and normalizes them", async () => {
    const f = fakeFetch({
      "POST /return_refund/202602/returns/search": () =>
        ok({ return_orders: [returnOrder], next_page_token: "next-1" }),
    });
    const page = await connector(f.fn).returns.listReturns(shop, {
      from: new Date(1_790_000_000_000),
      to: new Date(1_790_003_600_000),
      cursor: "page-0",
    });
    const call = f.calls[0]!;
    expect(call.url.searchParams.get("page_size")).toBe("50");
    expect(call.url.searchParams.get("sort_field")).toBe("update_time");
    expect(call.url.searchParams.get("sort_order")).toBe("ASC");
    expect(call.url.searchParams.get("page_token")).toBe("page-0");
    expect(call.url.searchParams.get("shop_cipher")).toBe("ROW_cipher");
    expect(bodyOf(call.init)).toEqual({
      update_time_ge: 1_790_000_000,
      update_time_lt: 1_790_003_600,
      locale: "id-ID",
    });
    expect(page.nextCursor).toBe("next-1");
    expect(page.returns).toEqual([
      {
        externalReturnId: "4035318504086604100",
        externalOrderId: "577686530908261117",
        kind: "return_refund",
        state: "requested",
        externalStatus: "RETURN_OR_REFUND_REQUEST_PENDING",
        initiator: "buyer",
        reasonCode: "ecom_order_delivered_refund_and_return_reason_wrong_size",
        reason: "Ukuran tidak sesuai",
        evidence: [],
        refundAmount: 170_000,
        currency: "IDR",
        // the earliest deadline wins
        respondBy: new Date(1_790_100_000_000),
        sellerAction: "SELLER_RESPOND_REFUND",
        goodsReturn: true,
        returnTrackingNumber: null,
        returnCarrier: null,
        createdAt: new Date(1_790_000_000_000),
        updatedAt: new Date(1_790_000_600_000),
        items: [
          {
            externalItemId: "",
            externalVariantId: "1729000000000000001",
            quantity: 2,
            sku: "SKU-1729000000000000001",
            title: "Kaos Polos",
            refundAmount: 110_000,
          },
          {
            externalItemId: "",
            externalVariantId: "1729000000000000002",
            quantity: 1,
            sku: "SKU-1729000000000000002",
            title: "Kaos Polos",
            refundAmount: 60_000,
          },
        ],
      },
    ]);
  });

  it("maps statuses, arbitration, and request types", async () => {
    expect(tiktokReturnState("AWAITING_BUYER_SHIP")).toBe("accepted");
    expect(tiktokReturnState("BUYER_SHIPPED_ITEM")).toBe("in_transit");
    expect(tiktokReturnState("AWAITING_BUYER_RESPONSE")).toBe("negotiating");
    expect(tiktokReturnState("REJECT_RECEIVE_PACKAGE")).toBe("rejected");
    expect(tiktokReturnState("REJECT_RECEIVE_PACKAGE", "IN_PROGRESS")).toBe("disputed");
    expect(tiktokReturnState("REFUND_OR_RETURN_REQUEST_REJECT", "SUPPORT_SELLER")).toBe("closed");
    expect(tiktokReturnState("RETURN_OR_REFUND_REQUEST_COMPLETE")).toBe("refunded");
    expect(tiktokReturnState("REPLACEMENT_REQUEST_COMPLETE")).toBe("closed");
    // the webhook page spells this one with two underscores
    expect(tiktokReturnState("RETURN_OR_REFUND__REQUEST_CANCELLED")).toBe("cancelled");

    const f = fakeFetch({
      "POST /return_refund/202602/returns/search": () =>
        ok({
          return_orders: [
            { ...returnOrder, return_type: "REFUND", return_status: "RETURN_OR_REFUND_REQUEST_SUCCESS" },
            { ...returnOrder, return_id: "2", return_type: "REPLACEMENT", can_buyer_keep_item: true },
            { ...returnOrder, return_id: "3", return_status: "BUYER_SHIPPED_ITEM", arbitration_status: "IN_PROGRESS" },
          ],
        }),
    });
    const page = await connector(f.fn).returns.listReturns(shop, { from: new Date(0), to: new Date(1000) });
    expect(page.nextCursor).toBeNull();
    expect(page.returns.map((r) => [r.kind, r.state, r.goodsReturn, r.externalStatus])).toEqual([
      ["refund_only", "refunded", false, "RETURN_OR_REFUND_REQUEST_SUCCESS"],
      ["replacement", "requested", false, "RETURN_OR_REFUND_REQUEST_PENDING"],
      ["return_refund", "disputed", true, "BUYER_SHIPPED_ITEM (ARBITRATION)"],
    ]);
  });

  it("reads returns by id, 50 ids a request, following page tokens", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => String(4_035_000_000 + i));
    const f = fakeFetch({
      "POST /return_refund/202602/returns/search": (url, init) => {
        const asked = bodyOf(init).return_ids as string[];
        if (asked.length === 50 && !url.searchParams.get("page_token")) {
          return ok({ return_orders: [{ ...returnOrder, return_id: asked[0] }], next_page_token: "more" });
        }
        return ok({ return_orders: [{ ...returnOrder, return_id: asked.at(-1) }] });
      },
    });
    const got = await connector(f.fn).returns.getReturns(shop, [...ids, ids[0]!]);
    expect(f.calls.map((c) => bodyOf(c.init).return_ids.length)).toEqual([50, 50, 1]);
    expect(f.calls[1]!.url.searchParams.get("page_token")).toBe("more");
    expect(got.map((r) => r.externalReturnId)).toEqual([ids[0], ids[49], ids[50]]);
  });

  it("reads the buyers' cancellation requests of orders, never seller or system cancellations", async () => {
    const f = fakeFetch({
      "POST /return_refund/202602/cancellations/search": () =>
        ok({
          cancellations: [
            {
              cancel_id: "4035400000000000001",
              order_id: "577000000000000001",
              cancel_type: "BUYER_CANCEL",
              cancel_status: "CANCELLATION_REQUEST_PENDING",
              role: "BUYER",
              cancel_reason: "ecom_order_to_ship_canceled_reason_created_by_mistakes",
              cancel_reason_text: "Pesanan dibuat tidak sengaja",
              create_time: 1_790_000_000,
              update_time: 1_790_000_100,
              seller_next_action_response: [{ action: "SELLER_RESPOND_CANCEL", deadline: 1_790_172_800 }],
              refund_amount: { currency: "IDR", refund_total: "55000" },
              cancel_line_items: [line("1729000000000000001", "55000")],
            },
            { cancel_id: "4035400000000000002", order_id: "577000000000000002", cancel_type: "CANCEL" },
            {
              cancel_id: "4035400000000000003",
              order_id: "577000000000000003",
              cancel_type: "BUYER_CANCEL",
              cancel_status: "CANCELLATION_REQUEST_CANCEL",
            },
          ],
        }),
    });
    const got = await connector(f.fn).returns.cancellations(shop, ["577000000000000001", "577000000000000003"]);
    expect(bodyOf(f.calls[0]!.init)).toEqual({
      order_ids: ["577000000000000001", "577000000000000003"],
      cancel_types: ["BUYER_CANCEL"],
      locale: "id-ID",
    });
    expect(got.map((c) => [c.externalReturnId, c.kind, c.state, c.respondBy?.getTime() ?? null])).toEqual([
      ["4035400000000000001", "cancellation", "requested", 1_790_172_800_000],
      ["4035400000000000003", "cancellation", "cancelled", null],
    ]);
    expect(got[0]).toMatchObject({
      externalOrderId: "577000000000000001",
      reason: "Pesanan dibuat tidak sengaja",
      sellerAction: "SELLER_RESPOND_CANCEL",
      refundAmount: 55_000,
      goodsReturn: false,
      items: [{ externalVariantId: "1729000000000000001", quantity: 1 }],
    });
  });

  it("offers the eligible decisions with their reject reasons, and the photos of the records", async () => {
    const eligibility = ok({
      decisions: [
        { decision: "APPROVE_RETURN", eligible: true },
        { decision: "APPROVE_REFUND", eligible: false, ineligible_reason: "not a refund" },
        {
          decision: "REJECT_RETURN",
          eligible: true,
          available_reject_reasons: [
            { name: "seller_reject_apply_product_has_been_packed", text: "Produk sudah dikemas" },
            { name: "seller_reject_no_text" },
            { text: "no name" },
          ],
        },
        { decision: "ISSUE_EXCHANGE_REFUND", eligible: true },
        { decision: "APPROVE_REQUEST_CANCEL", eligible: true },
      ],
    });
    const f = fakeFetch({
      "GET /return_refund/202601/decision_eligibility": () => eligibility,
      "GET /return_refund/202309/returns/[0-9]+/records": () =>
        ok({
          records: [
            {
              role: "BUYER",
              images: [{ url: "https://p16.ibyteimg.com/a.jpeg" }],
              videos: [{ url: "https://v16.akamaized.net/v", cover: "https://p16.ibyteimg.com/c.jpeg" }],
            },
            { role: "SELLER", images: [{ url: "https://p16.ibyteimg.com/s.jpeg" }, {}] },
            { role: "SYSTEM" },
          ],
        }),
    });
    const c = connector(f.fn);
    const details = await c.returns.details(shop, {
      externalReturnId: "4035318504086604100",
      externalOrderId: "577686530908261117",
      kind: "return_refund",
      externalStatus: "RETURN_OR_REFUND_REQUEST_PENDING",
    });
    expect(f.calls[0]!.url.searchParams.get("return_or_cancel_id")).toBe("4035318504086604100");
    expect(f.calls[0]!.url.searchParams.get("locale")).toBe("id-ID");
    expect(f.calls[0]!.url.searchParams.has("check_decisions")).toBe(false);
    expect(details).toEqual({
      decisions: [
        {
          code: "APPROVE_RETURN",
          action: "accept",
          label: "Setujui pengembalian barang",
          reasons: [],
          needsEmail: false,
        },
        {
          code: "REJECT_RETURN",
          action: "reject",
          label: "Tolak pengembalian barang",
          reasons: [
            { code: "seller_reject_apply_product_has_been_packed", label: "Produk sudah dikemas", evidence: [] },
            { code: "seller_reject_no_text", label: "seller_reject_no_text", evidence: [] },
          ],
          needsEmail: false,
        },
      ],
      evidence: [
        { type: "image", url: "https://p16.ibyteimg.com/a.jpeg", thumbnailUrl: null, by: "buyer" },
        {
          type: "video",
          url: "https://v16.akamaized.net/v",
          thumbnailUrl: "https://p16.ibyteimg.com/c.jpeg",
          by: "buyer",
        },
        { type: "image", url: "https://p16.ibyteimg.com/s.jpeg", thumbnailUrl: null, by: "seller" },
      ],
    });

    const f2 = fakeFetch({ "GET /return_refund/202601/decision_eligibility": () => eligibility });
    const cancel = await connector(f2.fn).returns.details(shop, {
      externalReturnId: "4035400000000000001",
      externalOrderId: "577000000000000001",
      kind: "cancellation",
      externalStatus: "CANCELLATION_REQUEST_PENDING",
    });
    // no records for a cancellation; only cancellation decisions
    expect(f2.calls).toHaveLength(1);
    expect(cancel).toEqual({
      decisions: [
        {
          code: "APPROVE_REQUEST_CANCEL",
          action: "accept",
          label: "Setujui pembatalan",
          reasons: [],
          needsEmail: false,
        },
      ],
      evidence: null,
    });
  });

  it("uploads evidence as a description image and keeps its uri and size", async () => {
    const f = fakeFetch({
      "POST /product/202309/images/upload": () =>
        ok({ uri: "tos-maliva-i-evidence", url: "https://p16/e", width: 1080, height: 1440 }),
    });
    const up = await connector(f.fn).returns.uploadEvidence(shop, {
      externalReturnId: "4035318504086604100",
      kind: "return_refund",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
      contentType: "image/jpeg",
    });
    expect(up).toEqual({ ref: "tos-maliva-i-evidence", contentType: "image/jpeg", width: 1080, height: 1440 });
    const form = f.calls[0]!.init.body as FormData;
    expect(form.get("use_case")).toBe("DESCRIPTION_IMAGE");
    expect((form.get("data") as File).name).toBe("evidence.jpg");
  });

  const response = (over: Partial<ReturnResponse>): ReturnResponse => ({
    externalReturnId: "4035318504086604100",
    externalOrderId: "577686530908261117",
    kind: "return_refund",
    decision: "APPROVE_RETURN",
    reason: null,
    comment: null,
    evidence: [],
    email: null,
    idempotencyKey: "01JRETURN00000000000000000-1",
    ...over,
  });

  it("approves and rejects returns and cancellations on their own paths with an idempotency key", async () => {
    const f = fakeFetch({
      "POST /return_refund/202309/returns/[0-9]+/approve": () => ok({}),
      "POST /return_refund/202606/returns/[0-9]+/reject": () => ok({}),
      "POST /return_refund/202309/cancellations/[0-9]+/(approve|reject)": () => ok({}),
    });
    const c = connector(f.fn);
    await c.returns.respond(shop, response({}));
    await c.returns.respond(
      shop,
      response({
        decision: "REJECT_RECEIVED_PACKAGE",
        reason: "seller_reject_receive_package_damaged",
        comment: "Barang rusak saat diterima",
        evidence: [
          { ref: "tos-1", contentType: "image/jpeg", width: 1080, height: 1440, module: null },
          { ref: "tos-2", contentType: "image/png", width: null, height: null, module: null },
        ],
      }),
    );
    await c.returns.respond(
      shop,
      response({ kind: "cancellation", externalReturnId: "4035400000000000001", decision: "APPROVE_REQUEST_CANCEL" }),
    );
    await c.returns.respond(
      shop,
      response({
        kind: "cancellation",
        externalReturnId: "4035400000000000001",
        decision: "REJECT_REQUEST_CANCEL",
        reason: "seller_reject_apply_product_has_been_packed",
      }),
    );
    expect(f.calls.map((x) => [x.url.pathname, x.url.searchParams.get("idempotency_key"), bodyOf(x.init)])).toEqual([
      [
        "/return_refund/202309/returns/4035318504086604100/approve",
        "01JRETURN00000000000000000-1",
        { decision: "APPROVE_RETURN" },
      ],
      [
        "/return_refund/202606/returns/4035318504086604100/reject",
        "01JRETURN00000000000000000-1",
        {
          decision: "REJECT_RECEIVED_PACKAGE",
          reject_reason: "seller_reject_receive_package_damaged",
          comment: "Barang rusak saat diterima",
          images: [
            { image_id: "tos-1", mime_type: "image/jpeg", width: 1080, height: 1440 },
            { image_id: "tos-2", mime_type: "image/png" },
          ],
        },
      ],
      ["/return_refund/202309/cancellations/4035400000000000001/approve", "01JRETURN00000000000000000-1", {}],
      [
        "/return_refund/202309/cancellations/4035400000000000001/reject",
        "01JRETURN00000000000000000-1",
        { reject_reason: "seller_reject_apply_product_has_been_packed" },
      ],
    ]);
    // the signature covers the query (idempotency key included) and the exact body
    const reject = f.calls[1]!;
    const query = Object.fromEntries([...reject.url.searchParams].filter(([k]) => k !== "sign"));
    expect(reject.url.searchParams.get("sign")).toBe(
      tiktokSign("app-secret", tiktokSignString({ path: reject.url.pathname, query, body: String(reject.init.body) })),
    );
  });

  it("refuses unknown decisions, decisions of the other request type, and rejections without a reason", async () => {
    const f = fakeFetch({});
    const c = connector(f.fn);
    await expect(c.returns.respond(shop, response({ decision: "OFFER_PARTIAL_REFUND" }))).rejects.toBeInstanceOf(
      PermanentConnectorError,
    );
    await expect(c.returns.respond(shop, response({ decision: "APPROVE_REQUEST_CANCEL" }))).rejects.toThrow(
      /not supported/,
    );
    await expect(c.returns.respond(shop, response({ decision: "REJECT_RETURN" }))).rejects.toThrow(/reason/);
    expect(f.calls).toHaveLength(0);
  });

  it("turns a return status change notification into return.changed with the return and order ids", () => {
    const body = Buffer.from(
      '{"type":12,"tts_notification_id":"7327112393057371910","shop_id":"7494049642642441621","timestamp":1644412885,' +
        '"data":{"order_id":576486316948490001,"return_role":"BUYER","return_type":"REFUND",' +
        '"return_status":"RETURN_OR_REFUND_REQUEST_PENDING","return_id":"4035318504086604100","create_time":1627587600}}',
    );
    const [event] = parseTiktokWebhook(body);
    expect(event).toMatchObject({
      kind: "return.changed",
      code: "RETURN_STATUS_CHANGE",
      externalShopIds: ["7494049642642441621"],
      data: {
        externalOrderId: "576486316948490001",
        externalReturnId: "4035318504086604100",
        status: "RETURN_OR_REFUND_REQUEST_PENDING",
      },
    });
  });
});
