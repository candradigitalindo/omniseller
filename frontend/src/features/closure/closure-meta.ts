import type { components } from "@/lib/api/schema";

export type AccountClosure = components["schemas"]["AccountClosureDto_Output"];

const DAY_MS = 86_400_000;

/** Whole days left until the business's data is deleted, never below zero ("29 hari lagi"). */
export function daysLeft(purgeAfter: string, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((Date.parse(purgeAfter) - now.getTime()) / DAY_MS));
}

/** The business's name typed again: the same words whatever the case and spacing, as the api checks. */
export function namesMatch(typed: string, name: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("id-ID");
  return norm(name).length > 0 && norm(typed) === norm(name);
}
