import { createHash } from "node:crypto";
import { type CallRecord, type CommerceCredentials, parseJsonSafe } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import { ShopeeClient, shopeeSign } from "./client.js";
import { shopeeCommerce } from "./commerce.js";

const USER = "9007199254740993";
const FILE = "01K7WXAANPJM73Z4T7MDTYVJ7Z";
const PART = 4 * 1024 * 1024;
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");
const success = (response?: object) => ({ error: "", request_id: "media", ...(response ? { response } : {}) });
function video(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("ftyp"), 4);
  return bytes;
}
type Call = { url: URL; fields: Record<string, unknown>; part?: Uint8Array };
function harness(reply?: (call: Call) => unknown) {
  const calls: Call[] = [];
  const records: CallRecord[] = [];
  let gated = 0;
  const api = shopeeCommerce(
    new ShopeeClient({
      partnerId: 123,
      partnerKey: "key",
      apiBaseUrl: "https://partner.shopeemobile.com",
      authBaseUrl: "https://open.shopee.com",
      http: {
        beforeRequest: async () => {
          gated++;
        },
        observer: (record) => records.push(record),
        fetch: (async (input, init) => {
          const body = init?.body;
          const fields: Record<string, unknown> = {};
          let part: Uint8Array | undefined;
          if (body instanceof FormData) {
            for (const [key, value] of body.entries()) {
              if (value instanceof Blob) {
                fields[key] = { size: value.size, type: value.type };
                part = new Uint8Array(await value.arrayBuffer());
              } else fields[key] = value;
            }
          } else Object.assign(fields, parseJsonSafe(String(body ?? "{}")));
          const call = { url: new URL(String(input)), fields, part };
          calls.push(call);
          const result = reply
            ? reply(call)
            : call.url.pathname.endsWith("init_video_upload")
              ? success({ video_upload_id: "upload-id", part_size: PART })
              : success();
          return new Response(JSON.stringify(result));
        }) as typeof fetch,
      },
    }),
  );
  return { api, calls, records, gated: () => gated };
}
const seller = (bytes: Uint8Array): CommerceCredentials => ({
  externalShopId: USER,
  accessToken: "private-token",
  files: { [FILE]: { bytes, mime: "video/mp4", filename: "private-buyer-name.mp4" } },
});

describe("Shopee product and creator media workflows", () => {
  it("initializes seller video with shop signing, uploads exact 4MiB parts with public signatures, then completes once", async () => {
    const bytes = video(PART + 19);
    const h = harness();
    const result = await h.api.execute(seller(bytes), "shopee.media_space.init_video_upload", { body: { file: FILE } });
    expect(result).toMatchObject({
      acknowledgement: "accepted",
      data: { video_upload_id: "upload-id", processing_pending: true },
    });
    expect(h.calls.map((c) => c.url.pathname)).toEqual([
      "/api/v2/media_space/init_video_upload",
      "/api/v2/media_space/upload_video_part",
      "/api/v2/media_space/upload_video_part",
      "/api/v2/media_space/complete_video_upload",
    ]);
    expect(h.calls[0]!.fields).toEqual({ file_md5: md5(bytes), file_size: bytes.length });
    for (const [index, call] of h.calls.entries()) {
      const tail = index === 0 ? `private-token${USER}` : "";
      expect(call.url.searchParams.get("sign")).toBe(
        shopeeSign("key", `123${call.url.pathname}${call.url.searchParams.get("timestamp")}${tail}`),
      );
      expect(call.url.searchParams.has("shop_id")).toBe(index === 0);
    }
    expect(h.calls[1]!.part?.length).toBe(PART);
    expect(h.calls[2]!.part?.length).toBe(19);
    expect(h.calls[1]!.fields.content_md5).toBe(md5(bytes.subarray(0, PART)));
    expect(h.calls[2]!.fields.part_seq).toBe("1");
    expect(h.calls[3]!.fields).toMatchObject({ video_upload_id: "upload-id", part_seq_list: [0, 1] });
    expect(h.gated()).toBe(4);
    expect(JSON.stringify(h.records)).not.toMatch(/private-token|private-buyer|file_md5|part_content|upload-id/);
  });
  it("uses separate user signatures for Live and never falls back to a seller grant", async () => {
    const h = harness(() => success({ item_count: 2, max_item_count: 500 }));
    await h.api.execute({ externalAccountId: USER, accessToken: "creator-token" }, "shopee.livestream.get_item_count", {
      query: { session_id: USER },
    });
    const call = h.calls[0]!;
    expect(call.url.searchParams.get("user_id")).toBe(USER);
    expect(call.url.searchParams.has("shop_id")).toBe(false);
    expect(call.url.searchParams.get("sign")).toBe(
      shopeeSign("key", `123${call.url.pathname}${call.url.searchParams.get("timestamp")}creator-token${USER}`),
    );
    await expect(
      h.api.execute({ externalShopId: USER, accessToken: "seller-token" }, "shopee.livestream.get_item_count", {
        query: { session_id: USER },
      }),
    ).rejects.toMatchObject({ code: "commerce_principal_required" });
    expect(h.calls).toHaveLength(1);
  });
  it("uploads creator video from bounded ranges using server part_size and its distinct part_md5", async () => {
    const bytes = video(PART + 12);
    const ranges: number[][] = [];
    const h = harness();
    const result = await h.api.execute(
      {
        externalAccountId: USER,
        accessToken: "creator",
        files: {
          [FILE]: {
            bytes: new Uint8Array(),
            mime: "video/mp4",
            filename: "secret.mp4",
            size: bytes.length,
            readRange: async (start, end) => {
              ranges.push([start, end]);
              return bytes.subarray(start, end);
            },
          },
        },
      },
      "shopee.media.init_video_upload",
      { body: { file: FILE, duration: 180 } },
    );
    expect(result.acknowledgement).toBe("accepted");
    expect(ranges).toEqual([
      [0, 16],
      [0, PART],
      [PART, PART + 12],
    ]);
    expect(h.calls[0]!.fields).toEqual({
      business: 3,
      scene: 1,
      file_name: "commerce.mp4",
      file_size: bytes.length,
      duration: 180,
    });
    expect(h.calls[1]!.fields.part_md5).toBe(md5(bytes.subarray(0, PART)));
    expect(h.calls[1]!.fields.content_md5).toBeUndefined();
    expect(h.calls.at(-1)!.fields).toEqual({ video_upload_id: "upload-id" });
    expect(h.calls.every((call) => !call.url.searchParams.has("access_token"))).toBe(true);
  });
  it.each([{}, { error: "", request_id: "" }, { error: "", request_id: "ok", response: {} }])(
    "stops before uploading parts when initialization is malformed %#",
    async (value) => {
      const h = harness(() => value);
      await expect(
        h.api.execute(seller(video(100)), "shopee.media_space.init_video_upload", { body: { file: FILE } }),
      ).rejects.toMatchObject({ code: "commerce_bad_response" });
      expect(h.calls).toHaveLength(1);
    },
  );
  it("does not complete or resend after an unconfirmed part response", async () => {
    const h = harness((call) =>
      call.url.pathname.endsWith("init_video_upload") ? success({ video_upload_id: "id" }) : {},
    );
    await expect(
      h.api.execute(seller(video(PART + 1)), "shopee.media_space.init_video_upload", { body: { file: FILE } }),
    ).rejects.toMatchObject({ code: "commerce_bad_response" });
    expect(h.calls).toHaveLength(2);
  });
  it.each([0, 31 * 1024 * 1024, 1])(
    "rejects unsafe server part sizes before reading a large file: %s",
    async (partSize) => {
      const ranges: number[][] = [];
      const h = harness(() => success({ video_upload_id: "id", part_size: partSize }));
      await expect(
        h.api.execute(
          {
            externalAccountId: USER,
            accessToken: "creator",
            files: {
              [FILE]: {
                bytes: new Uint8Array(),
                mime: "video/mp4",
                filename: "commerce.mp4",
                size: 500 * 1024 * 1024,
                readRange: async (start, end) => {
                  ranges.push([start, end]);
                  return video(end - start);
                },
              },
            },
          },
          "shopee.media.init_video_upload",
          { body: { file: FILE, duration: 30 } },
        ),
      ).rejects.toMatchObject({ code: "commerce_bad_response" });
      expect(ranges).toEqual([[0, 16]]);
      expect(h.calls).toHaveLength(1);
    },
  );
  it("refuses an absent private file or mismatched MP4 signature before initializing an upload", async () => {
    const h = harness();
    await expect(
      h.api.execute(seller(new Uint8Array(16)), "shopee.media_space.init_video_upload", { body: { file: FILE } }),
    ).rejects.toMatchObject({ code: "commerce_invalid_file" });
    await expect(
      h.api.execute({ externalShopId: USER, accessToken: "seller" }, "shopee.media_space.init_video_upload", {
        body: { file: FILE },
      }),
    ).rejects.toMatchObject({ code: "commerce_invalid_file" });
    expect(h.calls).toHaveLength(0);
  });
  it("uses the documented returns image field and fixed business/scene instead of a user URL", async () => {
    const h = harness(() => success({ image_list: [{ image_id: "image-id" }] }));
    await h.api.execute(
      {
        externalShopId: USER,
        accessToken: "seller",
        files: {
          [FILE]: {
            bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
            mime: "image/png",
            filename: "private.png",
          },
        },
      },
      "shopee.media.upload_image",
      { body: { images: FILE } },
    );
    expect(h.calls[0]!.fields).toEqual({ business: "2", scene: "1", images: { size: 8, type: "image/png" } });
    expect(h.calls[0]!.url.searchParams.has("access_token")).toBe(false);
  });
  it.each([{}, { image_info_list: [{ error: "rejected", image_info: { image_id: "stale" } }] }])(
    "refuses missing image confirmation or per-image failure %#",
    async (response) => {
      const h = harness(() => success(response));
      await expect(
        h.api.execute(
          {
            externalShopId: USER,
            accessToken: "seller",
            files: {
              [FILE]: {
                bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
                mime: "image/png",
                filename: "private.png",
              },
            },
          },
          "shopee.media_space.upload_image",
          { body: { image: FILE } },
        ),
      ).rejects.toThrow();
      expect(h.calls).toHaveLength(1);
    },
  );
  it("keeps OBS credentials exclusively in private artifact bytes and strips them from ordinary details", async () => {
    const secret = "PRIVATE-OBS-KEY-CANARY";
    const h = harness(() =>
      success({
        session_id: "42",
        stream_url_list: {
          push_url: "rtmp://push.shopee.co.id/live",
          push_key: secret,
          play_url: "https://play.shopee.co.id/live?auditkey=private",
          domain_id: 57,
        },
      }),
    );
    const credentials = { externalAccountId: USER, accessToken: "creator" };
    const input = { query: { session_id: USER } };
    const result = await h.api.execute(credentials, "shopee.livestream.get_stream_credentials", input);
    expect(result.download?.mime).toBe("text/plain");
    expect(new TextDecoder().decode(result.download?.bytes)).toContain(secret);
    expect(JSON.stringify(result.data)).not.toContain(secret);
    const details = await h.api.execute(credentials, "shopee.livestream.get_session_detail", input);
    expect(JSON.stringify(details)).not.toMatch(/PRIVATE-OBS|auditkey|rtmp:/);
    expect(JSON.stringify(h.records)).not.toMatch(/PRIVATE-OBS|auditkey|rtmp:/);
  });
  it("filters app-wide payment options to the selected Indonesian market", async () => {
    const h = harness(() =>
      success([
        { region: "ID", payment_method: [1] },
        { region: "MY", payment_method: [2] },
      ]),
    );
    const result = await h.api.execute(
      { externalShopId: USER, accessToken: "seller" },
      "shopee.payment.get_payment_method_list",
      {},
    );
    expect(result.data).toEqual([{ region: "ID", payment_method: [1] }]);
    expect(h.calls[0]!.url.searchParams.has("shop_id")).toBe(false);
  });
});
