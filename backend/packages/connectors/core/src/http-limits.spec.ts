import { describe, expect, it, vi } from "vitest";
import { PermanentConnectorError, TransientConnectorError } from "./errors.js";
import { type CallRecord, type HttpConfig, requestFile, requestJson } from "./http.js";

const req = { method: "GET" as const, url: new URL("https://example.test/private?access_token=secret") };
const encoder = new TextEncoder();
function streaming(chunks: Uint8Array[], init?: ResponseInit) {
  let position = 0;
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const chunk = chunks[position++];
    if (chunk) controller.enqueue(chunk);
    else controller.close();
  });
  const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), init);
  const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch;
  return { response, fetch, cancel, pull };
}

for (const kind of ["json", "file"] as const) {
  describe(`${kind} bounded HTTP responses`, () => {
    const call = (config: HttpConfig) =>
      kind === "json" ? requestJson(config, req, () => undefined) : requestFile(config, req, () => undefined);
    const oversizedCode = kind === "json" ? "response_too_large" : "file_too_large";
    const hardLimit = (kind === "json" ? 32 : 25) * 1024 * 1024;

    it("cancels chunked responses at the first over-limit chunk without consuming the rest", async () => {
      const source = streaming([
        encoder.encode("1234"),
        encoder.encode("5678"),
        encoder.encode("9"),
        encoder.encode("secret"),
      ]);
      const records: CallRecord[] = [];
      const beforeRequest = vi.fn(async () => undefined);
      expect(source.response.headers.has("content-length")).toBe(false);
      await expect(
        call({ fetch: source.fetch, maxResponseBytes: 8, beforeRequest, observer: (r) => records.push(r) }),
      ).rejects.toMatchObject({ code: oversizedCode, kind: "permanent", httpStatus: 200 });
      expect(source.cancel).toHaveBeenCalledOnce();
      expect(source.pull).toHaveBeenCalledTimes(3);
      expect(source.fetch).toHaveBeenCalledOnce();
      expect(beforeRequest).toHaveBeenCalledOnce();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ errorCode: oversizedCode, response: { bytes: 9, maxBytes: 8 } });
      expect(JSON.stringify(records)).not.toContain("secret");
    });

    it("checks actual streamed bytes even when Content-Length understates them", async () => {
      const source = streaming([new Uint8Array(9)], { headers: { "content-length": "1" } });
      await expect(call({ fetch: source.fetch, maxResponseBytes: 8 })).rejects.toMatchObject({ code: oversizedCode });
      expect(source.cancel).toHaveBeenCalledOnce();
    });

    it("rejects a declared oversized body before reading any chunk and keeps the hard ceiling", async () => {
      const source = streaming([new Uint8Array(1)], { headers: { "content-length": String(hardLimit + 1) } });
      await expect(call({ fetch: source.fetch, maxResponseBytes: hardLimit * 2 })).rejects.toMatchObject({
        code: oversizedCode,
      });
      expect(source.pull).not.toHaveBeenCalled();
      expect(source.cancel).toHaveBeenCalledOnce();
    });

    it.each([429, 503])(
      "preserves transient HTTP %i and Retry-After after cancelling an oversized body",
      async (status) => {
        const source = streaming([new Uint8Array(9)], { status, headers: { "retry-after": "2" } });
        await expect(call({ fetch: source.fetch, maxResponseBytes: 8 })).rejects.toMatchObject({
          code: `http_${status}`,
          kind: "transient",
          httpStatus: status,
          retryAfterMs: 2000,
        });
        expect(source.cancel).toHaveBeenCalledOnce();
      },
    );

    it("classifies an interrupted response stream as a transient network error", async () => {
      let calls = 0;
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (calls++ === 0) controller.enqueue(encoder.encode("123"));
              else controller.error(new Error("secret upstream request"));
            },
          },
          { highWaterMark: 0 },
        ),
      );
      const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch;
      await expect(call({ fetch })).rejects.toMatchObject({
        code: "network",
        kind: "transient",
        detail: "response body interrupted",
        httpStatus: 200,
      });
    });

    it("does not wait for the server to acknowledge cancellation", async () => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const response = new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.enqueue(new Uint8Array(9));
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      );
      const fetch = (async () => response) as typeof globalThis.fetch;
      await expect(call({ fetch, maxResponseBytes: 8 })).rejects.toBeInstanceOf(PermanentConnectorError);
      expect(cancel).toHaveBeenCalledOnce();
    });
  });
}

describe("bounded response compatibility", () => {
  it("decodes JSON at the exact byte boundary with multibyte UTF-8 split across chunks", async () => {
    const bytes = encoder.encode('{"name":"é"}');
    const source = streaming(Array.from(bytes, (byte) => new Uint8Array([byte])));
    const result = await requestJson({ fetch: source.fetch, maxResponseBytes: bytes.length }, req, () => undefined);
    expect(result.json).toEqual({ name: "é" });
    expect(source.cancel).not.toHaveBeenCalled();
  });
  it("accepts a binary file at the exact limit and returns unchanged bytes", async () => {
    const source = streaming([new Uint8Array([0, 1]), new Uint8Array([2, 3])]);
    const result = await requestFile({ fetch: source.fetch, maxResponseBytes: 4 }, req, () => undefined);
    expect(result.bytes).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(source.cancel).not.toHaveBeenCalled();
  });
  it("retains JSON error envelopes for the marketplace classifier", async () => {
    const source = streaming([encoder.encode('{"code":105002}')], {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    const result = await requestFile({ fetch: source.fetch }, req, () => undefined);
    expect(result).toMatchObject({ status: 401, json: { code: 105002 } });
    expect(source.cancel).not.toHaveBeenCalled();
  });
  it("retains transient non-JSON status handling below the response ceiling", async () => {
    const source = streaming([encoder.encode("upstream unavailable")], { status: 502 });
    await expect(requestJson({ fetch: source.fetch }, req, () => undefined)).rejects.toBeInstanceOf(
      TransientConnectorError,
    );
  });
  it("rejects an invalid configured limit before making HTTP requests", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    await expect(requestJson({ fetch, maxResponseBytes: 0 }, req, () => undefined)).rejects.toBeInstanceOf(RangeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
