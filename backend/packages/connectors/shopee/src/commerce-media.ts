import { createHash } from "node:crypto";
import {
  type CommerceCredentials,
  type CommerceExecutionResult,
  type CommerceInput,
  fileForm,
  PermanentConnectorError,
} from "@omniseller/connector-core";
import type { ShopeeClient, ShopeeEnvelope } from "./client.js";

const PART_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;
const bad = (code = "commerce_bad_response"): never => {
  throw new PermanentConnectorError({ code, message: "Shopee belum mengonfirmasi unggahan media." });
};
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

/** A multipart HTTP success without a positive Shopee acknowledgement must not advance an upload. */
export function acknowledgedMedia(value: ShopeeEnvelope): void {
  if (
    typeof value.error !== "string" ||
    !["", "-"].includes(value.error.trim()) ||
    typeof value.request_id !== "string" ||
    !value.request_id.trim()
  )
    bad();
}

/** MediaSpace is product media. It is distinct from the public Media workflow used by Shopee Video. */
export async function uploadShopeeProductVideo(
  client: ShopeeClient,
  credentials: CommerceCredentials,
  input: CommerceInput,
): Promise<CommerceExecutionResult> {
  const id = input.body?.file;
  const file = typeof id === "string" ? credentials.files?.[id] : undefined;
  const bytes = file?.bytes;
  if (
    !credentials.externalShopId ||
    file?.mime !== "video/mp4" ||
    !bytes?.length ||
    bytes.length > MAX_VIDEO_BYTES ||
    new TextDecoder().decode(bytes.subarray(4, 8)) !== "ftyp"
  )
    return bad("commerce_invalid_file");
  const shop = { externalShopId: credentials.externalShopId, accessToken: credentials.accessToken };
  const initialized = await client.shopCall<{ response?: { video_upload_id?: string } }>(
    shop,
    "POST",
    "/api/v2/media_space/init_video_upload",
    { body: { file_md5: md5(bytes), file_size: bytes.length } },
  );
  acknowledgedMedia(initialized);
  const uploadId = initialized.response?.video_upload_id;
  if (typeof uploadId !== "string" || !uploadId.trim() || uploadId.length > 1024) return bad();
  const sequences: number[] = [];
  const started = performance.now();
  for (let offset = 0; offset < bytes.length; offset += PART_BYTES) {
    const part = bytes.subarray(offset, Math.min(offset + PART_BYTES, bytes.length));
    const sequence = sequences.length;
    const reply = await client.publicUpload(
      "/api/v2/media_space/upload_video_part",
      fileForm(
        { field: "part_content", bytes: part, contentType: "video/mp4", filename: "commerce.mp4" },
        { video_upload_id: uploadId, part_seq: String(sequence), content_md5: md5(part) },
      ),
    );
    acknowledgedMedia(reply);
    sequences.push(sequence);
  }
  const completed = await client.publicCall("POST", "/api/v2/media_space/complete_video_upload", {
    body: {
      video_upload_id: uploadId,
      part_seq_list: sequences,
      report_data: { upload_cost: Math.max(0, Math.round(performance.now() - started)) },
    },
  });
  acknowledgedMedia(completed);
  // Transcoding is asynchronous. Its result has a separate reviewed read operation; never publish
  // a product or automatically resend this write on an uncertain HTTP outcome.
  return {
    data: { video_upload_id: uploadId, processing_pending: true },
    nextCursor: null,
    acknowledgement: "accepted",
  };
}

/** Exactly one private image per request; callers may run another explicit request for another. */
export async function uploadShopeeCommerceImage(
  client: ShopeeClient,
  credentials: CommerceCredentials,
  input: CommerceInput,
  path: string,
  auth: "public" | "user",
): Promise<Record<string, unknown> & ShopeeEnvelope> {
  const imageField = path === "/api/v2/media/upload_image" ? "images" : "image";
  const id = input.body?.[imageField];
  const file = typeof id === "string" ? credentials.files?.[id] : undefined;
  if (
    !file ||
    !["image/jpeg", "image/png"].includes(file.mime) ||
    !file.bytes.length ||
    file.bytes.length > 10 * 1024 * 1024
  )
    return bad("commerce_invalid_file");
  const fields: Record<string, string> = path === "/api/v2/media/upload_image" ? { business: "2", scene: "1" } : {};
  for (const [key, value] of Object.entries(input.body ?? {})) {
    if (key === imageField) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      return bad("commerce_invalid_input");
    fields[key] = String(value);
  }
  const form = fileForm(
    {
      field: imageField,
      bytes: file.bytes,
      contentType: file.mime,
      filename: file.mime === "image/png" ? "commerce.png" : "commerce.jpg",
    },
    fields,
  );
  const result =
    auth === "public"
      ? await client.publicUpload<Record<string, unknown>>(path, form)
      : credentials.externalAccountId
        ? await client.userUpload<Record<string, unknown>>(
            { externalAccountId: credentials.externalAccountId, accessToken: credentials.accessToken },
            path,
            form,
          )
        : bad("commerce_principal_required");
  acknowledgedMedia(result);
  const response = result.response;
  if (!response || typeof response !== "object" || Array.isArray(response)) return bad();
  const data = response as Record<string, unknown>;
  const imageId = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const id = (value as Record<string, unknown>).image_id;
    return typeof id === "string" && !!id.trim() && id !== "-" && id.length <= 8192;
  };
  if (path === "/api/v2/media_space/upload_image") {
    if (data.image_info_list !== undefined) {
      if (!Array.isArray(data.image_info_list) || data.image_info_list.length !== 1) return bad();
      const entry = data.image_info_list[0] as Record<string, unknown> | undefined;
      if (
        !entry ||
        typeof entry.error !== "string" ||
        !["", "-"].includes(entry.error.trim()) ||
        !imageId(entry.image_info)
      )
        return bad("commerce_partial_failure");
    } else if (!imageId(data.image_info)) return bad();
  } else if (path === "/api/v2/media/upload_image") {
    if (!Array.isArray(data.image_list) || data.image_list.length !== 1 || !imageId(data.image_list[0])) return bad();
  } else if (
    typeof data.image_url !== "string" ||
    !data.image_url.startsWith("https://") ||
    data.image_url.length > 8192
  )
    return bad();
  return result;
}

/** Public Media upload for Shopee Video. The account remains the local permission/ownership bound. */
export async function uploadShopeeCreatorVideo(
  client: ShopeeClient,
  credentials: CommerceCredentials,
  input: CommerceInput,
): Promise<CommerceExecutionResult> {
  const id = input.body?.file;
  const file = typeof id === "string" ? credentials.files?.[id] : undefined;
  const size = file?.size ?? file?.bytes.length ?? 0;
  const duration = input.body?.duration;
  if (
    file?.mime !== "video/mp4" ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > 500 * 1024 * 1024 ||
    typeof duration !== "number" ||
    !Number.isSafeInteger(duration) ||
    duration < 1 ||
    duration > 180
  )
    return bad("commerce_invalid_file");
  const range = async (start: number, end: number) => {
    const bytes = file.readRange ? await file.readRange(start, end) : file.bytes.subarray(start, end);
    if (bytes.length !== end - start) return bad("commerce_invalid_file");
    return bytes;
  };
  const prefix = await range(0, Math.min(size, 16));
  if (new TextDecoder().decode(prefix.subarray(4, 8)) !== "ftyp") return bad("commerce_invalid_file");
  const initialized = await client.publicCall<{ response?: { video_upload_id?: unknown; part_size?: unknown } }>(
    "POST",
    "/api/v2/media/init_video_upload",
    {
      body: { business: 3, scene: 1, file_name: "commerce.mp4", file_size: size, duration },
    },
  );
  acknowledgedMedia(initialized);
  const uploadId = initialized.response?.video_upload_id;
  const partSize = initialized.response?.part_size;
  if (
    typeof uploadId !== "string" ||
    !uploadId.trim() ||
    uploadId.length > 1024 ||
    typeof partSize !== "number" ||
    !Number.isSafeInteger(partSize) ||
    partSize <= 0 ||
    partSize > 30 * 1024 * 1024 ||
    Math.ceil(size / partSize) > 1000
  )
    return bad();
  let sequence = 0;
  for (let offset = 0; offset < size; offset += partSize) {
    const part = await range(offset, Math.min(offset + partSize, size));
    const reply = await client.publicUpload(
      "/api/v2/media/upload_video_part",
      fileForm(
        { field: "part_content", bytes: part, contentType: "video/mp4", filename: "commerce.mp4" },
        { video_upload_id: uploadId, part_seq: String(sequence++), part_md5: md5(part) },
      ),
    );
    acknowledgedMedia(reply);
  }
  const completed = await client.publicCall("POST", "/api/v2/media/complete_video_upload", {
    body: { video_upload_id: uploadId },
  });
  acknowledgedMedia(completed);
  return {
    data: { video_upload_id: uploadId, processing_pending: true },
    nextCursor: null,
    acknowledgement: "accepted",
  };
}

/** OBS credentials are an expiring private artifact, never ordinary JSON request history. */
export async function shopeeStreamCredentials(
  client: ShopeeClient,
  credentials: CommerceCredentials,
  query: Record<string, string | readonly string[]>,
): Promise<CommerceExecutionResult> {
  if (!credentials.externalAccountId) return bad("commerce_principal_required");
  const result = await client.userCall<{ response?: { stream_url_list?: { push_url?: unknown; push_key?: unknown } } }>(
    { externalAccountId: credentials.externalAccountId, accessToken: credentials.accessToken },
    "GET",
    "/api/v2/livestream/get_session_detail",
    { query },
  );
  acknowledgedMedia(result);
  const stream = result.response?.stream_url_list;
  if (
    !stream ||
    typeof stream.push_url !== "string" ||
    typeof stream.push_key !== "string" ||
    !stream.push_key.trim() ||
    stream.push_url.length > 8192 ||
    stream.push_key.length > 8192 ||
    /[\r\n\0]/.test(stream.push_url + stream.push_key)
  )
    return bad();
  let url: URL;
  try {
    url = new URL(stream.push_url);
  } catch {
    return bad();
  }
  if (!["rtmp:", "rtmps:"].includes(url.protocol) || url.username || url.password) return bad();
  const bytes = new TextEncoder().encode(`Server OBS: ${stream.push_url}\nKunci streaming OBS: ${stream.push_key}\n`);
  return {
    data: { sizeBytes: bytes.length, mime: "text/plain" },
    nextCursor: null,
    acknowledgement: "read",
    download: { bytes, mime: "text/plain", ext: "txt" },
  };
}
