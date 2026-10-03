import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFEmbeddedPage, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import { A4_PAGE, a4Cells, fitInto, MM, type PickLine, THERMAL_PAGE } from "./shipping-plan";

/**
 * PDF documents of the fulfillment module (technology doc 13, ADR-038), drawn with pdf-lib in the
 * worker: marketplace labels merged onto thermal or A4 pages, and the pick list as a table. Noto Sans
 * is bundled in assets/fonts (SIL Open Font License).
 */
const FONT_DIR = resolve(__dirname, "../../../assets/fonts");

let fontFiles: { regular: Uint8Array; bold: Uint8Array } | undefined;
function fonts() {
  fontFiles ??= {
    regular: readFileSync(join(FONT_DIR, "NotoSans-Regular.ttf")),
    bold: readFileSync(join(FONT_DIR, "NotoSans-Bold.ttf")),
  };
  return fontFiles;
}

const GRAY = rgb(0.45, 0.45, 0.45);
const LIGHT = rgb(0.8, 0.8, 0.8);
const HEADER_FILL = rgb(0.93, 0.93, 0.93);

export interface ComposedLabels {
  pdf: Uint8Array;
  pages: number;
  /** Label pages placed (a label file may hold more than one page). */
  labels: number;
  /** Indexes of input files that could not be read as PDF. */
  unreadable: number[];
}

/**
 * Marketplace label files, in the order given, on 100 x 150 mm thermal pages or four to an A4 sheet
 * with cut lines (FR-SHP-01). Each label keeps its proportions; nothing on it is changed.
 */
export async function composeLabels(files: Uint8Array[], format: "thermal" | "a4"): Promise<ComposedLabels> {
  const out = await PDFDocument.create();
  out.setTitle("Label pengiriman");
  out.setCreator("OmniSeller");
  out.setProducer("OmniSeller");
  const labels: PDFEmbeddedPage[] = [];
  const unreadable: number[] = [];
  for (const [i, bytes] of files.entries()) {
    try {
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      labels.push(...(await out.embedPdf(src, src.getPageIndices())));
    } catch {
      unreadable.push(i);
    }
  }
  if (format === "thermal") {
    for (const label of labels) {
      const page = out.addPage([THERMAL_PAGE.width, THERMAL_PAGE.height]);
      const f = fitInto(label, { x: 0, y: 0, ...THERMAL_PAGE });
      page.drawPage(label, { x: f.x, y: f.y, xScale: f.scale, yScale: f.scale });
    }
  } else {
    const cells = a4Cells();
    const pad = 3 * MM;
    for (let i = 0; i < labels.length; i += 4) {
      const page = out.addPage([A4_PAGE.width, A4_PAGE.height]);
      const dash = { thickness: 0.4, color: LIGHT, dashArray: [4, 4] };
      page.drawLine({
        start: { x: A4_PAGE.width / 2, y: 0 },
        end: { x: A4_PAGE.width / 2, y: A4_PAGE.height },
        ...dash,
      });
      page.drawLine({
        start: { x: 0, y: A4_PAGE.height / 2 },
        end: { x: A4_PAGE.width, y: A4_PAGE.height / 2 },
        ...dash,
      });
      labels.slice(i, i + 4).forEach((label, j) => {
        const cell = cells[j]!;
        const f = fitInto(label, {
          x: cell.x + pad,
          y: cell.y + pad,
          width: cell.width - 2 * pad,
          height: cell.height - 2 * pad,
        });
        page.drawPage(label, { x: f.x, y: f.y, xScale: f.scale, yScale: f.scale });
      });
    }
  }
  return { pdf: await out.save(), pages: out.getPageCount(), labels: labels.length, unreadable };
}

export interface PickSection {
  warehouse: string;
  orders: number;
  lines: PickLine[];
}

const jakarta = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Text the font can draw: other characters (emoji, CJK) are dropped, whitespace is one space. */
function drawable(supported: Set<number>, text: string): string {
  let out = "";
  for (const ch of text.replace(/\s+/g, " ")) if (supported.has(ch.codePointAt(0)!)) out += ch;
  return out.trim();
}

function clip(font: PDFFont, text: string, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(`${text.slice(0, mid)}…`, size) <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/**
 * The pick list (FR-SHP-02): one section per warehouse, starting on its own page, lines sorted by rack
 * with a box to tick, the units to take, and how many orders need them.
 */
export async function renderPickList(input: {
  generatedAt: Date;
  sections: PickSection[];
}): Promise<{ pdf: Uint8Array; pages: number }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle("Daftar ambil");
  doc.setCreator("OmniSeller");
  doc.setProducer("OmniSeller");
  const regular = await doc.embedFont(fonts().regular, { subset: true });
  const bold = await doc.embedFont(fonts().bold, { subset: true });
  const supported = new Set(regular.getCharacterSet());
  const text = (s: string) => drawable(supported, s);

  const margin = 15 * MM;
  const width = A4_PAGE.width - 2 * margin;
  const columns = [
    { key: "check", title: "", width: 9 * MM },
    { key: "bin", title: "Rak", width: 28 * MM },
    { key: "sku", title: "SKU", width: 42 * MM },
    { key: "name", title: "Produk", width: width - (9 + 28 + 42 + 18 + 18) * MM },
    { key: "qty", title: "Jumlah", width: 18 * MM },
    { key: "orders", title: "Pesanan", width: 18 * MM },
  ] as const;
  const xOf = (i: number) => margin + columns.slice(0, i).reduce((n, c) => n + c.width, 0);
  const when = jakarta.format(input.generatedAt);

  let page: PDFPage;
  let y = 0;
  const tableHeader = () => {
    page.drawRectangle({ x: margin, y: y - 16, width, height: 16, color: HEADER_FILL });
    columns.forEach((c, i) => {
      if (!c.title) return;
      const w = bold.widthOfTextAtSize(c.title, 8.5);
      const x = c.key === "qty" || c.key === "orders" ? xOf(i) + c.width - w - 4 : xOf(i) + 4;
      page.drawText(c.title, { x, y: y - 11.5, size: 8.5, font: bold });
    });
    y -= 16;
  };

  const sections = input.sections.length > 0 ? input.sections : [{ warehouse: "-", orders: 0, lines: [] }];
  for (const section of sections) {
    page = doc.addPage([A4_PAGE.width, A4_PAGE.height]);
    y = A4_PAGE.height - margin;
    page.drawText("Daftar Ambil", { x: margin, y: y - 16, size: 16, font: bold });
    const units = section.lines.reduce((n, l) => n + l.qty, 0);
    const subtitle = text(`${section.warehouse} · ${section.orders} pesanan · ${units} barang · ${when} WIB`);
    page.drawText(clip(regular, subtitle, 9.5, width), { x: margin, y: y - 31, size: 9.5, font: regular, color: GRAY });
    y -= 44;
    tableHeader();
    for (const line of section.lines) {
      const variant = line.variantName ? text(line.variantName) : "";
      const rowHeight = variant ? 26 : 18;
      if (y - rowHeight < margin + 14) {
        page = doc.addPage([A4_PAGE.width, A4_PAGE.height]);
        y = A4_PAGE.height - margin;
        tableHeader();
      }
      const top = y;
      page.drawRectangle({ x: xOf(0) + 2, y: top - 13, width: 9, height: 9, borderColor: GRAY, borderWidth: 0.8 });
      page.drawText(clip(bold, text(line.bin ?? "-"), 9.5, columns[1].width - 8), {
        x: xOf(1) + 4,
        y: top - 12,
        size: 9.5,
        font: bold,
      });
      page.drawText(clip(regular, text(line.sku), 9, columns[2].width - 8), {
        x: xOf(2) + 4,
        y: top - 12,
        size: 9,
        font: regular,
      });
      page.drawText(clip(regular, text(line.name), 9, columns[3].width - 8), {
        x: xOf(3) + 4,
        y: top - 12,
        size: 9,
        font: regular,
      });
      if (variant) {
        page.drawText(clip(regular, variant, 8, columns[3].width - 8), {
          x: xOf(3) + 4,
          y: top - 22,
          size: 8,
          font: regular,
          color: GRAY,
        });
      }
      const qty = String(line.qty);
      page.drawText(qty, {
        x: xOf(4) + columns[4].width - bold.widthOfTextAtSize(qty, 11) - 4,
        y: top - 12.5,
        size: 11,
        font: bold,
      });
      const orders = String(line.orders);
      page.drawText(orders, {
        x: xOf(5) + columns[5].width - regular.widthOfTextAtSize(orders, 9) - 4,
        y: top - 12,
        size: 9,
        font: regular,
      });
      y -= rowHeight;
      page.drawLine({ start: { x: margin, y }, end: { x: margin + width, y }, thickness: 0.4, color: LIGHT });
    }
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `Halaman ${i + 1}/${pages.length}`;
    p.drawText(label, {
      x: A4_PAGE.width - margin - regular.widthOfTextAtSize(label, 8),
      y: margin / 2,
      size: 8,
      font: regular,
      color: GRAY,
    });
  });
  return { pdf: await doc.save(), pages: pages.length };
}
