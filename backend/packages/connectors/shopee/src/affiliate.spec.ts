import { createHmac } from "node:crypto";
import {
  type OpenCampaignProductQuery,
  PermanentConnectorError,
  TransientConnectorError,
} from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { createShopeeConnector } from "./connector.js";

const shop = { externalShopId: "14701711", accessToken: "test-token", shopCipher: null };
const path = "/api/v2/ams/get_open_campaign_added_product";
const item = {
  item_id: 123,
  item_name: "Kaos",
  campaign_id: 456,
  campaign_status: "Ongoing",
  commission_rate: 1.11,
  period_start_time: 1_735_660_800,
  period_end_time: 32_503_651_199,
  pending_terminated_time: 0,
  commission_protection_list: [{ commission_rate: 1.21, protection_period_end_time: 1_736_265_600 }],
  max_commission_rate_current_day: 1.21,
};
const page = { item_list: [item], total_count: 1, cursor: "", has_more: false };

function harness(reply: (url: URL) => unknown, status = 200) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const payload = reply(url);
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
  }) as typeof fetch;
  const connector = createShopeeConnector({
    partnerId: 2001887,
    partnerKey: "test-partner-key",
    apiBaseUrl: "https://partner.shopeemobile.com",
    authBaseUrl: "https://open.shopee.com",
    http: { fetch: fetchImpl },
  });
  return { affiliate: connector.affiliate!, calls };
}

describe("Shopee AMS open campaign products (API 2667)", () => {
  it("uses signed GET, filters and cursor pagination, preserving commission protection and unlimited periods", async () => {
    const h = harness((url) => ({
      error: "",
      response: url.searchParams.has("cursor")
        ? page
        : { ...page, total_count: 2, cursor: "1234,5678", has_more: true },
    }));
    const query: OpenCampaignProductQuery = {
      pageSize: 20,
      sortBy: "-commission_rate",
      search: { by: "name", value: " Kaos & Topi " },
    };
    const first = await h.affiliate.listOpenCampaignProducts(shop, query);
    expect(first).toEqual({
      items: [
        {
          externalItemId: "123",
          title: "Kaos",
          externalCampaignId: "456",
          status: "ongoing",
          externalStatus: "Ongoing",
          commissionBasisPoints: 111,
          startsAt: new Date(1_735_660_800_000),
          endsAt: null,
          pendingTerminationAt: null,
          protections: [{ commissionBasisPoints: 121, endsAt: new Date(1_736_265_600_000) }],
          maxCommissionBasisPointsToday: 121,
        },
      ],
      total: 2,
      nextCursor: "1234,5678",
    });
    const next = await h.affiliate.listOpenCampaignProducts(shop, { ...query, cursor: first.nextCursor });
    expect(next.nextCursor).toBeNull();
    expect(h.calls).toHaveLength(2);
    for (const { url, init } of h.calls) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(url.pathname).toBe(path);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        partner_id: "2001887",
        shop_id: shop.externalShopId,
        access_token: shop.accessToken,
        page_size: "20",
        sort_by: "-commission_rate",
        search_type: "ITEM_NAME",
        search_content: "Kaos & Topi",
      });
      const base = `2001887${path}${url.searchParams.get("timestamp")}${shop.accessToken}${shop.externalShopId}`;
      expect(url.searchParams.get("sign")).toBe(createHmac("sha256", "test-partner-key").update(base).digest("hex"));
    }
    expect(h.calls[0]!.url.searchParams.has("cursor")).toBe(false);
    expect(h.calls[1]!.url.searchParams.get("cursor")).toBe("1234,5678");
  });

  it("keeps int64 identifiers exact and sends up to 50 item ids as a comma-separated search", async () => {
    const h = harness(() =>
      JSON.stringify({ response: page })
        .replace('"item_id":123', '"item_id":9223372036854775807')
        .replace('"campaign_id":456', '"campaign_id":9007199254740993'),
    );
    const result = await h.affiliate.listOpenCampaignProducts(shop, {
      search: { by: "id", value: "9223372036854775807, 9007199254740993" },
    });
    expect(result.items[0]).toMatchObject({
      externalItemId: "9223372036854775807",
      externalCampaignId: "9007199254740993",
    });
    expect(h.calls[0]!.url.searchParams.get("page_size")).toBe("100");
    expect(h.calls[0]!.url.searchParams.get("search_type")).toBe("ITEM_ID");
    expect(h.calls[0]!.url.searchParams.get("search_content")).toBe("9223372036854775807,9007199254740993");
  });

  it.each(["Upcoming", "Terminating", "constructor", "FutureStatus"])(
    "handles %s without inventing a known state",
    async (status) => {
      const h = harness(() => ({
        response: {
          ...page,
          item_list: [
            {
              ...item,
              campaign_status: status,
              commission_rate: 0.29,
              period_end_time: 1_736_265_600,
              pending_terminated_time: 1_735_747_200,
              commission_protection_list: [],
              max_commission_rate_current_day: undefined,
            },
          ],
        },
      }));
      const result = await h.affiliate.listOpenCampaignProducts(shop);
      expect(result.items[0]).toMatchObject({
        status: status === "Upcoming" ? "upcoming" : status === "Terminating" ? "terminating" : "unknown",
        externalStatus: status,
        commissionBasisPoints: 29,
        endsAt: new Date(1_736_265_600_000),
        pendingTerminationAt: new Date(1_735_747_200_000),
        protections: [],
        maxCommissionBasisPointsToday: null,
      });
    },
  );

  it.each([
    { pageSize: 0 },
    { pageSize: 101 },
    { pageSize: 1.5 },
    { pageSize: Number.NaN },
    { sortBy: "unsupported" },
    { cursor: 42 },
    { search: { by: "name", value: "  " } },
    { search: { by: "other", value: "x" } },
    { search: { by: "id", value: "1,,2" } },
    { search: { by: "id", value: "1.5" } },
    { search: { by: "id", value: Array.from({ length: 51 }, (_, i) => i + 1).join(",") } },
  ])("rejects invalid input before making a request: %j", async (input) => {
    const h = harness(() => ({ response: page }));
    await expect(h.affiliate.listOpenCampaignProducts(shop, input as OpenCampaignProductQuery)).rejects.toMatchObject({
      kind: "permanent",
      code: "invalid_request",
    });
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    undefined,
    {},
    { ...page, total_count: -1 },
    { ...page, has_more: "true" },
    { ...page, has_more: true, cursor: "" },
    { ...page, has_more: true, cursor: "same" },
    { ...page, item_list: [{ ...item, commission_rate: 1.111 }] },
    { ...page, item_list: [{ ...item, commission_rate: 101 }] },
    { ...page, item_list: [{ ...item, item_id: "" }] },
    { ...page, item_list: [{ ...item, commission_protection_list: {} }] },
    { ...page, item_list: [{ ...item, pending_terminated_time: "" }] },
  ])("refuses malformed pages or stalled cursors rather than dropping records", async (response) => {
    const h = harness(() => ({ response }));
    await expect(h.affiliate.listOpenCampaignProducts(shop, { cursor: "same" })).rejects.toMatchObject({
      kind: "permanent",
      code: "bad_response",
    });
  });

  it.each([
    [
      "error_business",
      "Please agree to the AMS T&C in Seller Center - Affiliate Marketing Solutions first before using Open API.",
    ],
    ["error_business", "Sorry you don't have access to AMS features."],
    ["error_api_permission", "This app type has no permission to this API."],
  ])("keeps an AMS entitlement failure permanent: %s", async (error, message) => {
    const h = harness(() => ({ error, message, request_id: "ams-request" }), 403);
    await expect(h.affiliate.listOpenCampaignProducts(shop)).rejects.toBeInstanceOf(PermanentConnectorError);
    expect(h.calls).toHaveLength(1);
  });

  it("preserves transient rate-limit errors and their retry delay", async () => {
    const h = harness(() => ({ error: "error_rate_limit", message: "Too many requests." }), 429);
    const result = h.affiliate.listOpenCampaignProducts(shop);
    await expect(result).rejects.toBeInstanceOf(TransientConnectorError);
    await expect(result).rejects.toMatchObject({ retryAfterMs: 60_000 });
  });
});
