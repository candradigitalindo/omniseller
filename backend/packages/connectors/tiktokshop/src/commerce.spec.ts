import type { CallRecord } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { TiktokShopClient, tiktokSign, tiktokSignString } from "./client.js";
import { TIKTOK_COMMERCE_OPERATIONS, tiktokCommerce } from "./commerce.js";

const operation = (path: string) => {
  const found = TIKTOK_COMMERCE_OPERATIONS.find((item) => item.path === path);
  if (!found) throw new Error(path);
  return found;
};
function harness(data: unknown = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const records: CallRecord[] = [];
  let response: unknown = { code: 0, data };
  const client = new TiktokShopClient({
    appKey: "public-app",
    appSecret: "fixture-secret",
    apiBaseUrl: "https://open-api.tiktokglobalshop.com",
    authBaseUrl: "https://auth.tiktok-shops.com",
    authorizeUrl: "https://services.tiktokshop.com/open/authorize",
    http: {
      observer: (r) => records.push(r),
      fetch: (async (url, init) => {
        calls.push({ url: new URL(String(url)), init: init ?? {} });
        return Response.json(response);
      }) as typeof fetch,
    },
  });
  return {
    adapter: tiktokCommerce(client),
    calls,
    records,
    setResponse: (next: unknown) => {
      response = next;
    },
  };
}
describe("reviewed TikTok commerce adapter", () => {
  it("uses the exact public contract, principal token and documented signature without seller cipher for creator", async () => {
    const h = harness({
      username: "creator",
      selection_region: "ID",
      access_token: "DO_NOT_KEEP",
      undeclared: "DO_NOT_KEEP",
    });
    const op = operation("/affiliate_creator/202508/profiles");
    const result = await h.adapter.execute({ accessToken: "PRIVATE_TOKEN", shopCipher: "MUST_NOT_SEND" }, op.id, {});
    const { url, init } = h.calls[0]!;
    expect(url.pathname).toBe(op.path);
    expect(url.searchParams.has("shop_cipher")).toBe(false);
    expect(init.headers).toMatchObject({ "x-tts-access-token": "PRIVATE_TOKEN" });
    const query = Object.fromEntries(url.searchParams);
    expect(query.sign).toBe(tiktokSign("fixture-secret", tiktokSignString({ path: op.path, query })));
    expect(result).toMatchObject({ acknowledgement: "read", data: { selection_region: "ID" } });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_KEEP");
    expect(JSON.stringify(h.records)).not.toContain("PRIVATE_TOKEN");
    expect(h.records[0]).toMatchObject({
      path: op.path,
      request: { operationId: op.id },
      response: { redacted: true },
    });
  });
  it("injects a private partner asset selected by public category id and refuses ambiguous/missing assets", async () => {
    const h = harness({ campaign: { id: "9223372036854775806" } });
    const op = operation("/affiliate_partner/202405/campaigns/{campaign_id}");
    const credentials = {
      accessToken: "partner-token",
      categoryAssets: [
        { categoryId: 101, categoryName: "FixtureA", market: "ID", cipher: "privateA" },
        { categoryId: 102, categoryName: "FixtureB", market: "ID", cipher: "privateB" },
      ],
    };
    await expect(
      h.adapter.execute(credentials, op.id, { path: { campaign_id: "9223372036854775806" } }),
    ).rejects.toMatchObject({ code: "category_asset_selection_required" });
    expect(h.calls).toHaveLength(0);
    await h.adapter.execute(credentials, op.id, { categoryAssetId: 102, path: { campaign_id: "9223372036854775806" } });
    expect(h.calls[0]!.url.searchParams.get("category_asset_cipher")).toBe("privateB");
    expect(h.calls[0]!.url.pathname).toContain("9223372036854775806");
    expect(JSON.stringify(h.records)).not.toContain("privateB");
  });
  it("validates structured mutations and returns acknowledgement rather than confirmed marketplace state", async () => {
    const h = harness({});
    const op = operation("/affiliate_creator/202405/showcases/products/add");
    const result = await h.adapter.execute({ accessToken: "token" }, op.id, {
      body: { add_type: "PRODUCT_ID", product_ids: ["9223372036854775806"] },
    });
    expect(result.acknowledgement).toBe("accepted");
    expect(JSON.parse(String(h.calls[0]!.init.body))).toEqual({
      add_type: "PRODUCT_ID",
      product_ids: ["9223372036854775806"],
    });
    await expect(
      h.adapter.execute({ accessToken: "token" }, op.id, { body: { add_type: "PRODUCT_ID", app_secret: "forbidden" } }),
    ).rejects.toMatchObject({ code: "commerce_invalid_input" });
    expect(h.calls).toHaveLength(1);
  });
  it("redacts marketplace error text before sync logging", async () => {
    const h = harness();
    h.setResponse({ code: 36009004, message: "buyer PRIVATE_PERSON phone PRIVATE_PHONE" });
    const op = operation("/affiliate_creator/202508/profiles");
    await expect(h.adapter.execute({ accessToken: "token" }, op.id, {})).rejects.toMatchObject({
      code: "36009004",
      detail: "Commerce API request failed; inspect operation permissions and marketplace status",
    });
    expect(JSON.stringify(h.records)).not.toContain("PRIVATE_PERSON");
  });
  it("uploads creator media as signed multipart and never records its bytes", async () => {
    const h = harness({ photo_file: { photo_uri: "photo-resource" } });
    const op = operation("/affiliate_creator/202511/photos/photo_files");
    const fileId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nS8AAAAASUVORK5CYII=",
      "base64",
    );
    const result = await h.adapter.execute(
      { accessToken: "creator-secret", files: { [fileId]: { bytes, mime: "image/png", filename: "commerce.png" } } },
      op.id,
      { body: { data: fileId } },
    );
    expect(result).toMatchObject({
      acknowledgement: "accepted",
      data: { photo_file: { photo_uri: "photo-resource" } },
    });
    const { url, init } = h.calls[0]!;
    const form = init.body as FormData;
    expect(form.get("data")).toBeInstanceOf(Blob);
    expect(await (form.get("data") as Blob).arrayBuffer()).toEqual(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    const query = Object.fromEntries(url.searchParams);
    expect(query.sign).toBe(tiktokSign("fixture-secret", tiktokSignString({ path: op.path, query })));
    expect(url.searchParams.has("shop_cipher")).toBe(false);
    expect(JSON.stringify(h.records)).not.toContain(bytes.toString("base64"));
    await expect(h.adapter.execute({ accessToken: "token" }, op.id, { body: { data: fileId } })).rejects.toMatchObject({
      code: "commerce_invalid_file",
    });
    expect(h.calls).toHaveLength(1);
  });
  it("returns private Compass bytes separately from retained JSON and rejects malformed file content", async () => {
    const bytes = Buffer.from("creator;commission\nfixture;20000");
    const h = harness({ file: { base64: bytes.toString("base64") } });
    const op = operation("/affiliate_seller/202603/compass/offline_tasks/{task_id}/file");
    const result = await h.adapter.execute({ accessToken: "seller", shopCipher: "private-shop" }, op.id, {
      path: { task_id: "fixture-task" },
    });
    expect(result).toMatchObject({ data: {}, download: { mime: "application/octet-stream", ext: "bin" } });
    expect(Buffer.from(result.download!.bytes)).toEqual(bytes);
    expect(JSON.stringify(h.records)).not.toContain(bytes.toString("base64"));
    h.setResponse({ code: 0, data: { file: { base64: "https://not-a-file.invalid/" } } });
    await expect(
      h.adapter.execute({ accessToken: "seller" }, op.id, { path: { task_id: "fixture-task" } }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });
  it("checks Indonesian FBT onboarding before any FBT request", async () => {
    const h = harness({ onboarded_regions: [{ region_code: "US" }] });
    const op = operation("/fbt/202408/warehouses");
    await expect(h.adapter.execute({ accessToken: "seller", shopCipher: "private" }, op.id, {})).rejects.toMatchObject({
      code: "commerce_program_unavailable",
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url.pathname).toBe("/fbt/202409/merchants/onboarded_regions");
  });
  it("consumes a private streamed creator upload without publishing or exposing session credentials", async () => {
    const h = harness({
      upload_token: "PRIVATE_UPLOAD_SESSION",
      upload_url: "https://open-api.tiktokglobalshop.com/file/v1/upload?route=sg",
    });
    const op = TIKTOK_COMMERCE_OPERATIONS.find((item) => item.id === "tiktok_large_creator_video")!;
    const fileId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const ranges: number[][] = [];
    const result = await h.adapter.execute(
      {
        accessToken: "creator",
        files: {
          [fileId]: {
            bytes: new Uint8Array(),
            size: 11_000_000,
            mime: "video/mp4",
            filename: "commerce.mp4",
            readRange: async (start, end) => {
              ranges.push([start, end]);
              h.setResponse({ code: 0, data: { resource_id: "video-resource" } });
              return new Uint8Array(end - start);
            },
          },
        },
      },
      op.id,
      { body: { data: fileId } },
    );
    expect(result).toMatchObject({
      data: { resource_id: "video-resource", target_operation_id: "tiktok_69cb362bf76068049e7a08f2" },
      acknowledgement: "accepted",
    });
    expect(ranges).toEqual([[0, 11_000_000]]);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.url.pathname).toBe("/open/202512/file/init");
    expect(h.calls[1]!.init.method).toBe("PUT");
    expect(h.calls.some((call) => call.url.pathname === "/affiliate_creator/202603/videos")).toBe(false);
    expect(JSON.stringify(h.records)).not.toContain("PRIVATE_UPLOAD_SESSION");
  });
  it("rejects oversized opaque page tokens instead of silently truncating them", async () => {
    const h = harness({ next_page_token: "x".repeat(2001) });
    const op = operation("/affiliate_creator/202508/profiles");
    await expect(h.adapter.execute({ accessToken: "creator" }, op.id, {})).rejects.toMatchObject({
      code: "bad_response",
    });
  });
  it("maps Tokopedia IDs with the documented GET body and exact numeric int64 wire values", async () => {
    const h = harness({ product: [{ toko_pid: "9223372036854775806", tts_pid: "9223372036854775807" }] });
    const op = operation("/affiliate_creator/202606/toko_product_mappers");
    const result = await h.adapter.execute({ accessToken: "CREATOR_PRIVATE" }, op.id, {
      body: { toko_pids: ["9223372036854775806"] },
    });
    const { url, init } = h.calls[0]!;
    expect(init.method).toBe("GET");
    expect(init.body).toBe('{"toko_pids":[9223372036854775806]}');
    const query = Object.fromEntries(url.searchParams);
    expect(query.sign).toBe(
      tiktokSign("fixture-secret", tiktokSignString({ path: op.path, query, body: String(init.body) })),
    );
    expect(result.data).toEqual({ product: [{ toko_pid: "9223372036854775806", tts_pid: "9223372036854775807" }] });
    expect(JSON.stringify(h.records)).not.toContain("CREATOR_PRIVATE");
    h.setResponse({ code: 0, data: { error: { code: 1, message: "private detail" } } });
    await expect(
      h.adapter.execute({ accessToken: "creator" }, op.id, { body: { toko_pids: ["42"] } }),
    ).rejects.toMatchObject({ code: "commerce_mapping_rejected" });
  });
  it("uses the documented affiliate conversation query rather than a redundant GET body", async () => {
    const h = harness({ conversations: [] });
    const op = operation("/affiliate_seller/202412/conversations");
    await h.adapter.execute({ accessToken: "seller", shopCipher: "shop" }, op.id, {
      query: { page_size: 10, only_need_conversation_id: false, conversation_status: "UNREAD" },
    });
    expect(h.calls[0]!.url.searchParams.get("only_need_conversation_id")).toBe("false");
    expect(h.calls[0]!.init.body).toBeUndefined();
    await expect(
      h.adapter.execute({ accessToken: "seller" }, op.id, {
        query: { page_size: 10 },
        body: { only_need_conversation_id: true },
      }),
    ).rejects.toMatchObject({ code: "commerce_invalid_input" });
  });
  it("uses both documented campaign/product placeholders without coercion or traversal", async () => {
    const h = harness({ creators: [] });
    const op = operation("/affiliate_partner/202508/campaigns/{campaign_id}/products/{product_id}/performance");
    const credentials = {
      accessToken: "partner",
      categoryAssets: [{ categoryId: 101, categoryName: "Fixture", market: "ID", cipher: "ASSET_PRIVATE" }],
    };
    await h.adapter.execute(credentials, op.id, {
      path: { campaign_id: "9223372036854775806", product_id: "9223372036854775807" },
      query: { page_size: 10 },
    });
    expect(h.calls[0]!.url.pathname).toBe(
      "/affiliate_partner/202508/campaigns/9223372036854775806/products/9223372036854775807/performance",
    );
    await expect(
      h.adapter.execute(credentials, op.id, { path: { campaign_id: "../other", product_id: "42" } }),
    ).rejects.toMatchObject({ code: "commerce_invalid_input" });
    expect(h.calls).toHaveLength(1);
    expect(JSON.stringify(h.records)).not.toContain("ASSET_PRIVATE");
  });
  it("uploads return labels and QR evidence in one signed multipart request with per-field limits", async () => {
    const h = harness({});
    const op = operation("/return_refund/202405/returns/shipping_documents");
    const labelId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const qrId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const files = {
      [labelId]: { bytes: Buffer.from("%PDF-1.7\nPRIVATE_LABEL"), mime: "application/pdf", filename: "commerce.pdf" },
      [qrId]: { bytes: Buffer.from("%PDF-1.7\nPRIVATE_QR"), mime: "application/pdf", filename: "commerce.pdf" },
    };
    const input = {
      query: { return_ids: ["9223372036854775806"], return_id_type: "RMA" },
      body: {
        return_shipping_label: labelId,
        return_qr_code: qrId,
        tracking_number: "TRACK_PRIVATE",
        return_provider_id: "42",
      },
    };
    await h.adapter.execute({ accessToken: "seller", shopCipher: "SHOP_PRIVATE", files }, op.id, input);
    const { url, init } = h.calls[0]!;
    const form = init.body as FormData;
    expect(form.get("return_shipping_label")).toBeInstanceOf(Blob);
    expect(form.get("return_qr_code")).toBeInstanceOf(Blob);
    expect(form.get("tracking_number")).toBe("TRACK_PRIVATE");
    expect(url.searchParams.get("return_ids")).toBe("9223372036854775806");
    const query = Object.fromEntries(url.searchParams);
    expect(query.sign).toBe(tiktokSign("fixture-secret", tiktokSignString({ path: op.path, query })));
    for (const value of ["TRACK_PRIVATE", "PRIVATE_LABEL", "SHOP_PRIVATE"])
      expect(JSON.stringify(h.records)).not.toContain(value);
    files[qrId]!.bytes = Buffer.alloc(2_000_001);
    await expect(h.adapter.execute({ accessToken: "seller", files }, op.id, input)).rejects.toMatchObject({
      code: "commerce_invalid_file",
    });
    expect(h.calls).toHaveLength(1);
  });
  it("never retains invisible provider messages or conversation previews in generic commerce results", async () => {
    const h = harness({
      messages: [
        { id: "visible", is_visible: true, content: "PUBLIC" },
        { id: "invisible", is_visible: false, content: "PRIVATE_HIDDEN_MESSAGE" },
        { id: "unspecified", content: "PRIVATE_UNVERIFIED_MESSAGE" },
      ],
    });
    const messages = operation("/customer_service/202309/conversations/{conversation_id}/messages");
    const result = await h.adapter.execute({ accessToken: "seller" }, messages.id, {
      path: { conversation_id: "thread" },
      query: { page_size: 10 },
    });
    expect(result.data).toMatchObject({ messages: [{ id: "visible", is_visible: true, content: "PUBLIC" }] });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    h.setResponse({
      code: 0,
      data: {
        conversations: [
          { id: "first", latest_message: { id: "hidden", is_visible: false, content: "PRIVATE_PREVIEW" } },
          { id: "second", latest_message: { id: "visible", is_visible: true, content: "PUBLIC" } },
        ],
      },
    });
    const conversations = TIKTOK_COMMERCE_OPERATIONS.find((item) => item.id === "tiktok_650a589f0fcef602bf29fecf")!;
    const threads = await h.adapter.execute({ accessToken: "seller" }, conversations.id, { query: { page_size: 10 } });
    expect(threads.data).toMatchObject({
      conversations: [{ id: "first" }, { id: "second", latest_message: { content: "PUBLIC" } }],
    });
    expect(JSON.stringify(threads)).not.toContain("PRIVATE_PREVIEW");
    expect(JSON.stringify(h.records)).not.toContain("PRIVATE_");
  });
});
