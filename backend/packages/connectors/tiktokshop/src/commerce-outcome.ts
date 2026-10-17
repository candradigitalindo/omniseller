import { type CommerceOperation, PermanentConnectorError } from "@omniseller/connector-core";
import { TIKTOK_COMMERCE_FAILURE_FIELDS, type TiktokFailureField } from "./commerce-outcome-contracts.js";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const malformed = (): never => {
  throw new PermanentConnectorError({ code: "bad_response", message: "Invalid TikTok Shop mutation outcome" });
};
function nonempty(value: unknown, depth = 0): boolean {
  if (depth > 10) return malformed();
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (object(value)) return Object.values(value).some((entry) => nonempty(entry, depth + 1));
  return true;
}
function failed(value: unknown, kind: TiktokFailureField["kind"]): boolean {
  if (value === undefined) return false;
  if (kind === "failed_list") {
    if (!Array.isArray(value)) return malformed();
    return value.length > 0;
  }
  if (!object(value)) return malformed();
  if (kind === "failed_object") return nonempty(value);
  if (!Object.keys(value).length) return false;
  if (typeof value.code !== "number" || !Number.isSafeInteger(value.code)) return malformed();
  return value.code !== 0;
}
function failureAt(value: unknown, path: readonly string[], kind: TiktokFailureField["kind"]): boolean {
  if (!path.length) return failed(value, kind);
  if (Array.isArray(value)) return value.some((entry) => failureAt(entry, path, kind));
  if (value === undefined) return false;
  if (!object(value)) return malformed();
  const key = path[0]!;
  if (!Object.hasOwn(value, key)) return false;
  return failureAt(value[key], path.slice(1), kind);
}
/** A successful envelope is not proof that every item in a batch was accepted. */
export function assertTiktokCommerceOutcome(operation: Pick<CommerceOperation, "id" | "write">, data: unknown): void {
  if (!operation.write) return;
  if (!object(data)) malformed();
  const fields = Object.hasOwn(TIKTOK_COMMERCE_FAILURE_FIELDS, operation.id)
    ? TIKTOK_COMMERCE_FAILURE_FIELDS[operation.id]!
    : [];
  if (fields.some((field) => failureAt(data, field.path, field.kind)))
    throw new PermanentConnectorError({
      code: "commerce_partial_failure",
      message: "TikTok Shop refused one or more requested changes; verify affected items before retrying",
    });
}
