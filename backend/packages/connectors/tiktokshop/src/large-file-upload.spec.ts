import { type CallRecord, withGrantedScopes } from "@omniseller/connector-core";
import { describe, expect, it, vi } from "vitest";
import { TiktokShopClient, tiktokSign, tiktokSignString } from "./client.js";
import {
  type TiktokLargeVideoInput,
  tiktokLargeVideoChunkRanges,
  uploadTiktokLargeVideo,
} from "./large-file-upload.js";

const MIB = 1024 * 1024;
const API = "https://open-api.tiktokglobalshop.com";
const SELLER_TARGET = "tiktok_6a1ff121795c140490537a5c";
const CREATOR_TARGET = "tiktok_69cb362bf76068049e7a08f2";
const PRIVATE_TOKEN = "PRIVATE_ACCESS_TOKEN";
const UPLOAD_TOKEN = "PRIVATE_UPLOAD_TOKEN";
const SHOP_CIPHER = "PRIVATE_SHOP_CIPHER";
const FILE_NAME = "PRIVATE_FILENAME.mp4";
interface SeenRequest {
  url: URL;
  method: string;
  headers: Headers;
  bodyBytes: number | null;
  json: Record<string, unknown> | null;
  redirect: RequestInit["redirect"];
}
function harness(
  options: {
    uploadUrl?: string;
    initResponse?: () => Response | Promise<Response>;
    chunkResponse?: (number: number, total: number) => Response | Promise<Response>;
  } = {},
) {
  const calls: SeenRequest[] = [];
  const records: CallRecord[] = [];
  const gates = vi.fn(async () => {});
  const feedback = vi.fn(async (_value: unknown) => {});
  let count = 0;
  let total = 0;
  const client = new TiktokShopClient({
    appKey: "public-app-key",
    appSecret: "PRIVATE_APP_SECRET",
    apiBaseUrl: API,
    authBaseUrl: "https://auth.tiktok-shops.com",
    authorizeUrl: "https://services.tiktokshop.com/open/authorize",
    http: {
      beforeRequest: gates,
      afterResponse: feedback,
      observer: (record) => records.push(record),
      fetch: (async (url, init) => {
        const json = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const body = init?.body;
        calls.push({
          url: new URL(String(url)),
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
          bodyBytes: body instanceof Uint8Array ? body.byteLength : null,
          json,
          redirect: init?.redirect,
        });
        if (init?.method === "POST") {
          total = json.total_chunk_count;
          if (options.initResponse) return options.initResponse();
          return Response.json({
            code: 0,
            data: {
              upload_url: options.uploadUrl ?? `${API}/file/v1/upload?route=sg-unit`,
              upload_token: UPLOAD_TOKEN,
            },
          });
        }
        count += 1;
        if (options.chunkResponse) return options.chunkResponse(count, total);
        return Response.json({
          code: 0,
          data: count === total ? { resource_id: "9223372036854775806" } : { part_id: `PRIVATE_PART_${count}` },
        });
      }) as typeof fetch,
    },
  });
  return { client, calls, records, gates, feedback };
}
function source(size = 50 * MIB, targetOperationId = SELLER_TARGET): Extract<TiktokLargeVideoInput, { size: number }> {
  return {
    accessToken: PRIVATE_TOKEN,
    shopCipher: SHOP_CIPHER,
    targetOperationId,
    filename: FILE_NAME,
    contentType: "video/mp4",
    size,
    readRange: async (start, end) => new Uint8Array(end - start),
  };
}

describe("TikTok large video upload protocol", () => {
  it("uploads a small chat video as the explicitly documented single chunk while creator files keep direct upload", async () => {
    const h = harness();
    expect(await uploadTiktokLargeVideo(h.client, source(512 * 1024))).toBe("9223372036854775806");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.json).toMatchObject({
      file_size: 512 * 1024,
      total_chunk_count: 1,
      target_path: "[POST]/customer_service/202606/conversations/{conversation_id}/messages",
    });
    expect(h.calls[1]!.bodyBytes).toBe(512 * 1024);
    const creator = harness();
    await expect(uploadTiktokLargeVideo(creator.client, source(512 * 1024, CREATOR_TARGET))).rejects.toMatchObject({
      code: "commerce_invalid_file",
    });
    expect(creator.calls).toHaveLength(0);
  });
  it("bounds unavailable chunk-rate feedback without losing the acknowledged video resource", async () => {
    const h = harness();
    h.feedback.mockImplementationOnce(async () => {}).mockImplementation(async () => new Promise<void>(() => {}));
    const started = performance.now();
    expect(await uploadTiktokLargeVideo(h.client, source(512 * 1024))).toBe("9223372036854775806");
    expect(h.calls).toHaveLength(2);
    expect(performance.now() - started).toBeLessThan(1800);
  });
  it("plans exact ranges and merges tails below five MiB", () => {
    expect(tiktokLargeVideoChunkRanges(50 * MIB)).toEqual([
      { start: 0, end: 20 * MIB },
      { start: 20 * MIB, end: 40 * MIB },
      { start: 40 * MIB, end: 50 * MIB },
    ]);
    expect(tiktokLargeVideoChunkRanges(44 * MIB)).toEqual([
      { start: 0, end: 20 * MIB },
      { start: 20 * MIB, end: 44 * MIB },
    ]);
    expect(tiktokLargeVideoChunkRanges(45 * MIB).map(({ start, end }) => end - start)).toEqual([
      20 * MIB,
      20 * MIB,
      5 * MIB,
    ]);
    expect(tiktokLargeVideoChunkRanges(500 * MIB)).toHaveLength(25);
    expect(() => tiktokLargeVideoChunkRanges(0)).toThrow();
    expect(() => tiktokLargeVideoChunkRanges(501 * MIB)).toThrow();
  });

  it("signs init, streams fifty MiB as three raw PUTs and returns the exact final id without a merge call", async () => {
    const h = harness();
    const input = source();
    const readRange = vi.fn(input.readRange!);
    const resource = await uploadTiktokLargeVideo(h.client, { ...input, readRange });
    expect(resource).toBe("9223372036854775806");
    expect(h.calls).toHaveLength(4);
    expect(h.gates).toHaveBeenCalledTimes(4);
    expect(h.feedback).toHaveBeenCalledTimes(4);
    expect(h.gates.mock.calls.slice(1)).toEqual(
      Array.from({ length: 3 }, () => [
        { method: "PUT", path: "/file/chunk-upload", applicationId: "public-app-key", principalScoped: true },
      ]),
    );
    for (const [value] of h.feedback.mock.calls.slice(1))
      expect(value).toMatchObject({
        method: "PUT",
        path: "/file/chunk-upload",
        httpStatus: 200,
        businessCode: "0",
        complete: true,
      });
    for (const privateValue of [PRIVATE_TOKEN, UPLOAD_TOKEN, SHOP_CIPHER, "route=sg-unit"])
      expect(JSON.stringify(h.feedback.mock.calls)).not.toContain(privateValue);
    expect(readRange.mock.calls).toEqual([
      [0, 20 * MIB],
      [20 * MIB, 40 * MIB],
      [40 * MIB, 50 * MIB],
    ]);
    const init = h.calls[0]!;
    expect(init.json).toEqual({
      file_size: 50 * MIB,
      file_name: FILE_NAME,
      total_chunk_count: 3,
      file_type: "video",
      target_path: "[POST]/customer_service/202606/conversations/{conversation_id}/messages",
    });
    expect(init.url.pathname).toBe("/open/202512/file/init");
    expect(init.url.searchParams.has("shop_cipher")).toBe(false);
    const query = Object.fromEntries(init.url.searchParams);
    expect(query.sign).toBe(
      tiktokSign(
        "PRIVATE_APP_SECRET",
        tiktokSignString({ path: init.url.pathname, query, body: JSON.stringify(init.json) }),
      ),
    );
    expect(h.calls.slice(1).map((call) => call.bodyBytes)).toEqual([20 * MIB, 20 * MIB, 10 * MIB]);
    for (const [index, call] of h.calls.slice(1).entries()) {
      expect(call.method).toBe("PUT");
      expect(call.redirect).toBe("manual");
      expect(call.url.origin).toBe(API);
      expect(call.url.pathname).toBe("/file/v1/upload");
      expect(call.url.searchParams.get("route")).toBe("sg-unit");
      expect(call.url.searchParams.get("chunk_num")).toBe(String(index + 1));
      expect(call.url.searchParams.get("upload_token")).toBe(UPLOAD_TOKEN);
      expect(call.url.searchParams.get("shop_cipher")).toBe(SHOP_CIPHER);
      expect(call.url.searchParams.has("sign")).toBe(false);
      expect(call.url.searchParams.has("timestamp")).toBe(false);
      expect(call.url.searchParams.has("app_secret")).toBe(false);
      expect(call.headers.get("x-tts-access-token")).toBe(PRIVATE_TOKEN);
      expect(call.headers.get("content-type")).toBe("video/mp4");
      expect(call.headers.get("content-length")).toBe(String(call.bodyBytes));
      expect(call.json).toBeNull();
    }
    const logged = JSON.stringify(h.records);
    for (const secret of [
      PRIVATE_TOKEN,
      UPLOAD_TOKEN,
      SHOP_CIPHER,
      FILE_NAME,
      "PRIVATE_APP_SECRET",
      "PRIVATE_PART_",
      "9223372036854775806",
      "route=sg-unit",
    ])
      expect(logged).not.toContain(secret);
    expect(h.records.at(-1)).toMatchObject({
      path: "/file/chunk-upload",
      request: { chunk: 3, chunks: 3 },
      response: { completed: true },
    });
  });

  it("keeps a five-hundred-MiB creator file bounded to twenty-MiB reads and omits seller identifiers", async () => {
    const h = harness();
    const reads: number[] = [];
    const input = source(500 * MIB, CREATOR_TARGET);
    await withGrantedScopes({ principalKind: "creator", scopes: ["creator.video.write"] }, () =>
      uploadTiktokLargeVideo(h.client, {
        ...input,
        readRange: async (start: number, end: number) => {
          reads.push(end - start);
          return new Uint8Array(end - start);
        },
      }),
    );
    expect(reads).toHaveLength(25);
    expect(Math.max(...reads)).toBe(20 * MIB);
    expect(reads.reduce((sum, bytes) => sum + bytes, 0)).toBe(500 * MIB);
    expect(h.calls).toHaveLength(26);
    expect(h.calls.every((call) => !call.url.searchParams.has("shop_cipher"))).toBe(true);
    expect(h.calls[0]!.json?.target_path).toBe("[POST]/affiliate_creator/202603/videos");
  });

  it.each([
    "https://attacker.example/file/upload",
    "http://open-api.tiktokglobalshop.com/file/upload",
    "https://open-api.tiktokglobalshop.com.attacker.example/file/upload",
    "https://user:password@open-api.tiktokglobalshop.com/file/upload",
    "https://@open-api.tiktokglobalshop.com/file/upload",
    "//open-api.tiktokglobalshop.com/file/upload",
    `${API}/file/upload#private-fragment`,
    `${API}/file/upload?app_secret=secret`,
    `${API}/file/upload?sign=other-protocol`,
  ])("rejects an untrusted destination before sending chunk credentials: %s", async (uploadUrl) => {
    const h = harness({ uploadUrl });
    await expect(uploadTiktokLargeVideo(h.client, source())).rejects.toMatchObject({
      kind: "permanent",
      code: "upload_url_rejected",
    });
    expect(h.calls).toHaveLength(1);
  });

  it("rejects target injection, missing seller cipher and unsupported media before HTTP", async () => {
    const h = harness();
    await expect(
      uploadTiktokLargeVideo(h.client, { ...source(), targetOperationId: "[POST]https://attacker.example" }),
    ).rejects.toMatchObject({ code: "commerce_invalid_target" });
    await expect(uploadTiktokLargeVideo(h.client, { ...source(), shopCipher: null })).rejects.toMatchObject({
      code: "commerce_invalid_credentials",
    });
    await expect(
      uploadTiktokLargeVideo(h.client, { ...source(), contentType: "application/pdf" as "video/mp4" }),
    ).rejects.toMatchObject({ code: "commerce_invalid_file" });
    await expect(
      withGrantedScopes({ principalKind: "seller", scopes: [] }, () => uploadTiktokLargeVideo(h.client, source())),
    ).rejects.toMatchObject({ code: "missing_scope" });
    expect(h.calls).toHaveLength(0);
  });

  it("rejects redirects at initialization and at each chunk without following them", async () => {
    const init = harness({
      initResponse: () => new Response(null, { status: 307, headers: { location: "https://attacker.example" } }),
    });
    await expect(uploadTiktokLargeVideo(init.client, source())).rejects.toMatchObject({ kind: "permanent" });
    expect(init.calls).toHaveLength(1);
    expect(init.calls[0]!.redirect).toBe("manual");
    const chunk = harness({
      chunkResponse: () => new Response(null, { status: 307, headers: { location: "https://attacker.example" } }),
    });
    await expect(uploadTiktokLargeVideo(chunk.client, source())).rejects.toMatchObject({
      kind: "permanent",
      code: "upload_redirect_rejected",
    });
    expect(chunk.calls).toHaveLength(2);
  });

  it("never automatically resends a chunk after a network failure", async () => {
    const h = harness({
      chunkResponse: () => {
        throw new Error(`private URL ${API}?upload_token=${UPLOAD_TOKEN}`);
      },
    });
    let caught: unknown;
    try {
      await uploadTiktokLargeVideo(h.client, source());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ kind: "permanent", code: "write_outcome_unknown" });
    expect(String(caught)).not.toContain(UPLOAD_TOKEN);
    expect(h.calls).toHaveLength(2);
    expect(JSON.stringify(h.records)).not.toContain(UPLOAD_TOKEN);
  });

  it.each([
    { data: {} },
    { code: "0", data: { part_id: "part" } },
    { code: 0, data: {} },
    { code: 0, data: { resource_id: "too-early" } },
  ])("does not advance after an unconfirmed non-final part: %j", async (envelope) => {
    const h = harness({ chunkResponse: () => Response.json(envelope) });
    await expect(uploadTiktokLargeVideo(h.client, source())).rejects.toMatchObject({
      kind: "permanent",
      code: "write_outcome_unknown",
    });
    expect(h.calls).toHaveLength(2);
  });

  it("requires resource_id on the final chunk and treats missing completion as an unknown outcome", async () => {
    const h = harness({ chunkResponse: () => Response.json({ code: 0, data: { part_id: "part" } }) });
    await expect(uploadTiktokLargeVideo(h.client, source())).rejects.toMatchObject({
      kind: "permanent",
      code: "write_outcome_unknown",
    });
    expect(h.calls).toHaveLength(4);
  });

  it("preserves permission failures as permanent without leaking marketplace response text", async () => {
    const h = harness({ chunkResponse: () => Response.json({ code: 105005, message: `secret ${UPLOAD_TOKEN}` }) });
    await expect(uploadTiktokLargeVideo(h.client, source())).rejects.toMatchObject({
      kind: "permanent",
      code: "105005",
    });
    expect(JSON.stringify(h.records)).not.toContain(UPLOAD_TOKEN);
    expect(h.calls).toHaveLength(2);
  });

  it("rejects short file reads and bounded-response overflow without sending another chunk", async () => {
    const short = harness();
    await expect(
      uploadTiktokLargeVideo(short.client, { ...source(), readRange: async () => new Uint8Array(1) }),
    ).rejects.toMatchObject({ code: "commerce_file_read_failed" });
    expect(short.calls).toHaveLength(1);
    const large = harness({ chunkResponse: () => new Response("x".repeat(70_000), { status: 200 }) });
    await expect(uploadTiktokLargeVideo(large.client, source())).rejects.toMatchObject({
      kind: "permanent",
      code: "write_outcome_unknown",
    });
    expect(large.calls).toHaveLength(2);
  });
  it("supports an already bounded byte buffer without a stream callback", async () => {
    const h = harness();
    const { size: _size, readRange: _reader, ...metadata } = source();
    expect(await uploadTiktokLargeVideo(h.client, { ...metadata, bytes: new Uint8Array(20 * MIB) })).toBe(
      "9223372036854775806",
    );
    expect(h.calls.map((call) => call.bodyBytes)).toEqual([null, 20 * MIB]);
  });

  it.each([400, 429, 503])("never retries an uncertain HTTP %s chunk result", async (status) => {
    const h = harness({ chunkResponse: () => Response.json({ code: 0, data: { part_id: "part" } }, { status }) });
    await expect(uploadTiktokLargeVideo(h.client, source())).rejects.toMatchObject({
      kind: "permanent",
      code: "write_outcome_unknown",
    });
    expect(h.calls).toHaveLength(2);
  });

  it("stops a partially uploaded session when the per-request gate interrupts the next part", async () => {
    const h = harness();
    h.gates
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        throw new Error("rate gate interrupted");
      });
    await expect(uploadTiktokLargeVideo(h.client, source())).rejects.toMatchObject({
      kind: "permanent",
      code: "write_outcome_unknown",
    });
    expect(h.calls).toHaveLength(2);
  });
});
