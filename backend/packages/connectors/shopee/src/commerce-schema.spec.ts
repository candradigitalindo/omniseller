import { type CallRecord, type CommerceInput, parseJsonSafe } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { ShopeeClient, shopeeBaseString, shopeeSign } from "./client.js";
import { shopeeCommerce } from "./commerce.js";

const BIG = "9007199254740993";
const credentials = { externalShopId: BIG, accessToken: "schema-test-token" };
function harness() {
  const requests: { url: URL; raw: string; method: string }[] = [];
  const records: CallRecord[] = [];
  const api = shopeeCommerce(
    new ShopeeClient({
      partnerId: 123,
      partnerKey: "schema-test-key",
      apiBaseUrl: "https://partner.shopeemobile.com",
      authBaseUrl: "https://open.shopee.com",
      http: {
        observer(record) {
          records.push(record);
        },
        fetch: (async (input, init) => {
          const url = new URL(String(input));
          requests.push({ url, raw: String(init?.body ?? "{}"), method: init?.method ?? "GET" });
          return new Response(
            JSON.stringify({ error: "", request_id: "request-schema-1", response: { item_id: BIG } }),
          );
        }) as typeof fetch,
      },
    }),
  );
  return { api, requests, records };
}

describe("Shopee compiled schema transport", () => {
  it("signs a real nested product edit and emits every int64 ID without rounding", async () => {
    const { api, requests, records } = harness();
    const body = {
      item_id: BIG,
      item_name: "Nama produk",
      description: "catatan-formulir-pribadi",
      compatibility_info: { vehicle_info_list: [{ brand_id: BIG, model_id: BIG, year_id: BIG }] },
      promotion_images: { image_id_list: ["id-picture"] },
      medicine_id: BIG,
    };
    await expect(api.execute(credentials, "shopee.product.update_item", { body })).resolves.toMatchObject({
      acknowledgement: "accepted",
    });
    expect(requests).toHaveLength(1);
    const { url, raw } = requests[0]!;
    for (const key of ["item_id", "brand_id", "model_id", "year_id", "medicine_id"])
      expect(raw).toContain(`"${key}":${BIG}`);
    expect(parseJsonSafe(raw)).toMatchObject(body);
    expect(url.pathname).toBe("/api/v2/product/update_item");
    expect(url.searchParams.get("sign")).toBe(
      shopeeSign(
        "schema-test-key",
        shopeeBaseString({
          partnerId: 123,
          path: url.pathname,
          timestamp: Number(url.searchParams.get("timestamp")),
          accessToken: credentials.accessToken,
          shopId: BIG,
        }),
      ),
    );
    const log = JSON.stringify(records);
    expect(log).not.toContain("catatan-formulir-pribadi");
    expect(log).not.toContain("schema-test-token");
    expect(log).not.toContain(BIG);
    expect(records[0]!.request).toEqual({ operationId: "shopee.product.update_item" });
  });

  it("encodes mixed product and model discount branches in the exact reviewed parent", async () => {
    const { api, requests } = harness();
    const input: CommerceInput = {
      body: {
        discount_id: BIG,
        item_list: [
          { item_id: BIG, item_promotion_price: 15000 },
          { item_id: BIG, model_list: [{ model_id: BIG, model_promotion_price: 14000 }] },
        ],
      },
    };
    await api.execute(credentials, "shopee.discount.update_discount_item", input);
    expect(requests).toHaveLength(1);
    expect(parseJsonSafe(requests[0]!.raw)).toEqual(input.body);
    expect(requests[0]!.raw).toContain(`"model_id":${BIG}`);
  });

  it("retains local clocks, the documented day spelling, and calendar dates in the transport", async () => {
    const { api, requests } = harness();
    const input: CommerceInput = {
      body: {
        instant_operating_hour: { thrusday: { start_time: "09:00", end_time: "23:59" } },
        special_operating_hour: {
          name: "Promo",
          start_date: "2026-12-12",
          end_date: "2026-12-12",
          operating_hours: [{ date: "2026-12-12", start_time: "10:00", end_time: "17:30", enable: true }],
        },
      },
    };
    await api.execute(credentials, "shopee.logistics.update_operating_hours", input);
    expect(parseJsonSafe(requests[0]!.raw)).toEqual(input.body);
  });

  it("rejects missing conditional fields and invalid local hours before any HTTP request", async () => {
    const { api, requests } = harness();
    await expect(
      api.execute(credentials, "shopee.bundle_deal.add_bundle_deal", {
        body: {
          rule_type: 2,
          min_amount: 2,
          start_time: 1800000000,
          end_time: 1800003600,
          name: "Paket",
          purchase_limit: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "commerce_invalid_input" });
    await expect(
      api.execute(credentials, "shopee.logistics.update_operating_hours", {
        body: { regular_operating_hour: { monday: { start_time: "09:15", end_time: "18:30" } } },
      }),
    ).rejects.toMatchObject({ code: "commerce_invalid_input" });
    await expect(
      api.execute(credentials, "shopee.logistics.update_operating_hours", {
        body: {
          special_operating_hour: {
            name: "Promo",
            start_date: "2026-02-29",
            end_date: "2026-03-01",
            operating_hours: [],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "commerce_invalid_input" });
    expect(requests).toHaveLength(0);
  });
});
