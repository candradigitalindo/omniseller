/**
 * CSV for product import and export (FR-PRD-04). RFC 4180 quoting; the delimiter is detected from the
 * header (Excel with Indonesian regional settings writes `;`, others `,`). Export writes `;`, a UTF-8
 * BOM, and CRLF so Excel in Indonesia opens it in columns with the right characters.
 */
/** UTF-8 byte order mark: makes Excel read the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

export function detectDelimiter(text: string): "," | ";" {
  const firstLine = text.slice(0, Math.max(0, text.indexOf("\n")) || text.length);
  const count = (c: string) => firstLine.split(c).length - 1;
  return count(";") > count(",") ? ";" : ",";
}

export function parseCsv(input: string): string[][] {
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
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function quote(value: string, delimiter: string): string {
  return /["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: (string | number | null | undefined)[][], delimiter = ";"): string {
  const body = rows.map((r) =>
    r.map((v) => quote(v === null || v === undefined ? "" : String(v), delimiter)).join(delimiter),
  );
  return `${BOM}${body.join("\r\n")}\r\n`;
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
