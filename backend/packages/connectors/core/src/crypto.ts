import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hmacSha256Hex(key: string, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Constant-time comparison of two hex signatures (case-insensitive); false on any length mismatch. */
export function signatureEquals(expectedHex: string, received: string | undefined): boolean {
  if (!received) return false;
  const a = Buffer.from(expectedHex.toLowerCase(), "utf8");
  const b = Buffer.from(received.trim().toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
