import { createHmac, hkdfSync, randomInt } from "node:crypto";
import { generateSecret, generateURI, verify } from "otplib";
import { openAesGcm, sealAesGcm } from "./key-provider";

/**
 * Verification in two steps (technology doc 5.3, backend doc 8.30): TOTP as authenticator apps expect it
 * (RFC 6238 with SHA-1, 6 digits, 30-second steps), and one-time backup codes for a lost phone.
 */

/** A code of the step before or after is accepted too: phone clocks drift, and people type slowly. */
export const TOTP_TOLERANCE_SECONDS = 30;
export const BACKUP_CODE_COUNT = 10;

/** 20 random bytes (160 bits) in base32, as RFC 4226 recommends. */
export function newTotpSecret(): string {
  return generateSecret({ length: 20 });
}

/** The otpauth:// link an authenticator app reads from the QR code. */
export function totpUri(issuer: string, account: string, secret: string): string {
  return generateURI({ issuer, label: account, secret });
}

/**
 * The time step a code was made for, or null: a wrong code, or one of a step already used (`afterStep`,
 * the step of the last accepted code), so a code seen over someone's shoulder cannot sign in again.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  opts: { afterStep?: number | null; now?: Date } = {},
): Promise<number | null> {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const result = await verify({
    secret,
    token: code,
    epochTolerance: TOTP_TOLERANCE_SECONDS,
    ...(opts.afterStep !== undefined && opts.afterStep !== null ? { afterTimeStep: opts.afterStep } : {}),
    ...(opts.now ? { epoch: Math.floor(opts.now.getTime() / 1000) } : {}),
  });
  // the functional API's result type also covers HOTP, which has no time step
  return result.valid && "timeStep" in result ? result.timeStep : null;
}

/** No i, l, o, 0, or 1: nothing to mistake when a code is copied from paper. */
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Codes like "k7m2q-x9p4w": 10 characters of 31, about 49 bits each. */
export function newBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const chars = Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    codes.add(`${chars.slice(0, 5)}-${chars.slice(5)}`);
  }
  return [...codes];
}

/** A backup code as typed: letter case, spaces, and dashes do not matter. */
export function normalizeBackupCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, "");
}

/**
 * Keys of the api for two-step verification, derived from TOTP_ENCRYPTION_KEY (HKDF, one key per use).
 * TOTP secrets are sealed with AES-256-GCM bound to their user, so a sealed secret copied onto another
 * user's row does not open. Backup codes are kept as HMACs bound to their user: the database alone,
 * without the api's key, cannot be searched for codes.
 */
export class TwoFactorKeys {
  private readonly sealKey: Buffer;
  private readonly codeKey: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, "base64");
    if (key.length !== 32) throw new Error("TOTP_ENCRYPTION_KEY must be 32 bytes (base64)");
    this.sealKey = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "omniseller totp secret", 32));
    this.codeKey = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "omniseller backup code", 32));
  }

  seal(tenantId: string, userId: string, secret: string): Buffer {
    return sealAesGcm(this.sealKey, Buffer.from(secret, "utf8"), `totp:${tenantId}:${userId}`);
  }

  open(tenantId: string, userId: string, sealed: Buffer): string {
    return openAesGcm(this.sealKey, sealed, `totp:${tenantId}:${userId}`).toString("utf8");
  }

  hashBackupCode(userId: string, code: string): string {
    return createHmac("sha256", this.codeKey)
      .update(`${userId}:${normalizeBackupCode(code)}`)
      .digest("base64url");
  }
}
