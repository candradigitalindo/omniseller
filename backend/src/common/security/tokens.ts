import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256-bit random token, URL safe. Sent to the user once; only its hash is stored. */
export function newSecretToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 is enough for high-entropy random tokens (no need for a slow hash). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Shape check before hashing or looking anything up; rejects obviously forged input cheaply. */
export function looksLikeSecretToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
