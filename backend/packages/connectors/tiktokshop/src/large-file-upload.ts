import {
  type CallRecord,
  errorOfKind,
  isConnectorError,
  PermanentConnectorError,
  parseJsonSafe,
} from "@omniseller/connector-core";
import { TiktokShopClient } from "./client.js";
import { assertTiktokRequestScopes } from "./scope-guard.js";

const MIB = 1024 * 1024;
const CHUNK_BYTES = 20 * MIB;
const MIN_CHUNK_BYTES = 5 * MIB;
const MAX_RESPONSE_BYTES = 64 * 1024;
const INIT_PATH = "/open/202512/file/init";

export const TIKTOK_LARGE_VIDEO_UPLOAD_CONTRACT = {
  guideUrl: "https://partner.tiktokshop.com/docv2/page/wfi3nz36",
  guideDocumentId: "694aca8bea754504a0c44bea",
  guideSha256: "eefd5795e41ae913f02d4fc8ea633eb0ba0ba872ae253adab07ef80ffac5e495",
  initReferenceUrl: "https://partner.tiktokshop.com/docv2/page/upload-file-init-202512",
  initMetadataSha256: "2167baeff459198a51ddc28086166da9595051c0e9efed02791c097a5abab681",
  capturedAt: "2026-10-17T04:13:18.315145+00:00",
} as const;
const CHUNK_LOG_PATH = "/file/chunk-upload";

/**
 * Reviewed binding endpoints. The init protocol accepts a business API pattern, never an upload
 * endpoint or an arbitrary caller URL. Actual binding is a separate business operation.
 */
export const TIKTOK_LARGE_VIDEO_TARGETS = [
  {
    operationId: "tiktok_6a1ff121795c140490537a5c",
    method: "POST",
    path: "/customer_service/202606/conversations/{conversation_id}/messages",
    principalKind: "seller",
    binding: "customer_service_content_vid",
    maxBytes: 100 * MIB,
  },
  {
    operationId: "tiktok_69cb362bf76068049e7a08f2",
    method: "POST",
    path: "/affiliate_creator/202603/videos",
    principalKind: "creator",
    // The guide documents creator preparation, but not resource_id → video_info.file_id equivalence.
    binding: "asset_preparation_only",
    maxBytes: 500 * MIB,
  },
] as const;

interface TiktokLargeVideoMetadata {
  accessToken: string;
  shopCipher?: string | null;
  /** Must match the static business endpoint allowlist above. */
  targetOperationId: string;
  filename: string;
  contentType: "video/mp4" | "video/quicktime" | "video/webm";
}

/** Streamed callbacks use half-open bounds and must return exactly the requested bytes. */
export type TiktokLargeVideoInput = TiktokLargeVideoMetadata &
  (
    | { bytes: Uint8Array; size?: undefined; readRange?: undefined }
    | { bytes?: Uint8Array; size: number; readRange: (start: number, endExclusive: number) => Promise<Uint8Array> }
  );

function invalid(code: string, message: string): never {
  throw new PermanentConnectorError({ code, message });
}
function unknown(httpStatus?: number): never {
  throw new PermanentConnectorError({
    code: "write_outcome_unknown",
    message: "The video upload result is unknown; check its outcome before a new submission",
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });
}
function safeErrorCode(code: string): string {
  return /^(?:[0-9]{1,12}|commerce_[a-z_]+|upload_[a-z_]+|write_outcome_unknown|bad_response|missing_scope|scope_contract_unverified)$/.test(
    code,
  )
    ? code
    : "write_outcome_unknown";
}
function object(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
function opaque(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= 8192 &&
    input.trim() === input &&
    !Array.from(input).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  );
}

/** 20 MiB parts; a tail below 5 MiB joins its predecessor, never a separate merge request. */
export function tiktokLargeVideoChunkRanges(size: number): { start: number; end: number }[] {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 500 * MIB)
    invalid("commerce_invalid_file", "Video size is outside the reviewed large-upload limit");
  const chunks: { start: number; end: number }[] = [];
  for (let start = 0; start < size; start += CHUNK_BYTES)
    chunks.push({ start, end: Math.min(start + CHUNK_BYTES, size) });
  const last = chunks.at(-1)!;
  if (chunks.length > 1 && last.end - last.start < MIN_CHUNK_BYTES) {
    chunks[chunks.length - 2]!.end = last.end;
    chunks.pop();
  }
  return chunks;
}

/** Keep routing information, but never trust a different origin, userinfo or redirect destination. */
function uploadUrl(raw: unknown, apiOrigin: string): URL {
  if (!opaque(raw) || raw.includes("#") || /^[a-z]+:\/\/[^/]*@/i.test(raw))
    return invalid("upload_url_rejected", "Invalid large-upload destination");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid("upload_url_rejected", "Invalid large-upload destination");
  }
  if (url.protocol !== "https:" || url.origin !== apiOrigin || url.username || url.password)
    invalid("upload_url_rejected", "Large uploads require the configured HTTPS API origin");
  // Chunk authentication uses its session token, never the JSON OpenAPI signature/secret protocol.
  for (const field of ["app_secret", "access_token", "sign", "timestamp"])
    if (url.searchParams.has(field)) invalid("upload_url_rejected", "Unsupported upload authentication protocol");
  return url;
}

async function responseText(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return unknown(response.status);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return unknown(response.status);
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Official "Large File Uploads" (wfi3nz36), captured 2026-10-17: init, sequential raw PUT parts,
 * then resource_id. Only video is implemented: the guide also lists image/PDF while the current
 * Upload File Init reference explicitly supports video only. No chunk or bind retry is performed.
 * An uncertain response is permanent to prevent a queue from automatically resending the file.
 */
export async function uploadTiktokLargeVideo(client: TiktokShopClient, input: TiktokLargeVideoInput): Promise<string> {
  const target = TIKTOK_LARGE_VIDEO_TARGETS.find((item) => item.operationId === input.targetOperationId);
  if (!target) invalid("commerce_invalid_target", "A reviewed video binding operation is required");
  const size = input.readRange ? input.size : input.bytes?.byteLength;
  if (
    (input.readRange !== undefined && typeof input.readRange !== "function") ||
    (input.readRange === undefined && !(input.bytes instanceof Uint8Array)) ||
    !Number.isSafeInteger(size) ||
    size! <= 10_000_000 ||
    size! > target.maxBytes ||
    !["video/mp4", "video/quicktime", "video/webm"].includes(input.contentType) ||
    !opaque(input.filename) ||
    input.filename.length > 255 ||
    /[/\\]/.test(input.filename) ||
    !opaque(input.accessToken)
  )
    invalid("commerce_invalid_file", "A validated video above the direct-upload limit is required");
  if (target.principalKind === "seller" && !opaque(input.shopCipher))
    invalid("commerce_invalid_credentials", "A seller upload requires its authorized shop identifier");
  let api: URL;
  try {
    api = new URL(client.config.apiBaseUrl);
  } catch {
    return invalid("upload_url_rejected", "Invalid configured API origin");
  }
  if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash)
    invalid("upload_url_rejected", "Large uploads require a configured HTTPS API origin");
  assertTiktokRequestScopes(target.method, target.path);
  const ranges = tiktokLargeVideoChunkRanges(size!);
  const http = client.config.http;
  const doFetch = http?.fetch ?? fetch;
  const safeClient = new TiktokShopClient({
    ...client.config,
    http: {
      ...http,
      fetch: (async (url, init) => {
        const response = await doFetch(url, { ...init, redirect: "manual" });
        if (response.redirected || (response.status >= 300 && response.status < 400))
          invalid("upload_redirect_rejected", "Upload initialization redirects are not supported");
        const text = await responseText(response);
        const envelope = parseJsonSafe(text);
        if (!object(envelope) || !Number.isSafeInteger(envelope.code))
          invalid("bad_response", "Upload initialization omitted its result code");
        return new Response(text, { status: response.status, headers: response.headers });
      }) as typeof fetch,
      observer: (record) =>
        http?.observer?.({
          method: "POST",
          path: INIT_PATH,
          httpStatus: record.httpStatus,
          durationMs: record.durationMs,
          request: { bytes: size!, chunks: ranges.length },
          response: { redacted: true },
        }),
    },
  });
  let session: unknown;
  try {
    session = await safeClient.call({
      method: "POST",
      path: INIT_PATH,
      accessToken: input.accessToken,
      body: {
        file_size: size!,
        file_name: input.filename,
        total_chunk_count: ranges.length,
        file_type: "video",
        target_path: `[${target.method}]${target.path}`,
      },
    });
  } catch (error) {
    if (isConnectorError(error) && error.kind !== "transient")
      throw errorOfKind(error.kind, {
        code: error.code,
        message: "Large video upload initialization was rejected",
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      });
    return unknown();
  }
  if (!object(session) || !opaque(session.upload_token))
    invalid("bad_response", "Upload initialization did not return a valid session");
  const destination = uploadUrl(session.upload_url, api.origin);
  for (const [index, range] of ranges.entries()) {
    const final = index === ranges.length - 1;
    const url = new URL(destination);
    url.searchParams.set("upload_token", session.upload_token);
    url.searchParams.set("chunk_num", String(index + 1));
    url.searchParams.set("app_key", client.appKey);
    if (target.principalKind === "seller") url.searchParams.set("shop_cipher", input.shopCipher!);
    else url.searchParams.delete("shop_cipher");
    const started = performance.now();
    const record: CallRecord = {
      method: "PUT",
      path: CHUNK_LOG_PATH,
      httpStatus: null,
      durationMs: 0,
      request: { chunk: index + 1, chunks: ranges.length, bytes: range.end - range.start },
      response: { completed: false },
    };
    try {
      const chunk = input.readRange
        ? await input.readRange(range.start, range.end)
        : input.bytes!.subarray(range.start, range.end);
      if (!(chunk instanceof Uint8Array) || chunk.byteLength !== range.end - range.start)
        invalid("commerce_file_read_failed", "The private video range did not match its declared size");
      await http?.beforeRequest?.();
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "PUT",
          redirect: "manual",
          headers: {
            "content-type": input.contentType,
            "content-length": String(range.end - range.start),
            "x-tts-access-token": input.accessToken,
          },
          body: chunk as Uint8Array<ArrayBuffer>,
          signal: AbortSignal.timeout(http?.timeoutMs ?? 60_000),
        });
      } catch {
        return unknown();
      }
      record.httpStatus = response.status;
      if (response.redirected || (response.status >= 300 && response.status < 400))
        invalid("upload_redirect_rejected", "Chunk redirects are not supported");
      let envelope: unknown;
      try {
        envelope = parseJsonSafe(await responseText(response));
      } catch {
        return unknown(response.status);
      }
      if (response.status >= 500 || response.status === 429) return unknown(response.status);
      if (!object(envelope) || !Number.isSafeInteger(envelope.code)) return unknown(response.status);
      if (envelope.code !== 0) invalid(String(envelope.code), "The marketplace rejected the video chunk");
      if (!response.ok) return unknown(response.status);
      if (!object(envelope.data)) return unknown(response.status);
      if (final) {
        if (!opaque(envelope.data.resource_id)) return unknown(response.status);
        record.response = { completed: true };
        return envelope.data.resource_id;
      }
      if (!opaque(envelope.data.part_id) || envelope.data.resource_id !== undefined) return unknown(response.status);
    } catch (error) {
      record.errorCode = isConnectorError(error) ? safeErrorCode(error.code) : "write_outcome_unknown";
      if (isConnectorError(error) && error.kind === "permanent")
        throw new PermanentConnectorError({
          code: safeErrorCode(error.code),
          message: "Large video upload did not complete; no automatic retry was made",
          ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
        });
      return unknown(record.httpStatus ?? undefined);
    } finally {
      record.durationMs = Math.round(performance.now() - started);
      http?.observer?.(record);
    }
  }
  return unknown();
}
