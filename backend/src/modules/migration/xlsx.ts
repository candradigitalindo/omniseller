import { strFromU8, Unzip, UnzipInflate } from "fflate";

/** A file the import cannot read; the message is shown to the seller. */
export class SheetError extends Error {}

/** Unzipped XML may not exceed this, whatever the ZIP headers claim (a small ZIP can expand a lot). */
export const MAX_XLSX_UNZIPPED = 96 * 1024 * 1024;

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The entries of a ZIP that `keep` wants, inflated with a hard limit on the bytes produced. */
function unzipLimited(bytes: Uint8Array, keep: (name: string) => boolean, limit: number): Map<string, Uint8Array> {
  const chunks = new Map<string, Uint8Array[]>();
  let total = 0;
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    if (!keep(file.name)) return; // never started: skipped without inflating
    const parts: Uint8Array[] = [];
    chunks.set(file.name, parts);
    file.ondata = (err, data) => {
      if (failure) return;
      if (err) {
        failure = err;
        return;
      }
      total += data.length;
      if (total > limit) {
        failure = new SheetError("Isi berkas Excel terlalu besar. Pecah menjadi beberapa berkas.");
        file.terminate();
        return;
      }
      parts.push(data);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(bytes, true);
  } catch {
    throw new SheetError("Berkas Excel rusak atau bukan .xlsx.");
  }
  // set inside the callbacks above, which the compiler's flow analysis does not follow
  const failed = failure as Error | null;
  if (failed) throw failed instanceof SheetError ? failed : new SheetError("Berkas Excel rusak atau bukan .xlsx.");
  return new Map([...chunks].map(([name, parts]) => [name, concat(parts)]));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML character references, then OOXML's `_xHHHH_` escapes (a CR in a cell is `_x000D_`). */
export function xmlText(s: string): string {
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) =>
      e[0] === "#"
        ? String.fromCodePoint(e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10))
        : ENTITIES[e]!,
    )
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
}

function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/([\w.-]+(?::[\w.-]+)?)\s*=\s*"([^"]*)"/g)) out.set(m[1]!, xmlText(m[2]!));
  return out;
}

/** An attribute by its local name, whatever namespace prefix the writer chose. */
const attr = (a: Map<string, string>, local: string): string | undefined => {
  for (const [k, v] of a) if (k === local || k.endsWith(`:${local}`)) return v;
  return undefined;
};

/** Text of a string item (`<si>` or `<is>`): all runs, phonetic hints left out. */
function runText(xml: string): string {
  const plain = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
  let out = "";
  for (const m of plain.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) out += xmlText(m[1] ?? "");
  return out;
}

/** "B" -> 1, "AA" -> 26. */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function resolveTarget(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = ["xl"];
  for (const p of target.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return parts.join("/");
}

/**
 * Cell values of the first visible worksheet that has data, as text, rows in sheet order (missing
 * rows are empty, so row i is spreadsheet row i + 1). Numbers come as Excel stores them ("65000",
 * "0.2"), booleans as TRUE or FALSE, errors as empty. Formulas give their last computed value.
 * Reads no more than `maxRows` rows; `truncated` says there were more.
 */
export function readXlsx(bytes: Uint8Array, maxRows: number): { rows: string[][]; truncated: boolean } {
  const { sheets, shared, files } = openWorkbook(bytes);
  for (const sheet of sheets) {
    const xml = files.get(sheet.path);
    if (!xml) continue;
    const read = readSheetXml(strFromU8(xml), shared, maxRows);
    if (read.rows.some((r) => r.some((c) => c.trim() !== ""))) return read;
  }
  throw new SheetError("Lembar kerja pertama kosong.");
}

/** Every visible worksheet with its name, in workbook order (tests of written workbooks). */
export function readXlsxAll(bytes: Uint8Array, maxRows: number): { name: string; rows: string[][] }[] {
  const { sheets, shared, files } = openWorkbook(bytes);
  return sheets.flatMap((sheet) => {
    const xml = files.get(sheet.path);
    return xml ? [{ name: sheet.name, rows: readSheetXml(strFromU8(xml), shared, maxRows).rows }] : [];
  });
}

/** The workbook's visible sheets (name and part path), shared strings, and parts. */
function openWorkbook(bytes: Uint8Array): {
  sheets: { name: string; path: string }[];
  shared: string[];
  files: Map<string, Uint8Array>;
} {
  const files = unzipLimited(
    bytes,
    (name) =>
      name === "xl/workbook.xml" ||
      name === "xl/_rels/workbook.xml.rels" ||
      name === "xl/sharedStrings.xml" ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(name),
    MAX_XLSX_UNZIPPED,
  );
  const workbook = files.get("xl/workbook.xml");
  const rels = files.get("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new SheetError("Berkas bukan buku kerja Excel (.xlsx).");

  const targets = new Map<string, string>();
  for (const m of strFromU8(rels).matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const id = attr(a, "Id");
    const target = attr(a, "Target");
    if (id && target) targets.set(id, resolveTarget(target));
  }
  const sheets: { name: string; path: string }[] = [];
  for (const m of strFromU8(workbook).matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (attr(a, "state") === "hidden" || attr(a, "state") === "veryHidden") continue;
    const path = targets.get(attr(a, "id") ?? "");
    if (path) sheets.push({ name: xmlText(attr(a, "name") ?? ""), path });
  }

  const shared: string[] = [];
  const sst = files.get("xl/sharedStrings.xml");
  if (sst)
    for (const m of strFromU8(sst).matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g))
      shared.push(runText(m[1]!));

  return { sheets, shared, files };
}

function readSheetXml(xml: string, shared: string[], maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let next = 0;
  for (const m of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const r = attr(attrs(m[1] ?? ""), "r");
    const index = r ? Number(r) - 1 : next;
    next = index + 1;
    if (index >= maxRows) return { rows, truncated: true };
    while (rows.length < index) rows.push([]);
    const cells: string[] = [];
    let col = 0;
    for (const c of (m[2] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const a = attrs(c[1] ?? "");
      const ref = attr(a, "r");
      const at = ref ? columnIndex(ref) : col;
      col = at + 1;
      const body = c[2] ?? "";
      const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      let value: string;
      switch (attr(a, "t")) {
        case "s":
          value = shared[Number(v)] ?? "";
          break;
        case "inlineStr":
          value = runText(/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/.exec(body)?.[1] ?? "");
          break;
        case "b":
          value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
          break;
        case "e":
          value = "";
          break;
        default:
          value = v === undefined ? "" : xmlText(v);
      }
      while (cells.length < at) cells.push("");
      cells[at] = value;
    }
    rows[index] = cells;
  }
  return { rows, truncated: false };
}
