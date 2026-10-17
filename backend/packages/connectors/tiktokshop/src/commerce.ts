import {
  type CommerceExecutionResult,
  type CommerceInput,
  type CommerceValue,
  errorOfKind,
  isConnectorError,
  type MarketplaceCommerce,
  PermanentConnectorError,
  safeCommerceResult,
  validateCommerceInput,
} from "@omniseller/connector-core";
import { TiktokShopClient } from "./client.js";
import { TIKTOK_COMMERCE_OPERATIONS as JSON_OPERATIONS } from "./commerce-contracts.js";
import { commerceFileOperation, largeVideoOperations, largeVideoTarget } from "./commerce-file-contracts.js";
import { assertTiktokCommerceOutcome } from "./commerce-outcome.js";
import { uploadTiktokLargeVideo } from "./large-file-upload.js";

export const TIKTOK_COMMERCE_OPERATIONS = [
  ...JSON_OPERATIONS.map(commerceFileOperation),
  ...largeVideoOperations(JSON_OPERATIONS),
];

function queryValue(value: CommerceValue): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
/** Concrete, reviewed methods/paths only. No tenant-controlled destination or credential parameter. */
export function tiktokCommerce(client: TiktokShopClient): MarketplaceCommerce {
  return {
    operations: TIKTOK_COMMERCE_OPERATIONS,
    async execute(credentials, operationId, input: CommerceInput): Promise<CommerceExecutionResult> {
      const operation = TIKTOK_COMMERCE_OPERATIONS.find((item) => item.id === operationId);
      if (!operation?.available)
        throw new PermanentConnectorError({ code: "commerce_unavailable", message: "Operation contract unavailable" });
      validateCommerceInput(operation, input);
      const path = operation.path.replace(/\{([^}]+)\}/g, (_whole, key: string) => {
        const value = input.path?.[key];
        if (typeof value !== "string" || !value || value.length > 200 || /[/\\?#]/.test(value))
          throw new PermanentConnectorError({
            code: "commerce_invalid_input",
            message: "Invalid documented path identifier",
          });
        return encodeURIComponent(value);
      });
      const query = Object.fromEntries(
        Object.entries(input.query ?? {}).map(([key, value]) => [key, queryValue(value)]),
      );
      if (operation.categoryAsset) {
        const assets =
          credentials.categoryAssets?.filter(
            (asset) =>
              asset.market === "ID" &&
              (input.categoryAssetId === undefined || asset.categoryId === input.categoryAssetId),
          ) ?? [];
        if (assets.length !== 1)
          throw new PermanentConnectorError({
            code: "category_asset_selection_required",
            message: "An unambiguous Indonesian category asset is required",
          });
        query.category_asset_cipher = assets[0]!.cipher;
      }
      // Record method/status/timing only: commerce payloads can contain chat or buyer information.
      const http = client.config.http;
      const safeClient = new TiktokShopClient({
        ...client.config,
        http: {
          ...http,
          observer: (record) =>
            http?.observer?.({
              ...record,
              path:
                record.path === "/file/chunk-upload"
                  ? record.path
                  : record.path.startsWith("/fbt/202409/merchants/onboarded_regions")
                    ? "/fbt/202409/merchants/onboarded_regions"
                    : record.path.startsWith("/open/202512/file/init")
                      ? "/open/202512/file/init"
                      : operation.path,
              request: { operationId },
              response: { redacted: true },
            }),
        },
      });
      try {
        if (operation.transport === "large_upload") {
          const id = input.body?.data;
          const file = typeof id === "string" ? credentials.files?.[id] : undefined;
          const target = largeVideoTarget(operation.id);
          if (!file || !target)
            throw new PermanentConnectorError({
              code: "commerce_invalid_file",
              message: "Validated private video required",
            });
          const resource = await uploadTiktokLargeVideo(safeClient, {
            accessToken: credentials.accessToken,
            shopCipher: credentials.shopCipher,
            targetOperationId: target,
            filename: file.filename,
            contentType: file.mime as "video/mp4" | "video/quicktime" | "video/webm",
            ...(file.readRange && file.size ? { size: file.size, readRange: file.readRange } : { bytes: file.bytes }),
          });
          return {
            data: { resource_id: resource, target_operation_id: target },
            nextCursor: null,
            acknowledgement: "accepted",
          };
        }
        if (operation.path.startsWith("/fbt/") && !operation.path.endsWith("/merchants/onboarded_regions")) {
          const program = await safeClient.call<{ onboarded_regions?: { region_code?: string }[] }>({
            method: "GET",
            path: "/fbt/202409/merchants/onboarded_regions",
            accessToken: credentials.accessToken,
            shopCipher: credentials.shopCipher,
          });
          if (!program.onboarded_regions?.some((region) => region.region_code === "ID"))
            throw new PermanentConnectorError({
              code: "commerce_program_unavailable",
              message: "Seller is not onboarded to the Indonesian FBT program",
            });
        }
        let data: Record<string, unknown>;
        if (operation.transport === "multipart") {
          const form = new FormData();
          for (const [key, value] of Object.entries(input.body ?? {})) {
            const field = operation.fields.find((item) => item.name === `body.${key}`);
            if (field?.type === "file") {
              const file = typeof value === "string" ? credentials.files?.[value] : undefined;
              if (
                !file ||
                file.bytes.length === 0 ||
                file.bytes.length > (field.maxBytesByMime?.[file.mime] ?? field.maxBytes ?? 10_000_000) ||
                !field.accept?.includes(file.mime)
              )
                throw new PermanentConnectorError({
                  code: "commerce_invalid_file",
                  message: "Validated private upload required",
                });
              form.append(key, new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.filename);
            } else form.append(key, queryValue(value));
          }
          data = await safeClient.upload<Record<string, unknown>>({
            path,
            accessToken: credentials.accessToken,
            ...(operation.principalKind === "seller" ? { shopCipher: credentials.shopCipher } : {}),
            query,
            form: { body: form, logBody: { operationId, media: true } },
          });
        } else
          data = await safeClient.call<Record<string, unknown>>({
            method: operation.method,
            path,
            accessToken: credentials.accessToken,
            ...(operation.principalKind === "seller" ? { shopCipher: credentials.shopCipher } : {}),
            query,
            ...(input.body === undefined ? {} : { body: input.body }),
          });
        assertTiktokCommerceOutcome(operation, data);
        if (operation.transport === "private_download") {
          const file = data.file && typeof data.file === "object" ? (data.file as { base64?: unknown }) : {};
          const encoded = file.base64;
          if (
            typeof encoded !== "string" ||
            !encoded.length ||
            encoded.length > 27_000_000 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
          )
            throw new PermanentConnectorError({
              code: "bad_response",
              message: "Missing or oversized private result file",
            });
          const bytes = Buffer.from(encoded, "base64");
          return {
            data: {},
            nextCursor: null,
            acknowledgement: "read",
            download: { bytes, mime: "application/octet-stream", ext: "bin" },
          };
        }
        const allowed = operation.responseFields
          ? Object.fromEntries(Object.entries(data).filter(([key]) => operation.responseFields!.includes(key)))
          : {};
        const safe = safeCommerceResult(allowed);
        if (JSON.stringify(safe).length > 262_000)
          throw new PermanentConnectorError({
            code: "commerce_response_too_large",
            message: "Response exceeds one-page retention limit",
          });
        const cursor = data.next_page_token ?? data.next_cursor;
        if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || cursor.length > 2000))
          throw new PermanentConnectorError({ code: "bad_response", message: "Invalid or oversized pagination token" });
        return {
          data: safe,
          nextCursor: typeof cursor === "string" && cursor.length ? cursor : null,
          acknowledgement: operation.write ? "accepted" : "read",
        };
      } catch (error) {
        if (isConnectorError(error))
          throw errorOfKind(error.kind, {
            code: error.code,
            message: "Commerce API request failed; inspect operation permissions and marketplace status",
            ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
            ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
          });
        throw error;
      }
    },
  };
}
