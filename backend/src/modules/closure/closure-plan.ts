/**
 * Account closure (PRD 12.1, backend doc 8.36) as pure rules: when the business's data goes, when it is
 * reminded, and how its name is typed to confirm.
 */

const DAY_MS = 86_400_000;

/** Days a closed account stays read only before its data is deleted: what the Terms and Privacy Policy promise. */
export const PURGE_AFTER_DAYS = 30;

/** Days before the deletion when whoever manages billing is reminded, once. */
export const PURGE_REMINDER_DAYS = 7;

/** `store.status_reason` of the stores the closure disconnected (their revoke links stay on the closing page). */
export const CLOSURE_REASON = "account_closing";

export function purgeDate(closedAt: Date): Date {
  return new Date(closedAt.getTime() + PURGE_AFTER_DAYS * DAY_MS);
}

/** The reminder is due from PURGE_REMINDER_DAYS before the deletion until the deletion itself. */
export function reminderDue(purgeAfter: Date, now: Date): boolean {
  return now.getTime() >= purgeAfter.getTime() - PURGE_REMINDER_DAYS * DAY_MS && now.getTime() < purgeAfter.getTime();
}

/** The business's name typed to confirm: the same words, whatever the case and spacing. */
export function confirmsName(typed: string, name: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("id-ID");
  return norm(name).length > 0 && norm(typed) === norm(name);
}
