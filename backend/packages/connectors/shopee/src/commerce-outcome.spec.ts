import { type CommerceCredentials, type CommerceInput } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { ShopeeClient } from "./client.js";
import { shopeeCommerce } from "./commerce.js";

const ID = "9007199254740993";
const seller: CommerceCredentials = { externalShopId: ID, accessToken: "outcome-token" };
const creator: CommerceCredentials = { externalAccountId: ID, accessToken: "outcome-token" };
function execute(id: string, input: CommerceInput, response: unknown, credentials = seller) {
  let requests = 0;
  const api = shopeeCommerce(
    new ShopeeClient({
      partnerId: 123,
      partnerKey: "outcome-key",
      apiBaseUrl: "https://partner.shopeemobile.com",
      authBaseUrl: "https://open.shopee.com",
      http: {
        fetch: (async () => {
          requests++;
          return new Response(JSON.stringify({ error: "", request_id: "outcome-request", response }));
        }) as typeof fetch,
      },
    }),
  );
  return { result: api.execute(credentials, `shopee.${id}`, input), requests: () => requests };
}
const keywords: CommerceInput = {
  body: {
    reference_id: "keyword-reference",
    campaign_id: ID,
    selected_keywords: [{ edit_action: "delete", keyword: "sepatu" }],
  },
};
const affiliates: CommerceInput = {
  body: { campaign_id: ID, edit_type: "add", affiliate_list: [{ affiliate_id: ID }] },
};
const products: CommerceInput = { body: { campaign_id: ID, edit_type: "add", item_list: [{ item_id: ID }] } };

describe("documented Shopee business rejection outcomes", () => {
  it.each([
    { response: [{ campaign_id: ID, failed_edits: [{ keyword: "sepatu", error: "", message: "" }] }] },
    { response: [{ campaign_id: ID, failed_edits: {} }] },
    {
      response: [
        { campaign_id: ID, failed_edits: [] },
        { campaign_id: "2", failed_edits: [{ keyword: "sepatu" }] },
      ],
    },
  ])("rejects failed keyword edits in a top-level response array %#", async ({ response }) => {
    const h = execute("ads.edit_manual_product_ad_keywords", keywords, response);
    await expect(h.result).rejects.toMatchObject({ code: "commerce_partial_failure" });
    expect(h.requests()).toBe(1);
  });

  it("accepts keyword edits with empty failure lists", async () => {
    await expect(
      execute("ads.edit_manual_product_ad_keywords", keywords, [{ campaign_id: ID, failed_edits: [] }]).result,
    ).resolves.toMatchObject({ acknowledgement: "accepted" });
  });

  it.each([
    ["ams.edit_affiliate_list_of_targeted_campaign", affiliates, { fail_affiliate_list: [{ affiliate_id: ID }] }],
    ["ams.edit_affiliate_list_of_targeted_campaign", affiliates, { fail_affiliate_list: {} }],
    ["ams.edit_product_list_of_targeted_campaign", products, { fail_item_list: [{ item_id: ID }] }],
    ["ams.edit_product_list_of_targeted_campaign", products, { fail_item_list: "malformed" }],
  ] satisfies [string, CommerceInput, unknown][])(
    "rejects documented AMS failure lists even without nested error text %#",
    async (id, input, response) => {
      await expect(execute(id, input, response).result).rejects.toMatchObject({ code: "commerce_partial_failure" });
    },
  );

  it.each([
    ["ams.edit_affiliate_list_of_targeted_campaign", affiliates, { fail_affiliate_list: [] }],
    ["ams.edit_product_list_of_targeted_campaign", products, { fail_item_list: [] }],
  ] satisfies [string, CommerceInput, unknown][])(
    "accepts the corresponding empty AMS failure list %#",
    async (id, input, response) => {
      await expect(execute(id, input, response).result).resolves.toMatchObject({ acknowledgement: "accepted" });
    },
  );

  it.each([false, "false", null])(
    "refuses an unsuccessful or malformed prescription acknowledgement %#",
    async (is_success) => {
      await expect(
        execute(
          "order.handle_prescription_check",
          {
            body: { order_sn: "prescription-1", is_approved: true, pharmacist_name: "Apoteker" },
          },
          { is_success },
        ).result,
      ).rejects.toMatchObject({ code: "commerce_partial_failure" });
    },
  );

  it("accepts a successful prescription decision including an explicit rejection of the prescription", async () => {
    await expect(
      execute(
        "order.handle_prescription_check",
        {
          body: { order_sn: "prescription-1", is_approved: false, reject_reason_code: 1, pharmacist_name: "Apoteker" },
        },
        { is_success: true },
      ).result,
    ).resolves.toMatchObject({ acknowledgement: "accepted" });
  });

  it.each([{ fail_post_id: "post-failed" }, { fail_video_upload_id: "video-failed" }])(
    "rejects a documented failed video identifier without relying on an outer failure list %#",
    async (response) => {
      await expect(
        execute("video.delete_video", { body: { video_upload_id_list: ["video-failed"] } }, response, creator).result,
      ).rejects.toMatchObject({ code: "commerce_partial_failure" });
    },
  );

  it("accepts empty/null failure identifiers in an otherwise successful video response", async () => {
    await expect(
      execute(
        "video.delete_video",
        { body: { video_upload_id_list: ["video-ok"] } },
        {
          failure_list: [],
          success_list: [{ success_video_upload_id: "video-ok" }],
          fail_post_id: null,
          fail_video_upload_id: "",
        },
        creator,
      ).result,
    ).resolves.toMatchObject({ acknowledgement: "accepted" });
  });
});
