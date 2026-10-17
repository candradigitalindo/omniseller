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
  /** Optional stricter response ceiling; cannot raise the JSON (32 MiB) or file (25 MiB) hard limit. */
  maxResponseBytes?: number;
  observer?: CallObserver;
  /** Awaited before every request: the backend's per-shop rate limit (token bucket). */
  beforeRequest?: () => Promise<void>;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: URL;
  headers?: Record<string, string>;
  /**
   * Exact body bytes to send: some marketplaces sign the body string, so it is serialized once by the
   * caller. A FormData body goes as multipart/form-data (fetch sets the boundary; do not set a
   * content-type header for it).
   */
  body?: string | FormData;
  /** Parsed request body for the call record (redacted before it is stored). */
  logBody?: unknown;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  json: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;
// A reviewed 20 MiB base64 download fits within the JSON ceiling, including its envelope.
const MAX_JSON_BYTES = 32 * 1024 * 1024;
/** Largest file a connector downloads (a label batch of 50 parcels is well below 5 MB). */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function responseLimit(config: HttpConfig, ceiling: number): number {
  const requested = config.maxResponseBytes ?? ceiling;
  if (!Number.isSafeInteger(requested) || requested <= 0)
    throw new RangeError("maxResponseBytes must be a positive safe integer");
  return Math.min(requested, ceiling);
}

/** Bound decoded bytes while consuming the stream, including chunked/decompressed responses. */
async function readResponse(
  res: Response,
  limit: number,
  code: "response_too_large" | "file_too_large",
  record: CallRecord,
): Promise<Uint8Array> {
  const oversized = (bytes: number): never => {
    record.response = { bytes, maxBytes: limit };
    if (res.status >= 500 || res.status === 429) {
      record.errorCode = `http_${res.status}`;
      throw new TransientConnectorError({
        code: `http_${res.status}`,
        message: "response exceeds download limit",
        httpStatus: res.status,
        ...retryAfter(res.headers),
      });
    }
    record.errorCode = code;
    throw new PermanentConnectorError({ code, message: "response exceeds download limit", httpStatus: res.status });
  };
  const length = res.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    // Cancellation is initiated immediately; a remote cancellation acknowledgement must not delay rejection.
    void res.body?.cancel().catch(() => undefined);
    oversized(Number(length));
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  let bytes = new Uint8Array(Math.min(limit, 64 * 1024));
  let size = 0;
  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        record.errorCode = "network";
        throw new TransientConnectorError({
          code: "network",
          message: "response body interrupted",
          httpStatus: res.status,
        });
      }
      if (chunk.done) return bytes.subarray(0, size);
      const required = size + chunk.value.byteLength;
      if (required > limit) {
        void reader.cancel().catch(() => undefined);
        oversized(required);
      }
      // One growing buffer bounds memory independently of how many tiny chunks a server sends.
      if (required > bytes.byteLength) {
        const expanded = new Uint8Array(Math.min(limit, Math.max(required, bytes.byteLength * 2)));
        expanded.set(bytes);
        bytes = expanded;
      }
      bytes.set(chunk.value, size);
      size = required;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * JSON over HTTP with a timeout. Network failures and non-JSON 5xx answers become transient errors;
 * everything else is returned for the connector to classify with the marketplace's own error codes.
 */
export async function requestJson(
  config: HttpConfig,
  req: HttpRequest,
  requestIdOf: (json: unknown) => string | undefined,
): Promise<HttpResponse> {
  const limit = responseLimit(config, MAX_JSON_BYTES);
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
    const text = new TextDecoder().decode(await readResponse(res, limit, "response_too_large", record));
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

export interface FileResponse {
  status: number;
  headers: Headers;
  /** The file, when the server sent one. */
  bytes?: Uint8Array;
  /** The JSON body, when the server answered with one instead (an error envelope). */
  json?: unknown;
}

/**
 * A file download (shipping labels). A JSON answer means the marketplace sent an error envelope
 * instead of the file; it is returned for the connector to classify. Only the size and type of the
 * file reach the call record: labels carry buyer names and addresses.
 */
export async function requestFile(
  config: HttpConfig,
  req: HttpRequest,
  requestIdOf: (json: unknown) => string | undefined,
): Promise<FileResponse> {
  const limit = responseLimit(config, MAX_FILE_BYTES);
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
        headers: { accept: "application/pdf, application/octet-stream, application/json", ...req.headers },
        ...(req.body === undefined ? {} : { body: req.body }),
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS * 2),
      });
    } catch (err) {
      record.errorCode = "network";
      throw new TransientConnectorError({ code: "network", message: (err as Error).message });
    }
    record.httpStatus = res.status;
    const bytes = await readResponse(res, limit, "file_too_large", record);
    const type = res.headers.get("content-type") ?? "";
    const looksJson = type.includes("json") || (bytes.length > 0 && bytes[0] === 0x7b);
    if (looksJson) {
      let json: unknown;
      try {
        json = parseJsonSafe(new TextDecoder().decode(bytes));
      } catch {
        json = undefined;
      }
      if (json !== undefined) {
        const requestId = requestIdOf(json);
        if (requestId) record.requestId = requestId;
        record.response = summarize(json);
        return { status: res.status, headers: res.headers, json };
      }
    }
    record.response = { bytes: bytes.length, contentType: type || null };
    if (res.status >= 500 || res.status === 429) {
      record.errorCode = `http_${res.status}`;
      throw new TransientConnectorError({
        code: `http_${res.status}`,
        message: "file download failed",
        httpStatus: res.status,
        ...retryAfter(res.headers),
      });
    }
    if (res.status >= 400) {
      record.errorCode = `http_${res.status}`;
      throw new PermanentConnectorError({
        code: `http_${res.status}`,
        message: `file download failed with HTTP ${res.status}`,
        httpStatus: res.status,
      });
    }
    return { status: res.status, headers: res.headers, bytes };
  } finally {
    record.durationMs = Math.round(performance.now() - started);
    config.observer?.(record);
  }
}

/** A PDF file starts with "%PDF-". */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
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

/**
 * A multipart body with one file, and what the call record keeps of it: the field names, the file's
 * size and type, never its bytes.
 */
export function fileForm(
  file: { field: string; bytes: Uint8Array; contentType: string; filename: string },
  fields: Record<string, string> = {},
): { body: FormData; logBody: Record<string, unknown> } {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  body.append(file.field, new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.contentType }), file.filename);
  return { body, logBody: { ...fields, [file.field]: { bytes: file.bytes.length, contentType: file.contentType } } };
}
