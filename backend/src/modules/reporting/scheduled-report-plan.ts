/**
 * Scheduled report emails (PRD FR-RPT-05, backend doc 8.20): which reports go out, for which period, and
 * what the notification says. Pure; the dates are the business's local dates (YYYY-MM-DD).
 */
import { addDays, addMonths } from "./sales-report-plan";

export type ReportCadence = "weekly" | "monthly";
export type ScheduledReport = "sales" | "staff";

export interface ReportKind {
  /** The notification and preference kind (UI L44). */
  kind: string;
  report: ScheduledReport;
  cadence: ReportCadence;
  /** Who may receive it: the report's own permission. */
  permission: "report:read" | "settings:user";
  /** The plan feature the report needs, if any. */
  feature: "staff_report" | null;
}

export const REPORT_KINDS: readonly ReportKind[] = [
  { kind: "report.sales_weekly", report: "sales", cadence: "weekly", permission: "report:read", feature: null },
  { kind: "report.sales_monthly", report: "sales", cadence: "monthly", permission: "report:read", feature: null },
  {
    kind: "report.staff_weekly",
    report: "staff",
    cadence: "weekly",
    permission: "settings:user",
    feature: "staff_report",
  },
  {
    kind: "report.staff_monthly",
    report: "staff",
    cadence: "monthly",
    permission: "settings:user",
    feature: "staff_report",
  },
];

export const REPORT_CADENCES: readonly ReportCadence[] = ["weekly", "monthly"];

/** The local hour from which a period's report may go, on the day after the period. */
export const REPORT_SEND_HOUR = 7;

export const reportKindOf = (kind: string): ReportKind | undefined => REPORT_KINDS.find((k) => k.kind === kind);

export const reportKindsOf = (cadence: ReportCadence): ReportKind[] =>
  REPORT_KINDS.filter((k) => k.cadence === cadence);

/** The Monday of the ISO week holding a date. */
export function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 Sunday
  return addDays(date, -((weekday + 6) % 7));
}

/**
 * The period a report sent on `date` covers: the Monday..Sunday week before the one holding `date`, or
 * the calendar month before the one holding `date`.
 */
export function periodBefore(cadence: ReportCadence, date: string): { from: string; to: string } {
  if (cadence === "weekly") {
    const monday = mondayOf(date);
    return { from: addDays(monday, -7), to: addDays(monday, -1) };
  }
  const first = `${date.slice(0, 8)}01`;
  return { from: addMonths(first, -1), to: addDays(first, -1) };
}

/** The local day and hour from which the period's report goes: the day after it, at REPORT_SEND_HOUR. */
export function sendsFrom(period: { to: string }): { date: string; hour: number } {
  return { date: addDays(period.to, 1), hour: REPORT_SEND_HOUR };
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const MONTHS_LONG = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

const parts = (date: string) => ({ y: date.slice(0, 4), m: Number(date.slice(5, 7)), d: Number(date.slice(8, 10)) });

/** "minggu 6–12 Okt 2026", "minggu 29 Sep–5 Okt 2026", "minggu 29 Des 2025–4 Jan 2026", or "bulan September 2026". */
export function periodLabel(cadence: ReportCadence, period: { from: string; to: string }): string {
  const a = parts(period.from);
  const b = parts(period.to);
  if (cadence === "monthly") return `bulan ${MONTHS_LONG[a.m - 1]} ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `minggu ${a.d}–${b.d} ${MONTHS_SHORT[a.m - 1]} ${a.y}`;
  if (a.y === b.y) return `minggu ${a.d} ${MONTHS_SHORT[a.m - 1]}–${b.d} ${MONTHS_SHORT[b.m - 1]} ${a.y}`;
  return `minggu ${a.d} ${MONTHS_SHORT[a.m - 1]} ${a.y}–${b.d} ${MONTHS_SHORT[b.m - 1]} ${b.y}`;
}

const REPORT_NAMES: Record<ScheduledReport, string> = { sales: "Laporan penjualan", staff: "Laporan kinerja tim" };
const SCREEN_NAMES: Record<ScheduledReport, string> = { sales: "Laporan Penjualan", staff: "Kinerja Tim" };

/** The notification's title: "Laporan penjualan minggu 6–12 Okt 2026". */
export function reportTitle(
  report: ScheduledReport,
  cadence: ReportCadence,
  period: { from: string; to: string },
): string {
  return `${REPORT_NAMES[report]} ${periodLabel(cadence, period)}`;
}

/** The notification's body; the email adds "Terlampir: <berkas>". */
export function reportBody(report: ScheduledReport): string {
  return `Laporan terlampir di email Anda sebagai berkas Excel. Buka ${SCREEN_NAMES[report]} untuk melihatnya di aplikasi.`;
}
