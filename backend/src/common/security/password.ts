import { Algorithm, hash, verify } from "@node-rs/argon2";
import { z } from "zod";

/**
 * Password hashing (technology doc 5.3): Argon2id, 64 MB memory, 3 iterations, parallelism 4.
 * Hashes are PHC strings, so the parameters travel with each hash and can be raised later;
 * `needsRehash` tells the login flow when to upgrade a stored hash.
 */
const PARAMS = { algorithm: Algorithm.Argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 } as const;
const PHC_PARAMS = `m=${PARAMS.memoryCost},t=${PARAMS.timeCost},p=${PARAMS.parallelism}`;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, PARAMS);
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    return false; // malformed stored hash counts as a mismatch, never as an error the caller can observe
  }
}

export function needsRehash(stored: string): boolean {
  return !stored.startsWith("$argon2id$") || !stored.includes(PHC_PARAMS);
}

/**
 * Burns the same time as a real verification. Used when no account matches an email, so response
 * time does not reveal which emails are registered.
 */
let dummyHash: Promise<string> | undefined;
export async function verifyAgainstDummy(plain: string): Promise<void> {
  dummyHash ??= hashPassword("omniseller-dummy-password");
  await verifyPassword(await dummyHash, plain);
}

/** Password rules shown to the user; kept simple and length-based (NIST SP 800-63B). */
export const passwordSchema = z
  .string()
  .min(10, "Kata sandi minimal 10 karakter.")
  .max(128, "Kata sandi maksimal 128 karakter.");
