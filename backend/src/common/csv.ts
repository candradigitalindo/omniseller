import { isoInZone } from "./time-zone";

/**
 * CSV for spreadsheets (product CSV FR-PRD-04, full export FR-MIG-09): `;` between fields, RFC 4180
 * quoting, a UTF-8 BOM, and CRLF, so Excel with Indonesian regional settings opens it in columns with
 * the right characters.
 *
 * Text that starts like a formula (`=`, `+`, `-`, `@`, tab, CR) gets a leading apostrophe, so a
 * spreadsheet shows it instead of running it (CSV injection, OWASP): buyer names and notes come from
 * outside. Numbers are written as they are. `parseCsv` (catalog) drops the apostrophe again.
 */

/** UTF-8 byte order mark: makes Excel read the file as UTF-8. */
export const CSV_BOM = String.fromCharCode(0xfeff);

export type CsvValue = string | number | boolean | Date | null | undefined;

/** Starts like a formula, also after apostrophes a guard would add (so `'=x` survives a round trip). */
const FORMULA_START = /^'*[=+\-@\t\r]/;

export interface CsvOptions {
  delimiter?: string;
  /** Times are written in this time zone with their offset (2026-10-03T14:15:00+07:00); UTC otherwise. */
  timeZone?: string;
}

export function csvCell(v: CsvValue, opts: CsvOptions = {}): string {
  const delimiter = opts.delimiter ?? ";";
  let s: string;
  if (v === null || v === undefined) return "";
  if (typeof v === "number") s = String(v);
  else if (typeof v === "boolean") s = v ? "ya" : "tidak";
  else if (v instanceof Date) s = opts.timeZone ? isoInZone(opts.timeZone, v) : v.toISOString();
  else s = FORMULA_START.test(v) ? `'${v}` : v;
  return /["\r\n]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One record, ending with CRLF. */
export function csvLine(values: readonly CsvValue[], opts: CsvOptions = {}): string {
  return `${values.map((v) => csvCell(v, opts)).join(opts.delimiter ?? ";")}\r\n`;
}

/** A whole file: BOM, then one line per row. */
export function toCsv(rows: readonly (readonly CsvValue[])[], opts: CsvOptions = {}): string {
  return CSV_BOM + rows.map((r) => csvLine(r, opts)).join("");
}

/** Undoes the formula guard of `csvCell` on a parsed field. */
export function unguardCell(field: string): string {
  return field.startsWith("'") && FORMULA_START.test(field) ? field.slice(1) : field;
}
