import { parseCsv } from "../catalog/csv";
import { readXlsx, SheetError } from "./xlsx";

export { SheetError };

/** The uploaded file may be at most this big (the JSON body carries it as base64, under 12 MB). */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export type SheetType = "xlsx" | "csv";

/** What the bytes are, from their content (backend doc 8.19; the file name is not trusted). */
export function sniffSheetType(bytes: Uint8Array): SheetType {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "xlsx";
  }
  // old binary Excel (.xls, OLE2) and other binaries are refused with a clear message
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new SheetError("Format .xls lama tidak didukung. Simpan ulang sebagai .xlsx atau CSV.");
  }
  if (bytes.subarray(0, 4096).includes(0)) throw new SheetError("Berkas harus Excel (.xlsx) atau CSV.");
  return "csv";
}

/** CSV text: UTF-8 (with or without BOM), or Windows-1252 as Excel saves "CSV" on many PCs. */
function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * All rows of the first sheet as text; row i is spreadsheet row i + 1 (blank rows included), so
 * errors can name the row the seller sees. At most `maxRows` rows are read.
 */
export function readSheet(
  bytes: Uint8Array,
  maxRows: number,
): { type: SheetType; rows: string[][]; truncated: boolean } {
  const type = sniffSheetType(bytes);
  if (type === "xlsx") return { type, ...readXlsx(bytes, maxRows) };
  const rows = parseCsv(decodeText(bytes), { keepBlankRows: true });
  return { type, rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
}
