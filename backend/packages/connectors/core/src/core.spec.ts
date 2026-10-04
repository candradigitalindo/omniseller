import { describe, expect, it } from "vitest";
import { signatureEquals } from "./crypto.js";
import { PermanentConnectorError, TransientConnectorError } from "./errors.js";
import { type CallRecord, isPdf, parseJsonSafe, requestFile, requestJson, retryAfter, toRupiah } from "./http.js";
import { REDACTED, redactUrl, redactValue, summarize } from "./redact.js";
import { type TrackingStage, trackingStageOf } from "./types.js";

describe("redaction", () => {
  it("masks secrets and personal data at any depth, keeps the rest", () => {
    const out = redactValue({
      access_token: "a",
      data: { shops: [{ id: "1", name: "Toko" }], recipient_address: { city: "Jakarta" }, phone_number: "0812" },
      refresh_token: "r",
    });
    expect(out).toEqual({
      access_token: REDACTED,
      data: { shops: [{ id: "1", name: "Toko" }], recipient_address: REDACTED, phone_number: REDACTED },
      refresh_token: REDACTED,
    });
  });

  it("masks secret query parameters and drops the host", () => {
    const url = new URL(
      "https://partner.shopeemobile.com/api/v2/shop/get_shop_info?partner_id=1&access_token=t&sign=s&shop_id=2",
    );
    expect(redactUrl(url)).toBe(
      `/api/v2/shop/get_shop_info?partner_id=1&access_token=${encodeURIComponent(REDACTED)}&sign=${encodeURIComponent(REDACTED)}&shop_id=2`,
    );
  });

  it("truncates large summaries", () => {
    const big = { items: Array.from({ length: 2000 }, (_, i) => ({ i })) };
    expect(summarize(big, 100)).toMatchObject({ truncated: true });
  });
});

describe("signatureEquals", () => {
  it("compares hex case-insensitively and rejects missing or different values", () => {
    expect(signatureEquals("abc123", "ABC123")).toBe(true);
    expect(signatureEquals("abc123", "abc124")).toBe(false);
    expect(signatureEquals("abc123", undefined)).toBe(false);
    expect(signatureEquals("abc123", "abc")).toBe(false);
  });
});

describe("requestJson", () => {
  const url = new URL("https://example.test/x?access_token=secret");

  it("records a redacted call and returns the JSON", async () => {
    const records: CallRecord[] = [];
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: 1, request_id: "rq" }), { status: 200 })) as typeof fetch;
    const res = await requestJson(
      { fetch: fetchImpl, observer: (r) => records.push(r) },
      { method: "POST", url, body: '{"code":"c"}', logBody: { code: "c" } },
      (j) => (j as { request_id?: string }).request_id,
    );
    expect(res.json).toEqual({ ok: 1, request_id: "rq" });
    expect(records[0]).toMatchObject({ method: "POST", httpStatus: 200, requestId: "rq", request: { code: REDACTED } });
    expect(records[0]?.path).not.toContain("secret");
  });

  it("turns network failures and non-JSON 5xx into transient errors, other non-JSON into permanent", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(requestJson({ fetch: down }, { method: "GET", url }, () => undefined)).rejects.toBeInstanceOf(
      TransientConnectorError,
    );
    const gateway = (async () => new Response("<html>502</html>", { status: 502 })) as typeof fetch;
    await expect(requestJson({ fetch: gateway }, { method: "GET", url }, () => undefined)).rejects.toBeInstanceOf(
      TransientConnectorError,
    );
    const html = (async () => new Response("<html>login</html>", { status: 200 })) as typeof fetch;
    await expect(requestJson({ fetch: html }, { method: "GET", url }, () => undefined)).rejects.toBeInstanceOf(
      PermanentConnectorError,
    );
  });

  it("reads Retry-After as seconds or a date", () => {
    expect(retryAfter(new Headers({ "retry-after": "5" }))).toEqual({ retryAfterMs: 5000 });
    expect(retryAfter(new Headers())).toEqual({});
  });
});

describe("requestFile", () => {
  const url = new URL("https://files.example.test/label.pdf?sign=s");
  const serve = (res: Response) => (async () => res) as unknown as typeof fetch;

  it("returns the file and records only its size and type", async () => {
    const records: CallRecord[] = [];
    const bytes = new TextEncoder().encode("%PDF-1.4\nDewi, Jl. Mawar 1");
    const res = await requestFile(
      {
        fetch: serve(new Response(bytes, { headers: { "content-type": "application/pdf" } })),
        observer: (r) => records.push(r),
      },
      { method: "GET", url },
      () => undefined,
    );
    expect(isPdf(res.bytes!)).toBe(true);
    expect(records[0]!.response).toEqual({ bytes: bytes.length, contentType: "application/pdf" });
    expect(JSON.stringify(records)).not.toContain("Mawar");
  });

  it("hands back a JSON error envelope, and treats 5xx without one as temporary", async () => {
    const json = await requestFile(
      { fetch: serve(new Response(JSON.stringify({ error: "logistics.error_param" }), { status: 200 })) },
      { method: "POST", url, body: "{}" },
      () => undefined,
    );
    expect(json).toMatchObject({ json: { error: "logistics.error_param" } });
    expect(json.bytes).toBeUndefined();
    await expect(
      requestFile({ fetch: serve(new Response("oops", { status: 503 })) }, { method: "GET", url }, () => undefined),
    ).rejects.toBeInstanceOf(TransientConnectorError);
    await expect(
      requestFile({ fetch: serve(new Response("gone", { status: 404 })) }, { method: "GET", url }, () => undefined),
    ).rejects.toBeInstanceOf(PermanentConnectorError);
  });
});

describe("parseJsonSafe and toRupiah", () => {
  it("keeps integers beyond 2^53 as exact strings and leaves safe numbers alone", () => {
    expect(parseJsonSafe('{"id":576486316948490012,"n":42,"f":1.5,"s":"x"}')).toEqual({
      id: "576486316948490012",
      n: 42,
      f: 1.5,
      s: "x",
    });
  });

  it("rounds marketplace amounts to whole rupiah and rejects junk", () => {
    expect(toRupiah(65000)).toBe(65000);
    expect(toRupiah("65000.4")).toBe(65000);
    expect(toRupiah("")).toBeNull();
    expect(toRupiah(undefined)).toBeNull();
    expect(toRupiah("abc")).toBeNull();
    expect(toRupiah(-1)).toBeNull();
  });
});

describe("trackingStageOf", () => {
  const ev = (seconds: number, stage: TrackingStage | null) => ({
    at: new Date(seconds * 1000),
    description: "",
    code: null,
    stage,
  });

  it("takes the newest event with a known stage over the marketplace's own status", () => {
    // a failed delivery attempt says more than "picked up", whatever order the events come in
    expect(trackingStageOf([ev(1, "in_transit"), ev(3, null), ev(2, "failed")], "in_transit")).toBe("failed");
    expect(trackingStageOf([ev(1, null)], "delivered")).toBe("delivered");
    expect(trackingStageOf([], null)).toBeNull();
  });
});
