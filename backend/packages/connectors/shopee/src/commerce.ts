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
import type { ShopeeCommerceContract } from "./commerce-contracts.js";
import { SHOPEE_COMMERCE_CONTRACTS, SHOPEE_COMMERCE_OPERATIONS } from "./commerce-contracts.js";
import { commerceDownloadFetch } from "./commerce-download.js";
import { numericId, shopeeId } from "./identifiers.js";

const bad = (code = "commerce_bad_response", message = "Shopee belum mengonfirmasi hasil operasi."): never => {
  throw new PermanentConnectorError({ code, message });
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const forbiddenResponse =
  /(?:token|secret|cipher|password|authorization|buyer|customer|recipient|address|phone|email|mobile|identity|tracking_number|shipping_label|download_url|user_name|username)/i;

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
  if (depth > 10 || !object(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:failure_list|fail_list|failed_items|failed_list|error_list)$/.test(key)) {
      if (!Array.isArray(entry)) return true;
      if (entry.length > 0) return true;
    }
    if (
      /^(?:fail_error|err_code|error_code)$/.test(key) &&
      entry !== "" &&
      entry !== "-" &&
      entry !== 0 &&
      entry !== "0" &&
      entry != null
    )
      return true;
    if (key === "success" && entry === false) return true;
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
  const { cursorPath, morePath } = contract.pagination;
  if (morePath) {
    const more = valueAt(response, morePath);
    if (typeof more !== "boolean") return bad();
    if (!more) return null;
  }
  const value = valueAt(response, cursorPath);
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
      const contract = SHOPEE_COMMERCE_CONTRACTS.find((entry) => entry.operation.id === operationId);
      if (!contract?.operation.available || contract.operation.principalKind !== "seller")
        return bad("commerce_unavailable", contract?.operation.unavailableReason ?? "Operasi Shopee belum tersedia.");
      if (!credentials.externalShopId || shopeeId(credentials.externalShopId) === null || !credentials.accessToken)
        return bad("commerce_principal_required", "Hubungkan toko Shopee terlebih dahulu.");
      const operation = contract.operation;
      if (operation.method !== "GET" && operation.method !== "POST") return bad("commerce_unavailable");
      validateCommerceInput(operation, input);
      const numeric = new Set(contract.numericIds);
      const query: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.query ?? {})) {
        if (value === null) continue;
        if (["string", "number", "boolean"].includes(typeof value)) {
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
          ...(operation.transport === "private_download"
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
        if (operation.transport === "private_download") {
          const bytes = await safeClient.shopFile(
            { externalShopId: credentials.externalShopId, accessToken: credentials.accessToken },
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
        result = await safeClient.shopCall<Record<string, unknown> & ShopeeEnvelope>(
          { externalShopId: credentials.externalShopId, accessToken: credentials.accessToken },
          operation.method,
          operation.path,
          {
            ...(Object.keys(query).length ? { query } : {}),
            ...(operation.method === "POST" ? { body: wire(input.body ?? {}, "body", numeric) as object } : {}),
          },
        );
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
      const response = operation.responseFields?.includes("response") ? result.response : result;
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
