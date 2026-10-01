import { PermanentConnectorError, TransientConnectorError } from "./errors.js";
import { redactUrl, summarize } from "./redact.js";

/** One HTTP call made by a connector, already redacted; the backend stores it in the sync log. */
export interface CallRecord {
  method: string;
  path: string;
  httpStatus: number | null;
  durationMs: number;
  requestId?: string;
  request?: unknown;
  response?: unknown;
  errorCode?: string;
}

export type CallObserver = (record: CallRecord) => void;

export interface HttpConfig {
  fetch?: typeof fetch;
  timeoutMs?: number;
  observer?: CallObserver;
  /** Awaited before every request: the backend's per-shop rate limit (token bucket). */
  beforeRequest?: () => Promise<void>;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: URL;
  headers?: Record<string, string>;
  /** Exact body bytes to send: some marketplaces sign the body string, so it is serialized once by the caller. */
  body?: string;
  /** Parsed request body for the call record (redacted before it is stored). */
  logBody?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  json: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * JSON over HTTP with a timeout. Network failures and non-JSON 5xx answers become transient errors;
 * everything else is returned for the connector to classify with the marketplace's own error codes.
 */
export async function requestJson(
  config: HttpConfig,
  req: HttpRequest,
  requestIdOf: (json: unknown) => string | undefined,
): Promise<HttpResponse> {
  const doFetch = config.fetch ?? fetch;
  await config.beforeRequest?.();
  const started = performance.now();
  const record: CallRecord = {
    method: req.method,
    path: redactUrl(req.url),
    httpStatus: null,
    durationMs: 0,
    ...(req.logBody === undefined ? {} : { request: summarize(req.logBody) }),
  };
  try {
    let res: Response;
    try {
      res = await doFetch(req.url, {
        method: req.method,
        headers: { accept: "application/json", ...req.headers },
        ...(req.body === undefined ? {} : { body: req.body }),
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      record.errorCode = "network";
      throw new TransientConnectorError({ code: "network", message: (err as Error).message });
    }
    record.httpStatus = res.status;
    const text = await res.text();
    let json: unknown;
    try {
      json = text.length ? parseJsonSafe(text) : {};
    } catch {
      record.errorCode = `http_${res.status}`;
      record.response = { body: text.slice(0, 500) };
      if (res.status >= 500 || res.status === 429) {
        throw new TransientConnectorError({
          code: `http_${res.status}`,
          message: "non-JSON response",
          httpStatus: res.status,
          ...retryAfter(res.headers),
        });
      }
      throw new PermanentConnectorError({
        code: "bad_response",
        message: `non-JSON response with HTTP ${res.status}`,
        httpStatus: res.status,
      });
    }
    const requestId = requestIdOf(json);
    if (requestId) record.requestId = requestId;
    record.response = summarize(json);
    return { status: res.status, headers: res.headers, json };
  } finally {
    record.durationMs = Math.round(performance.now() - started);
    config.observer?.(record);
  }
}

/**
 * JSON.parse that keeps integers beyond 2^53 as strings: TikTok Shop sends 19-digit ids as numbers in
 * some payloads, and a plain parse would silently change them (uses JSON.parse source text access).
 */
export function parseJsonSafe(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)
      ? context.source
      : value,
  );
}

/** Whole rupiah from a marketplace amount (number or decimal string); null when absent or invalid. */
export function toRupiah(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** `Retry-After` in seconds or as an HTTP date. */
export function retryAfter(headers: Headers): { retryAfterMs?: number } {
  const v = headers.get("retry-after");
  if (!v) return {};
  const seconds = Number(v);
  if (Number.isFinite(seconds)) return { retryAfterMs: Math.max(0, seconds * 1000) };
  const at = Date.parse(v);
  return Number.isFinite(at) ? { retryAfterMs: Math.max(0, at - Date.now()) } : {};
}

export function unixSeconds(date = new Date()): number {
  return Math.floor(date.getTime() / 1000);
}
