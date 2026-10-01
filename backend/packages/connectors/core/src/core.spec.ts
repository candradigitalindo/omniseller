import { describe, expect, it } from "vitest";
import { signatureEquals } from "./crypto.js";
import { PermanentConnectorError, TransientConnectorError } from "./errors.js";
import { type CallRecord, requestJson, retryAfter } from "./http.js";
import { REDACTED, redactUrl, redactValue, summarize } from "./redact.js";

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
