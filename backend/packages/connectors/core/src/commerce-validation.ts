import type { CommerceField, CommerceInput, CommerceOperation, CommerceValue } from "./commerce-types.js";
import { PermanentConnectorError } from "./errors.js";

const fail = (path: string, detail: string): never => {
  throw new PermanentConnectorError({ code: "commerce_invalid_input", message: `${path}: ${detail}` });
};
const object = (value: unknown): value is Record<string, CommerceValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const forbidden =
  /^(?:__proto__|prototype|constructor|app_key|app_secret|access_token|refresh_token|sign|timestamp|shop_cipher|category_asset_cipher|cipher|authorization|password)$/i;

function value(field: CommerceField, item: CommerceValue, path: string, depth: number): void {
  if (depth > 10) fail(path, "nested input exceeds limit");
  switch (field.type) {
    case "enum":
      if (item === "" && field.allowEmpty) break;
      if (typeof item !== "string" || !field.options?.includes(item)) fail(path, "choose a documented option");
      break;
    case "string":
      if (typeof item !== "string" || item.length > Math.min(field.maxLength ?? 8192, 8192)) fail(path, "invalid text");
      break;
    case "file":
      if (typeof item !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(item))
        fail(path, "choose a private uploaded file");
      break;
    case "integer":
    case "number":
      if (
        typeof item !== "number" ||
        !Number.isFinite(item) ||
        (field.type === "integer" && !Number.isSafeInteger(item)) ||
        (field.minimum !== undefined && item < field.minimum) ||
        (field.maximum !== undefined && item > field.maximum)
      )
        fail(path, "invalid number; external IDs must remain strings");
      break;
    case "boolean":
      if (typeof item !== "boolean") fail(path, "invalid boolean");
      break;
    case "object":
      if (!object(item)) fail(path, "object required");
      fields(field.children ?? [], item as Record<string, CommerceValue>, path, depth + 1);
      break;
    case "array":
      if (
        !Array.isArray(item) ||
        item.length > Math.min(field.maximum ?? 100, 100) ||
        item.length < (field.minimum ?? 0)
      )
        fail(path, "invalid list");
      for (const [i, entry] of (item as CommerceValue[]).entries()) {
        value(
          { ...field, name: String(i), type: field.itemType ?? "object", maximum: undefined, minimum: undefined },
          entry,
          `${path}.${i}`,
          depth + 1,
        );
      }
      break;
  }
}
function fields(
  definitions: CommerceField[],
  input: Record<string, CommerceValue>,
  path: string,
  depth: number,
  originRegions: readonly string[] = [],
) {
  for (const key of Object.keys(input)) {
    if (forbidden.test(key)) fail(`${path}.${key}`, "credentials are selected by the server");
    if (!definitions.some((field) => field.name === key)) fail(`${path}.${key}`, "undocumented field");
  }
  for (const field of definitions) {
    const entry = input[field.name];
    if (entry === undefined) {
      if (field.required) fail(`${path}.${field.name}`, "required");
      continue;
    }
    if (entry === null) fail(`${path}.${field.name}`, "null is not a documented value");
    if (entry === "" && field.required && !field.allowEmpty) fail(`${path}.${field.name}`, "required");
    value(field, entry, `${path}.${field.name}`, depth);
    if (
      /^(?:target_market|target_market_code|selection_region|region|region_code|country_code|market)$/.test(
        field.name,
      ) &&
      entry !== "ID" &&
      !(field.name === "region" && typeof entry === "string" && originRegions.includes(entry))
    )
      fail(`${path}.${field.name}`, "only the documented Indonesia scope is enabled");
  }
}
/** The HTTP boundary and connector both enforce the same reviewed whitelist. */
export function validateCommerceInput(operation: CommerceOperation, input: CommerceInput): void {
  if (!object(input)) fail("input", "object required");
  if (JSON.stringify(input).length > 65_536) fail("input", "request too large");
  for (const key of Object.keys(input)) {
    if (!["path", "query", "body", "categoryAssetId"].includes(key)) fail(key, "undocumented request section");
  }
  if (
    input.categoryAssetId !== undefined &&
    (!operation.categoryAsset || !Number.isSafeInteger(input.categoryAssetId) || input.categoryAssetId <= 0)
  )
    fail("categoryAssetId", "invalid public category identifier");
  for (const section of ["path", "query", "body"] as const) {
    const raw = input[section] ?? {};
    if (!object(raw)) fail(section, "object required");
    fields(
      operation.fields
        .filter((field) => field.name.startsWith(`${section}.`))
        .map((field) => ({ ...field, name: field.name.slice(section.length + 1) })),
      raw,
      section,
      0,
      section === "body" && operation.id === "shopee.first_mile.bind_first_mile_tracking_number"
        ? ["CN", "KR"]
        : section === "body" && operation.id === "shopee.first_mile.generate_and_bind_first_mile_tracking_number"
          ? ["CN"]
          : [],
    );
  }
}

const privateField =
  /(?:token|secret|cipher|password|authorization|buyer|customer|recipient|address|phone|email|mobile|identity|tracking_number|shipping_label|download_url)|(?:push_key|push_url|play_url|stream_url|file_link)$/i;
/** Cache is intentionally stripped of buyer PII, secrets and private download URLs. */
export function safeCommerceResult(input: unknown, depth = 0): CommerceValue {
  if (depth > 12) return null;
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string") return input.slice(0, 8192);
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  if (Array.isArray(input)) return input.slice(0, 100).map((item) => safeCommerceResult(item, depth + 1));
  if (typeof input !== "object" || !input) return null;
  const result: Record<string, CommerceValue> = {};
  for (const [key, entry] of Object.entries(input).slice(0, 200)) {
    if (privateField.test(key) || forbidden.test(key)) continue;
    result[key] = safeCommerceResult(entry, depth + 1);
  }
  return result;
}
