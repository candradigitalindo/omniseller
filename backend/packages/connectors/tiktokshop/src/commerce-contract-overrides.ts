import {
  type CommerceInput,
  type CommerceOperation,
  type CommerceValue,
  PermanentConnectorError,
} from "@omniseller/connector-core";
import { TIKTOK_COMMERCE_QUERY_SERIALIZERS } from "./commerce-query-contracts.js";
import { TIKTOK_MAPPING_GET_PATH } from "./get-json-body.js";

/** Preserve documented int64 product identifiers as numeric JSON without Number rounding. */
export function tiktokCommerceBody(operation: CommerceOperation, input: CommerceInput): object | undefined {
  if (operation.path !== TIKTOK_MAPPING_GET_PATH) return input.body;
  const ids = input.body?.toko_pids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100)
    throw new PermanentConnectorError({ code: "commerce_invalid_input", message: "Provide one to 100 Tokopedia IDs" });
  return {
    toko_pids: ids.map((id) => {
      const decimal = exactInt64Id(id);
      // Node 24's standard JSON.rawJSON preserves a validated decimal numeric literal on the wire.
      const raw = JSON as unknown as { rawJSON(value: string): object };
      return raw.rawJSON(decimal);
    }),
  };
}

function exactInt64Id(id: CommerceValue): string {
  if (typeof id !== "string" || !/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9_223_372_036_854_775_807n)
    throw new PermanentConnectorError({ code: "commerce_invalid_input", message: "Invalid exact int64 identifier" });
  return id;
}

/** Follow the encoding in the specific endpoint's official query example. */
export function tiktokCommerceQuery(operation: CommerceOperation, key: string, value: CommerceValue): string {
  if (!Array.isArray(value)) return typeof value === "object" ? JSON.stringify(value) : String(value);
  const encoding = TIKTOK_COMMERCE_QUERY_SERIALIZERS[operation.path]?.[key];
  if (encoding === "json_int64") return `[${value.map(exactInt64Id).join(",")}]`;
  if (
    encoding === "csv" &&
    value.every((entry) => typeof entry === "string" && entry.length > 0 && !entry.includes(","))
  )
    return (value as string[]).join(",");
  throw new PermanentConnectorError({
    code: "commerce_invalid_input",
    message: "Invalid documented array query encoding",
  });
}

/** This read API has a documented nested business error even when the outer envelope is code 0. */
export function assertTiktokReadOutcome(operation: CommerceOperation, data: Record<string, unknown>): void {
  if (operation.path !== TIKTOK_MAPPING_GET_PATH || data.error === undefined || data.error === null) return;
  const error = data.error;
  if (typeof error !== "object" || Array.isArray(error) || typeof (error as { code?: unknown }).code !== "number")
    throw new PermanentConnectorError({ code: "bad_response", message: "Invalid mapping result error" });
  if ((error as { code: number }).code !== 0)
    throw new PermanentConnectorError({
      code: "commerce_mapping_rejected",
      message: "Product mapping request rejected",
    });
}

function visibleMessage(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { is_visible?: unknown }).is_visible === true,
  );
}

/** Official Customer Service message visibility applies before any generic cache or public projection. */
export function tiktokCommerceVisibleData(
  operation: CommerceOperation,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (operation.id === "tiktok_650a587edefece02be664cd2")
    return { ...data, messages: Array.isArray(data.messages) ? data.messages.filter(visibleMessage) : [] };
  if (operation.id === "tiktok_650a589f0fcef602bf29fecf")
    return {
      ...data,
      conversations: Array.isArray(data.conversations)
        ? data.conversations.map((value) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return {};
            const conversation = value as Record<string, unknown>;
            const { latest_message: latest, ...rest } = conversation;
            return visibleMessage(latest) ? { ...rest, latest_message: latest } : rest;
          })
        : [],
    };
  return data;
}
