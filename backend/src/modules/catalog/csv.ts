import { unguardCell } from "../../common/csv";

/**
 * CSV for product import and export (FR-PRD-04). RFC 4180 quoting; the delimiter is detected from the
 * header (Excel with Indonesian regional settings writes `;`, others `,`). Export uses the shared
 * writer (`common/csv.ts`: `;`, a UTF-8 BOM, CRLF, formula guard); import drops the guard again.
 */
export { toCsv } from "../../common/csv";

export function detectDelimiter(text: string): "," | ";" {
  const firstLine = text.slice(0, Math.max(0, text.indexOf("\n")) || text.length);
  const count = (c: string) => firstLine.split(c).length - 1;
  return count(";") > count(",") ? ";" : ",";
}

/** Rows of a CSV; blank rows are dropped unless `keepBlankRows` (the migration import counts rows). */
export function parseCsv(input: string, opts: { keepBlankRows?: boolean } = {}): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(unguardCell(field));
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(unguardCell(field));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(unguardCell(field));
    rows.push(row);
  }
  return opts.keepBlankRows ? rows : rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** "65000", "65.000", "65,000", "Rp 65.000" -> 65000. Decimals are refused: prices are whole rupiah. */
export function parseWholeNumber(value: string): number | null {
  const v = value.replace(/^rp\.?\s*/i, "").replace(/\s/g, "");
  if (/^\d+$/.test(v)) return Number(v);
  if (/^\d{1,3}([.,]\d{3})+$/.test(v)) return Number(v.replace(/[.,]/g, ""));
  return null;
}

/** "Warna=Hitam; Ukuran=L" -> { Warna: "Hitam", Ukuran: "L" }; null when a pair has no "=". */
export function parseAttributes(value: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of value
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const at = part.indexOf("=");
    if (at <= 0) return null;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

export function formatAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export const IMAGE_SEPARATOR = " | ";
