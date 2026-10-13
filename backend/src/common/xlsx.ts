/**
 * A small .xlsx writer for report downloads and emailed reports (backend doc 8.20, FR-RPT-05): the minimal
 * OOXML parts zipped in memory with fflate, no spreadsheet library (DOKUMEN-TEKNOLOGI 13). Every cell is an
 * inline string, a number, or absent; values mean what they mean in `csvCell`, so a CSV and a workbook of the
 * same rows read the same, except that a workbook needs no formula guard: an inline string is never a formula.
 */
import { strToU8, zipSync } from "fflate";
import type { CsvValue } from "./csv";
import { isoInZone } from "./time-zone";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface XlsxSheet {
  /** The tab's name; sanitized to what Excel accepts (31 chars, no `[]:*?/\`), made unique. */
  name: string;
  /** The header row, bold and frozen. */
  columns: readonly string[];
  rows: readonly (readonly CsvValue[])[];
}

export interface XlsxOptions {
  /** Times are written in this time zone with their offset, as the CSV does; UTC otherwise. */
  timeZone?: string;
}

/** Excel's limit for a cell's text. */
export const MAX_CELL_CHARS = 32_767;
const SHEET_NAME_MAX = 31;
const MIN_COLUMN_WIDTH = 8;
const MAX_COLUMN_WIDTH = 60;
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** Characters XML 1.0 cannot carry; dropped from text. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the code points XML forbids are control characters
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Text safe inside an element or an attribute. Excel decodes `_xHHHH_` in cell text, so that is escaped too. */
export function xmlEscape(text: string): string {
  return text
    .replace(XML_FORBIDDEN, "")
    .replace(/_(x[0-9A-Fa-f]{4}_)/g, "_x005F_$1")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Column letters of a 0-based index: 0 = A, 25 = Z, 26 = AA. */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A name Excel accepts, different from the ones already taken. */
export function sheetName(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .replace(/[[\]:*?/\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, SHEET_NAME_MAX)
      .trim() || "Lembar";
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = `${base.slice(0, SHEET_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** What a value says in a cell: a string to write inline, a number, or nothing. */
function cellText(v: CsvValue, opts: XlsxOptions): { text: string } | { number: number } | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? { number: v } : null;
  if (typeof v === "boolean") return { text: v ? "ya" : "tidak" };
  if (v instanceof Date) return { text: opts.timeZone ? isoInZone(opts.timeZone, v) : v.toISOString() };
  return { text: v.length > MAX_CELL_CHARS ? v.slice(0, MAX_CELL_CHARS) : v };
}

function cellXml(ref: string, v: CsvValue, style: number, opts: XlsxOptions): string {
  const c = cellText(v, opts);
  if (c === null) return "";
  const s = style ? ` s="${style}"` : "";
  if ("number" in c) return `<c r="${ref}"${s}><v>${c.number}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(c.text)}</t></is></c>`;
}

function rowXml(index: number, values: readonly CsvValue[], style: number, opts: XlsxOptions): string {
  const cells = values.map((v, i) => cellXml(`${columnLetters(i)}${index}`, v, style, opts)).join("");
  return `<row r="${index}">${cells}</row>`;
}

/** Column widths from the longest text in each column, within Excel-friendly bounds. */
function columnWidths(sheet: XlsxSheet, opts: XlsxOptions): number[] {
  const widths = sheet.columns.map((c) => c.length);
  for (const row of sheet.rows) {
    row.forEach((v, i) => {
      const c = cellText(v, opts);
      const len = c === null ? 0 : "number" in c ? String(c.number).length : c.text.length;
      widths[i] = Math.max(widths[i] ?? 0, len);
    });
  }
  return widths.map((w) => Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, w + 2)));
}

function worksheetXml(sheet: XlsxSheet, opts: XlsxOptions): string {
  const cols = columnWidths(sheet, opts)
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join("");
  const rows = [rowXml(1, sheet.columns, 1, opts)];
  for (const [i, r] of sheet.rows.entries()) rows.push(rowXml(i + 2, r, 0, opts));
  return (
    `${XML_HEAD}<worksheet xmlns="${MAIN_NS}">` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${rows.join("")}</sheetData></worksheet>`
  );
}

const STYLES =
  `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** The workbook as bytes: one tab per sheet, in order, the header row bold and frozen. */
export function toXlsx(sheets: readonly XlsxSheet[], opts: XlsxOptions = {}): Uint8Array {
  if (sheets.length === 0) throw new Error("a workbook needs at least one sheet");
  const taken = new Set<string>();
  const names = sheets.map((s) => {
    const name = sheetName(s.name, taken);
    taken.add(name.toLowerCase());
    return name;
  });
  const files: Record<string, Uint8Array> = {};
  const overrides = sheets
    .map(
      (_s, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("");
  files["[Content_Types].xml"] = strToU8(
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `${overrides}</Types>`,
  );
  files["_rels/.rels"] = strToU8(
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );
  files["xl/workbook.xml"] = strToU8(
    `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>` +
      names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      `</sheets></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets
        .map(
          (_s, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  );
  files["xl/styles.xml"] = strToU8(STYLES);
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(worksheetXml(s, opts));
  });
  return zipSync(files, { level: 6 });
}
