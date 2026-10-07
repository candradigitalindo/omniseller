import type { DocumentReminderStage, NibReminderStage } from "../../db/schema";

/**
 * The business profile and its legal documents as rules (PRD 6.13 and 12, Permendag 19/2026; UI L47;
 * backend doc 8.29). Dates are calendar dates (YYYY-MM-DD) in the business's time zone. Pure functions.
 */

/** A seller may trade while getting an NIB for at most this long (Permendag 19/2026). */
export const NIB_PROCESS_MONTHS = 6;

/** Indonesia's three zones: WIB, WITA, WIT. */
export const BUSINESS_TIMEZONES = ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura"] as const;

/** Reminders before an end date, in days; then once when it has passed. */
export const REMINDER_DAYS = { first: 30, second: 7 } as const;

/** Digits only, as numbers are often typed with dots, dashes, or spaces ("12.345.678.9-012.000"). */
export function digitsOf(text: string): string {
  return text.replace(/[\s.\-/]/g, "");
}

export type NibStatus = "registered" | "in_process" | "missing";

export function nibStatus(p: { nib: string | null; nibInProcessSince: string | null }): NibStatus {
  if (p.nib) return "registered";
  return p.nibInProcessSince ? "in_process" : "missing";
}

const DAY_MS = 86_400_000;
const asUtc = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** Calendar days from one date to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((asUtc(to) - asUtc(from)) / DAY_MS);
}

/** The date `months` later, the last day of the month when it is shorter (31 Aug + 6 = 28 or 29 Feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The last day an NIB may still be "in process". */
export function nibDeadline(since: string): string {
  return addMonths(since, NIB_PROCESS_MONTHS);
}

export type DocumentStatus = "no_expiry" | "valid" | "expiring" | "expired";

/** A document is valid through its `validUntil` day; within 30 days of it, it is expiring. */
export function documentStatus(
  validUntil: string | null,
  today: string,
): { status: DocumentStatus; daysLeft: number | null } {
  if (!validUntil) return { status: "no_expiry", daysLeft: null };
  const daysLeft = daysBetween(today, validUntil);
  if (daysLeft < 0) return { status: "expired", daysLeft };
  return { status: daysLeft <= REMINDER_DAYS.first ? "expiring" : "valid", daysLeft };
}

const ORDER: Record<string, number> = { "30d": 1, "7d": 2, expired: 3, passed: 3 };

/** Which reminder is due for an end date, if it was not sent yet: the latest stage reached wins. */
function dueStage<S extends string>(end: string, today: string, sent: S | null, past: S): (S | "30d" | "7d") | null {
  const left = daysBetween(today, end);
  const reached = left < 0 ? past : left <= REMINDER_DAYS.second ? "7d" : left <= REMINDER_DAYS.first ? "30d" : null;
  if (!reached) return null;
  return (ORDER[reached] ?? 0) > (sent ? (ORDER[sent] ?? 0) : 0) ? reached : null;
}

export function dueDocumentStage(
  validUntil: string | null,
  today: string,
  sent: DocumentReminderStage | null,
): DocumentReminderStage | null {
  return validUntil ? (dueStage(validUntil, today, sent, "expired") as DocumentReminderStage | null) : null;
}

export function dueNibStage(
  p: { nib: string | null; nibInProcessSince: string | null; nibRemindedStage: NibReminderStage | null },
  today: string,
): NibReminderStage | null {
  if (p.nib || !p.nibInProcessSince) return null;
  return dueStage(nibDeadline(p.nibInProcessSince), today, p.nibRemindedStage, "passed") as NibReminderStage | null;
}

export interface LegalTask {
  kind: "legal_nib" | "legal_documents";
  severity: "critical" | "warning";
  count: number;
  title: string;
}

/** "Perlu tindakan" on the dashboard for whoever keeps the business's legal papers (settings:billing). */
export function legalTasks(
  p: { nib: string | null; nibInProcessSince: string | null },
  documents: { validUntil: string | null }[],
  today: string,
): LegalTask[] {
  const tasks: LegalTask[] = [];
  const status = nibStatus(p);
  if (status === "missing") {
    tasks.push({
      kind: "legal_nib",
      severity: "warning",
      count: 1,
      title: "NIB belum diisi: wajib bagi penjual di marketplace (Permendag 19/2026)",
    });
  } else if (status === "in_process") {
    const left = daysBetween(today, nibDeadline(p.nibInProcessSince!));
    if (left < 0) {
      tasks.push({ kind: "legal_nib", severity: "critical", count: 1, title: "Batas 6 bulan proses NIB sudah lewat" });
    } else if (left <= REMINDER_DAYS.first) {
      tasks.push({
        kind: "legal_nib",
        severity: "warning",
        count: 1,
        title: `Batas proses NIB tinggal ${left} hari`,
      });
    }
  }
  const due = documents.map((d) => documentStatus(d.validUntil, today).status);
  const expired = due.filter((s) => s === "expired").length;
  const expiring = due.filter((s) => s === "expiring").length;
  if (expired + expiring > 0) {
    tasks.push({
      kind: "legal_documents",
      severity: expired > 0 ? "critical" : "warning",
      count: expired + expiring,
      title:
        expired > 0
          ? `${expired + expiring} dokumen legalitas habis berlaku atau segera habis`
          : `${expiring} dokumen legalitas habis berlaku dalam 30 hari`,
    });
  }
  return tasks;
}
