import { type CallRecord, type CommerceInput, parseJsonSafe } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { ShopeeClient, shopeeBaseString, shopeeSign } from "./client.js";
import { shopeeCommerce } from "./commerce.js";
import { SHOPEE_COMMERCE_CONTRACTS, SHOPEE_COMMERCE_OPERATIONS } from "./commerce-contracts.js";

const LARGE = "9007199254740993";
const credentials = { externalShopId: LARGE, accessToken: "test-token" };
function harness(
  reply: unknown | ((url: URL, body: Record<string, unknown>) => unknown),
  observer?: (record: CallRecord) => void,
) {
  const calls: { url: URL; raw: string; body: Record<string, unknown> }[] = [];
  const api = shopeeCommerce(
    new ShopeeClient({
      partnerId: 123,
      partnerKey: "test-key",
      apiBaseUrl: "https://partner.shopeemobile.com",
      authBaseUrl: "https://open.shopee.com",
      http: {
        observer,
        fetch: (async (input, init) => {
          const url = new URL(String(input));
          const raw = String(init?.body ?? "{}");
          const body = parseJsonSafe(raw) as Record<string, unknown>;
          calls.push({ url, body, raw });
          const result = typeof reply === "function" ? reply(url, body) : reply;
          return new Response(typeof result === "string" ? result : JSON.stringify(result));
        }) as typeof fetch,
      },
    }),
  );
  return { api, calls };
}
const id = (action: string) => `shopee.${action}`;

describe("Shopee reviewed commerce catalog", () => {
  it("accounts for all 428 pinned endpoints and all 28 modules with immutable method evidence", () => {
    expect(SHOPEE_COMMERCE_OPERATIONS).toHaveLength(428);
    expect(new Set(SHOPEE_COMMERCE_OPERATIONS.map((o) => o.id)).size).toBe(428);
    expect(new Set(SHOPEE_COMMERCE_OPERATIONS.map((o) => o.id.split(".")[1])).size).toBe(28);
    for (const contract of SHOPEE_COMMERCE_CONTRACTS) {
      expect(contract.operation.path).toMatch(/^\/api\/v2\/[a-z0-9_/]+$/i);
      expect(contract.source.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(contract.source.commit).toBe("300344af94cf347268b50847baf14b9c28aaf1ae");
      expect(contract.operation.method).toMatch(/^(GET|POST)$/);
      expect(contract.operation.authMode).toBe("shopee_app_program");
      expect(contract.operation.scopes).toEqual([]);
      expect(contract.operation.eligibility).toBe("unverified");
      if (contract.operation.available) {
        expect(contract.operation.principalKind).toBe("seller");
        expect(contract.operation.appPrograms?.length).toBeGreaterThan(0);
      } else expect(contract.operation.unavailableReason).toBeTruthy();
    }
  });

  it("keeps existing stock/order/return/product mutations in their owning modules", () => {
    for (const name of [
      "product.update_stock",
      "product.update_price",
      "order.cancel_order",
      "returns.dispute",
      "product.add_item",
      "logistics.mass_ship_order",
    ]) {
      expect(SHOPEE_COMMERCE_OPERATIONS.find((o) => o.id === id(name))).toMatchObject({ available: false });
    }
    for (const operation of SHOPEE_COMMERCE_OPERATIONS.filter((o) => /\/(?:video|livestream)\//.test(o.path))) {
      expect(operation).toMatchObject({ available: false, principalKind: "creator" });
      expect(operation.unavailableReason).toContain("user_id");
    }
  });

  it("classifies POST reads and GET report generation by business effect", () => {
    expect(SHOPEE_COMMERCE_OPERATIONS.find((o) => o.id === id("payment.get_item_installment_status"))).toMatchObject({
      method: "POST",
      write: false,
    });
    expect(SHOPEE_COMMERCE_OPERATIONS.find((o) => o.id === id("payment.generate_income_report"))).toMatchObject({
      method: "GET",
      write: true,
    });
  });

  it("separates documented seller-account requirements from Console app programs", () => {
    for (const name of [
      "payment.get_payout_info",
      "payment.get_payout_detail",
      "payment.get_billing_transaction_info",
    ]) {
      expect(SHOPEE_COMMERCE_OPERATIONS.find((o) => o.id === id(name))).toMatchObject({
        accountRequirements: ["cross_border"],
        scopes: [],
      });
    }
    for (const name of [
      "payment.get_wallet_transaction_list",
      "product.get_size_chart_list",
      "product.get_size_chart_detail",
    ]) {
      expect(SHOPEE_COMMERCE_OPERATIONS.find((o) => o.id === id(name))).toMatchObject({
        accountRequirements: ["local"],
        scopes: [],
      });
    }
  });

  it("keeps APIs explicitly restricted to other countries outside the Indonesia catalog", () => {
    for (const name of [
      "fbs.query_br_shop_enrollment_status",
      "logistics.check_polygon_update_status",
      "logistics.update_tracking_status",
      "order.get_buyer_invoice_info",
      "order.get_pending_buyer_invoice_order_list",
      "payment.get_item_installment_status",
      "payment.set_item_installment_status",
      "returns.get_shipping_carrier",
      "returns.upload_shipping_proof",
      "shop.get_br_shop_onboarding_info",
      "logistics.download_to_label",
      "order.download_invoice_doc",
      "order.upload_invoice_doc",
      "logistics.upload_serviceable_polygon",
    ]) {
      const operation = SHOPEE_COMMERCE_OPERATIONS.find((o) => o.id === id(name));
      expect(operation?.available).toBe(false);
      expect(operation?.unavailableReason).toContain("Indonesia");
    }
  });
});

describe("Shopee commerce signed transport", () => {
  it("reads AMS with documented GET query, seller signature, precision and pagination", async () => {
    const h = harness(
      `{"error":"","request_id":"read","response":{"item_list":[{"item_id":${LARGE},"item_name":"Produk"}],"cursor":"next","has_more":true,"secret":"hidden","buyer_user_name":"private"}}`,
    );
    const result = await h.api.execute(credentials, id("ams.get_open_campaign_not_added_product"), {
      query: { page_size: 20, cursor: "first", search_type: "item_name", search_content: "Kaos" },
    });
    const url = h.calls[0]!.url;
    expect(url.pathname).toBe("/api/v2/ams/get_open_campaign_not_added_product");
    expect(url.searchParams.get("shop_id")).toBe(LARGE);
    expect(url.searchParams.get("page_size")).toBe("20");
    expect(url.searchParams.get("search_content")).toBe("Kaos");
    expect(url.searchParams.get("sign")).toBe(
      shopeeSign(
        "test-key",
        shopeeBaseString({
          partnerId: 123,
          path: url.pathname,
          timestamp: Number(url.searchParams.get("timestamp")),
          accessToken: "test-token",
          shopId: LARGE,
        }),
      ),
    );
    expect(result.nextCursor).toBe("next");
    expect(result.acknowledgement).toBe("read");
    expect(JSON.stringify(result)).not.toMatch(/hidden|private|secret|buyer_user_name/);
  });

  it("creates a targeted AMS campaign with exact nested numeric IDs and verified payload nesting", async () => {
    const h = harness(`{"error":"","request_id":"write","response":{"campaign_id":${LARGE}}}`);
    const result = await h.api.execute(credentials, id("ams.create_new_targeted_campaign"), {
      body: {
        campaign_name: "Kampanye",
        period_start_time: 1800000000,
        period_end_time: 1800086400,
        is_set_budget: true,
        budget: 1000000,
        seller_message: "Kerja sama",
        item_list: [{ item_id: LARGE, rate: 4.5 }],
        affiliate_list: [{ affiliate_id: "9223372036854775807" }],
      },
    });
    expect(h.calls[0]?.body.item_list).toEqual([{ item_id: LARGE, rate: 4.5 }]);
    expect(h.calls[0]?.raw).toContain(`"item_id":${LARGE}`);
    expect(h.calls[0]?.raw).toContain('"affiliate_id":9223372036854775807');
    expect(result).toMatchObject({ data: { campaign_id: LARGE }, acknowledgement: "accepted" });
  });

  it("supports documented voucher, flash sale, shop category and financial operations", async () => {
    const h = harness({
      error: "",
      request_id: "success",
      response: {
        voucher_id: 1,
        flash_sale_id: 2,
        shop_category_id: 3,
        order_sn: "ORDER",
        order_income: { escrow_amount: 50000, buyer_user_name: "private" },
      },
    });
    await h.api.execute(credentials, id("voucher.end_voucher"), { body: { voucher_id: LARGE } });
    await h.api.execute(credentials, id("shop_flash_sale.create_shop_flash_sale"), { body: { timeslot_id: LARGE } });
    await h.api.execute(credentials, id("shop_category.add_shop_category"), { body: { name: "Produk baru" } });
    const result = await h.api.execute(credentials, id("payment.get_escrow_detail"), { query: { order_sn: "ORDER" } });
    expect(h.calls.map((c) => c.url.pathname)).toEqual([
      "/api/v2/voucher/end_voucher",
      "/api/v2/shop_flash_sale/create_shop_flash_sale",
      "/api/v2/shop_category/add_shop_category",
      "/api/v2/payment/get_escrow_detail",
    ]);
    expect(result.data).toMatchObject({ order_sn: "ORDER", order_income: { escrow_amount: 50000 } });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("reads root-level finance results and their documented nested pagination cursor", async () => {
    const h = harness({
      error: "",
      request_id: "read",
      income_detail_list: {
        list: [{ order_sn: "ORDER", currency: "IDR", released_amount: 50000 }],
        next_page: { cursor: "finance-next", page_size: 20 },
      },
    });
    const result = await h.api.execute(credentials, id("payment.get_income_detail"), {
      query: { date_from: "2026-10-01", date_to: "2026-10-17", income_status: 1, page_size: 20 },
    });
    expect(result.nextCursor).toBe("finance-next");
    expect(result.data).toMatchObject({
      income_detail_list: {
        list: [{ order_sn: "ORDER", currency: "IDR" }],
        next_page: { cursor: "finance-next", page_size: 20 },
      },
    });
    expect(JSON.stringify(result.data)).not.toMatch(/request_id/);
  });

  it.each([{ cursor: "", has_more: true }, { has_more: true }, { cursor: "next", has_more: "true" }])(
    "refuses an incomplete or malformed continuation cursor %#",
    async (response) => {
      const h = harness({ response });
      await expect(
        h.api.execute(credentials, id("ams.get_open_campaign_not_added_product"), { query: { page_size: 20 } }),
      ).rejects.toMatchObject({ code: "commerce_bad_response" });
    },
  );

  it("honors an explicitly finished page and documented required empty initial cursor", async () => {
    const h = harness({ response: { more: false, next_cursor: "unused", payout_list: [] } });
    const operation = SHOPEE_COMMERCE_OPERATIONS.find((op) => op.id === id("payment.get_payout_info"));
    expect(operation?.fields.find((field) => field.name === "query.cursor")).toMatchObject({
      required: true,
      allowEmpty: true,
    });
    const result = await h.api.execute(credentials, id("payment.get_payout_info"), {
      query: { payout_time_from: 1800000000, payout_time_to: 1800086400, page_size: 20, cursor: "" },
    });
    expect(result.nextCursor).toBeNull();
    expect(h.calls[0]?.url.searchParams.get("cursor")).toBe("");
  });

  it("executes newly supported product deletion through the exact documented route", async () => {
    const h = harness({ error: "", request_id: "delete", response: {} });
    const result = await h.api.execute(credentials, id("product.delete_item"), { body: { item_id: LARGE } });
    expect(h.calls[0]?.url.pathname).toBe("/api/v2/product/delete_item");
    expect(h.calls[0]?.raw).toBe(`{"item_id":${LARGE}}`);
    expect(result.acknowledgement).toBe("accepted");
  });

  it.each([{}, { response: {} }, { error: "", response: {} }, { request_id: "write", response: {} }])(
    "refuses a write without an explicit successful envelope and request ID %#",
    async (reply) => {
      const h = harness(reply);
      await expect(
        h.api.execute(credentials, id("voucher.end_voucher"), { body: { voucher_id: LARGE } }),
      ).rejects.toMatchObject({ code: "commerce_bad_response" });
    },
  );

  it.each([{}, { response: null }, { response: "unexpected" }])("refuses malformed reads %#", async (reply) => {
    const h = harness(reply);
    await expect(h.api.execute(credentials, id("account_health.get_shop_performance"), {})).rejects.toMatchObject({
      code: "commerce_bad_response",
    });
  });

  it.each([
    { failure_list: [{ item_id: LARGE }] },
    { error_list: [{ fail_error: "rejected" }] },
    { failed_items: [{ err_code: 5 }] },
    { failure_list: {} },
  ])("never reports accepted when a batch has partial or malformed failures %#", async (response) => {
    const h = harness({ error: "", request_id: "write", response });
    await expect(
      h.api.execute(credentials, id("ams.batch_add_products_to_open_campaign"), {
        body: { item_id_list: [LARGE], commission_rate: 5 },
      }),
    ).rejects.toMatchObject({ code: "commerce_partial_failure" });
  });

  it("rejects repeated cursors, invalid IDs, credentials injection and unknown endpoints before unsafe calls", async () => {
    const h = harness({ response: { cursor: "same", has_more: true } });
    await expect(
      h.api.execute(credentials, id("ams.get_open_campaign_not_added_product"), {
        query: { page_size: 20, cursor: "same" },
      }),
    ).rejects.toMatchObject({ code: "commerce_bad_response" });
    const safe = harness({});
    const invalidInputs: CommerceInput[] = [
      { body: { voucher_id: "9223372036854775808" } },
      { body: { voucher_id: LARGE, access_token: "injected" } },
    ];
    for (const input of invalidInputs) {
      await expect(safe.api.execute(credentials, id("voucher.end_voucher"), input)).rejects.toMatchObject({
        kind: "permanent",
      });
    }
    await expect(safe.api.execute(credentials, "shopee.http.https://attacker.example", {})).rejects.toMatchObject({
      code: "commerce_unavailable",
    });
    await expect(safe.api.execute(credentials, id("video.get_video_list"), {})).rejects.toMatchObject({
      code: "commerce_unavailable",
    });
    await expect(safe.api.execute(credentials, id("product.update_stock"), {})).rejects.toMatchObject({
      code: "commerce_unavailable",
    });
    expect(safe.calls).toHaveLength(0);
  });

  it("records only operation metadata, including arbitrary text under innocent input/response keys", async () => {
    const records: CallRecord[] = [];
    const secret = "PII-CANARY-Arbitrary-Text-Do-Not-Log";
    const h = harness(
      {
        response: {
          item_list: [{ item_name: secret }],
          cursor: "",
          has_more: false,
          name: secret,
          note: secret,
          content: secret,
        },
        request_id: secret,
      },
      (record) => records.push(record),
    );
    await h.api.execute(credentials, id("ams.get_open_campaign_not_added_product"), {
      query: { page_size: 20, search_content: secret },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      path: "/api/v2/ams/get_open_campaign_not_added_product",
      request: { operationId: id("ams.get_open_campaign_not_added_product") },
      response: { redacted: true },
    });
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(records[0]?.path).not.toContain("?");
    const rejected = harness(
      { error: "error_param", message: `Invalid note: ${secret}`, request_id: secret },
      (record) => records.push(record),
    );
    const error = await rejected.api
      .execute(credentials, id("order.set_note"), { body: { order_sn: "ORDER", note: secret } })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ kind: "permanent", code: "error_param" });
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
    expect((error as Error).message).not.toContain(secret);
  });

  it("propagates authorization expiry without treating missing program approval as disconnection", async () => {
    const expired = harness({ error: "invalid_access_token", message: "Expired" });
    await expect(expired.api.execute(credentials, id("account_health.get_shop_performance"), {})).rejects.toMatchObject(
      { kind: "auth_expired" },
    );
    const program = harness({ error: "error_perm", message: "App not approved for AMS" });
    await expect(program.api.execute(credentials, id("ams.get_shop_suggested_rate"), {})).rejects.toMatchObject({
      kind: "permanent",
    });
  });
});
