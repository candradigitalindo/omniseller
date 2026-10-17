import { PermanentConnectorError } from "@omniseller/connector-core";

const MAX_INT64 = 9_223_372_036_854_775_807n;

/** parseJsonSafe returns large JSON integers as strings. Never recover an already rounded number. */
export function shopeeId(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  if (typeof value !== "string" || !/^\d{1,19}$/.test(value)) return null;
  const id = BigInt(value);
  return id <= MAX_INT64 ? id.toString() : null;
}

/** Shopee expects JSON numbers for int64 IDs, including those beyond JavaScript's exact range. */
export function numericId(value: string | number): unknown {
  const id = shopeeId(value);
  if (id === null) throw new PermanentConnectorError({ code: "invalid_request", message: "Invalid Shopee identifier" });
  if (BigInt(id) <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(id);
  return (JSON as typeof JSON & { rawJSON(value: string): unknown }).rawJSON(id);
}
