import { decodeTime, encodeTime, monotonicFactory, ulid } from "ulid";
import { z } from "zod";

const generate = monotonicFactory();

export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const ulidSchema = z.string().regex(ULID_REGEX, "invalid ULID");

/** New monotonic ULID. The only way application code creates record ids. */
export function newId(): string {
  return generate();
}

/**
 * ULID for a record whose time comes from outside (a marketplace order placed at `at`): ids sort by
 * that time and the record lands in the partition of that month. Not monotonic within a millisecond.
 */
export function newIdAt(at: Date): string {
  return ulid(at.getTime());
}

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_REGEX.test(value);
}

export function assertUlid(value: string): asserts value is string {
  if (!ULID_REGEX.test(value)) throw new Error(`invalid ULID: ${value}`);
}

export function ulidTime(id: string): Date {
  return new Date(decodeTime(id));
}

/** Lower bound ULID for a moment: 10-char time prefix followed by 16 zeros. Used as partition bound. */
export function ulidLowerBound(at: Date): string {
  return `${encodeTime(at.getTime(), 10)}0000000000000000`;
}
