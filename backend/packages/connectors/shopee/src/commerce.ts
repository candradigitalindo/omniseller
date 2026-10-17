import {
  type CommerceCredentials,
  type CommerceExecutionResult,
  type CommerceInput,
  type CommerceValue,
  errorOfKind,
  isConnectorError,
  isPdf,
  type MarketplaceCommerce,
  PermanentConnectorError,
  safeCommerceResult,
  validateCommerceInput,
} from "@omniseller/connector-core";
import { ShopeeClient, type ShopeeEnvelope } from "./client.js";
import { validateShopeeCommerceConstraints } from "./commerce-constraints.js";
import type { ShopeeCommerceContract } from "./commerce-contracts.js";
import {
  SHOPEE_COMMERCE_AUXILIARY_CONTRACTS,
  SHOPEE_COMMERCE_CONTRACTS,
  SHOPEE_COMMERCE_OPERATIONS,
} from "./commerce-contracts.js";
import { commerceDownloadFetch } from "./commerce-download.js";
import {
  shopeeStreamCredentials,
  uploadShopeeCommerceImage,
  uploadShopeeCreatorVideo,
  uploadShopeeProductVideo,
} from "./commerce-media.js";
import { numericId, shopeeId } from "./identifiers.js";

const bad = (code = "commerce_bad_response", message = "Shopee belum mengonfirmasi hasil operasi."): never => {
  throw new PermanentConnectorError({ code, message });
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const forbiddenResponse =
  /(?:token|secret|cipher|password|authorization|buyer|customer|recipient|address|phone|email|mobile|identity|tracking_number|shipping_label|download_url|file_link|stream_url(?!_list)|push_key|push_url|play_url|user_name|username)/i;

/** Input IDs remain strings until the signed transport emits Shopee's required exact JSON numbers. */
function wire(value: CommerceValue, path: string, numeric: Set<string>): unknown {
  if (numeric.has(path)) {
    if (typeof value !== "string") return bad("commerce_invalid_input", "ID Shopee harus berupa teks desimal.");
    return numericId(value);
  }
  if (Array.isArray(value)) return value.map((entry) => wire(entry, `${path}[]`, numeric));
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, wire(entry as CommerceValue, `${path}.${key}`, numeric)]),
    );
  return value;
}

/** Source-schema whitelist applies recursively; unknown fields and personal data are never retained. */
function publicData(value: unknown, fields: Set<string>, depth = 0): unknown {
  if (depth > 10) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => publicData(entry, fields, depth + 1));
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => fields.has(key) && !forbiddenResponse.test(key))
      .map(([key, entry]) => [key, publicData(entry, fields, depth + 1)]),
  );
}

function rejected(value: unknown, depth = 0): boolean {
  if (depth > 10) return false;
  // Ads keyword edits return an array at response root; failures there have the same
  // documented meaning as lists nested inside an ordinary response object.
  if (Array.isArray(value)) return value.some((entry) => rejected(entry, depth + 1));
  if (!object(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (
      /^(?:failure_list|fail_list|failed_items|failed_list|error_list|failed_edits|fail_affiliate_list|fail_item_list)$/.test(
        key,
      )
    ) {
      if (!Array.isArray(entry)) return true;
      if (entry.length > 0) return true;
    }
    if (
      /^(?:error|fail_error|err_code|error_code)$/.test(key) &&
      entry !== "" &&
      entry !== "-" &&
      entry !== 0 &&
      entry !== "0" &&
      entry != null
    )
      return true;
    if (key === "success" && entry === false) return true;
    if (key === "is_success" && entry !== true) return true;
    if (/^(?:fail_post_id|fail_video_upload_id)$/.test(key) && entry !== "" && entry != null) return true;
    if (/^(?:fail_reason|failed_reason)$/.test(key) && typeof entry === "string" && entry.trim() && entry !== "-")
      return true;
    if (object(entry) && rejected(entry, depth + 1)) return true;
    if (Array.isArray(entry) && entry.some((row) => rejected(row, depth + 1))) return true;
  }
  return false;
}

function valueAt(response: unknown, path: string[]): unknown {
  let value = response;
  for (const key of path) value = object(value) ? value[key] : undefined;
  return value;
}

function nextCursor(response: unknown, input: CommerceInput, contract: ShopeeCommerceContract): string | null {
  if (!contract.pagination) return null;
  const { cursorPath, morePath, numeric } = contract.pagination;
  if (morePath) {
    const more = valueAt(response, morePath);
    if (typeof more !== "boolean") return bad();
    if (!more) return null;
  }
  let value = valueAt(response, cursorPath);
  if (numeric) {
    value = shopeeId(value);
    if (value === null) return bad();
    if (value === "0") return morePath ? bad() : null;
  }
  if (morePath && (value === undefined || value === null || value === "")) return bad();
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 8192) return bad();
  if (value === input.query?.cursor || value === input.body?.cursor)
    return bad("commerce_bad_response", "Shopee mengembalikan kursor halaman yang sama.");
  return value;
}

export function shopeeCommerce(client: ShopeeClient): MarketplaceCommerce {
  return {
    operations: SHOPEE_COMMERCE_OPERATIONS,
    async execute(
      credentials: CommerceCredentials,
      operationId: string,
      input: CommerceInput,
    ): Promise<CommerceExecutionResult> {
      const contract = [...SHOPEE_COMMERCE_CONTRACTS, ...SHOPEE_COMMERCE_AUXILIARY_CONTRACTS].find(
        (entry) => entry.operation.id === operationId,
      );
      if (!contract?.operation.available)
        return bad("commerce_unavailable", contract?.operation.unavailableReason ?? "Operasi Shopee belum tersedia.");
      const operation = contract.operation;
      const externalId =
        operation.principalKind === "seller" ? credentials.externalShopId : credentials.externalAccountId;
      if (!externalId || shopeeId(externalId) === null || !credentials.accessToken)
        return bad("commerce_principal_required", "Hubungkan akun Shopee terlebih dahulu.");
      if (operation.method !== "GET" && operation.method !== "POST") return bad("commerce_unavailable");
      validateCommerceInput(operation, input);
      validateShopeeCommerceConstraints(operation.id, input);
      const numeric = new Set(contract.numericIds);
      const query: Record<string, string | readonly string[]> = {};
      for (const [key, value] of Object.entries(input.query ?? {})) {
        if (value === null) continue;
        if (Array.isArray(value) && contract.queryArrays?.[key]) {
          const mode = contract.queryArrays[key];
          const exact = value.map((entry) => {
            if (!["string", "number", "boolean"].includes(typeof entry)) return bad("commerce_invalid_input");
            if (!numeric.has(`query.${key}[]`)) return String(entry);
            const id = shopeeId(entry);
            return id === null ? bad("commerce_invalid_input") : id;
          });
          query[key] =
            mode === "repeat"
              ? exact
              : mode === "comma"
                ? exact.join(",")
                : JSON.stringify(exact.map((entry) => (numeric.has(`query.${key}[]`) ? numericId(entry) : entry)));
        } else if (["string", "number", "boolean"].includes(typeof value)) {
          if (numeric.has(`query.${key}`)) {
            const id = shopeeId(value);
            if (id === null) return bad("commerce_invalid_input", "ID Shopee tidak valid.");
            query[key] = id;
          } else query[key] = String(value);
        } else return bad("commerce_invalid_input", "Query Shopee tidak mendukung bentuk parameter ini.");
      }
      // Marketplace notes, search text and other arbitrary strings can contain personal data even
      // under innocuous keys. Only operation metadata reaches the shared HTTP observer.
      const safeClient = new ShopeeClient({
        ...client.config,
        http: {
          ...client.config.http,
          ...(operation.transport === "private_download" && operation.id !== "shopee.livestream.get_stream_credentials"
            ? { fetch: commerceDownloadFetch(client.config.apiBaseUrl, client.config.http) }
            : {}),
          observer(record) {
            client.config.http?.observer?.({
              method: record.method,
              path: operation.path,
              httpStatus: record.httpStatus,
              durationMs: record.durationMs,
              request: { operationId },
              response: { redacted: true },
            });
          },
        },
      });
      let result: Record<string, unknown> & ShopeeEnvelope;
      try {
        if (operation.id === "shopee.livestream.get_stream_credentials")
          return await shopeeStreamCredentials(safeClient, credentials, query);
        if (operation.id === "shopee.media_space.init_video_upload")
          return await uploadShopeeProductVideo(safeClient, credentials, input);
        if (operation.id === "shopee.media.init_video_upload" && operation.transport === "large_upload")
          return await uploadShopeeCreatorVideo(safeClient, credentials, input);
        if (operation.transport === "multipart") {
          result = await uploadShopeeCommerceImage(
            safeClient,
            credentials,
            input,
            operation.path,
            contract.auth === "user" ? "user" : "public",
          );
        } else {
          if (operation.transport === "private_download") {
            const bytes = await safeClient.shopFile(
              { externalShopId: externalId, accessToken: credentials.accessToken },
              operation.method,
              operation.path,
              {
                ...(Object.keys(query).length ? { query } : {}),
                ...(operation.method === "POST" ? { body: wire(input.body ?? {}, "body", numeric) as object } : {}),
              },
            );
            if (bytes.length > 20 * 1024 * 1024)
              return bad("commerce_file_too_large", "Dokumen Shopee melebihi batas ukuran.");
            if (!isPdf(bytes) || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-")
              return bad("commerce_file_type", "Shopee belum menyediakan dokumen PDF yang valid.");
            return {
              data: { sizeBytes: bytes.length, mime: "application/pdf" },
              nextCursor: null,
              acknowledgement: "read",
              download: { bytes, mime: "application/pdf", ext: "pdf" },
            };
          }
          const options = {
            ...(Object.keys(query).length ? { query } : {}),
            ...(operation.method === "POST" ? { body: wire(input.body ?? {}, "body", numeric) as object } : {}),
          };
          result =
            contract.auth === "public"
              ? await safeClient.publicCall(operation.method, operation.path, options)
              : contract.auth === "user"
                ? await safeClient.userCall(
                    { externalAccountId: externalId, accessToken: credentials.accessToken },
                    operation.method,
                    operation.path,
                    options,
                  )
                : await safeClient.shopCall(
                    { externalShopId: externalId, accessToken: credentials.accessToken },
                    operation.method,
                    operation.path,
                    options,
                  );
        }
      } catch (error) {
        if (isConnectorError(error))
          throw errorOfKind(error.kind, {
            code: /^[a-z][a-z0-9_.-]{0,95}$/i.test(error.code) ? error.code : "commerce_external_error",
            message: "Operasi Shopee tidak dapat diselesaikan. Periksa izin dan hasil di Seller Center.",
            ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
            ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
          });
        return bad("commerce_transport_error", "Koneksi Shopee tidak dapat diselesaikan.");
      }
      // A successful transport alone is insufficient. A write requires an explicit successful Shopee
      // envelope and request ID; partial item failures must never become an overall success.
      if (
        operation.write &&
        (typeof result.error !== "string" ||
          !["", "-"].includes(result.error.trim()) ||
          typeof result.request_id !== "string" ||
          !result.request_id.trim())
      )
        return bad();
      let response = operation.responseFields?.includes("response") ? result.response : result;
      if (operation.id === "shopee.payment.get_payment_method_list") {
        if (!Array.isArray(response)) return bad();
        response = response.filter((entry) => object(entry) && entry.region === "ID");
      }
      if (!object(response) && !Array.isArray(response)) return bad();
      if (operation.write && rejected(response))
        return bad(
          "commerce_partial_failure",
          "Shopee menolak sebagian atau seluruh perubahan. Periksa hasil di Seller Center sebelum mengulang.",
        );
      const allowed = new Set(
        (operation.responseFields ?? []).filter((key) => !["error", "message", "request_id", "warning"].includes(key)),
      );
      if (!operation.write && response === result && !Object.keys(result).some((key) => allowed.has(key))) return bad();
      const data = safeCommerceResult(publicData(response, allowed));
      return {
        data,
        nextCursor: nextCursor(response, input, contract),
        acknowledgement: operation.write ? "accepted" : "read",
      };
    },
  };
}
