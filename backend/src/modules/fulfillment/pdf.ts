import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFEmbeddedPage, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import type { Barcode } from "../../common/barcode";
import {
  A4_PAGE,
  a4Cells,
  type BarcodeLabelFormat,
  type Box,
  barcodeLabelLayout,
  type LabelStrip,
  labelPlacement,
  MM,
  moduleWidth,
  type PickLine,
  THERMAL_PAGE,
} from "./shipping-plan";

export type { LabelStrip };

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
  /** Pages each input file placed (0 for an unreadable one). */
  pagesPerEntry: number[];
}

export interface LabelEntry {
  /** A label file (the marketplace's or OmniSeller's own) or a packing list. */
  pdf: Uint8Array;
  /** Custom template: drawn under each page of the file, which is scaled down to make room. */
  strip?: LabelStrip | null;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  text: (s: string) => string;
}

async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fonts().regular, { subset: true });
  const bold = await doc.embedFont(fonts().bold, { subset: true });
  const supported = new Set(regular.getCharacterSet());
  return { regular, bold, text: (s: string) => drawable(supported, s) };
}

/**
 * The custom template's area under a label (FR-SHP-16): order number, units, one line per item
 * (quantity, SKU, variant, rack), the buyer's note, and tags, as many lines as fit. The marketplace
 * label above it is not drawn over.
 */
function drawStrip(page: PDFPage, box: Box, strip: LabelStrip, f: Fonts): void {
  const pad = 2 * MM;
  const x = box.x + pad;
  const width = box.width - 2 * pad;
  const top = box.y + box.height;
  page.drawLine({
    start: { x: box.x + pad, y: top - 1 },
    end: { x: box.x + box.width - pad, y: top - 1 },
    thickness: 0.6,
  });
  const units = strip.lines.reduce((n, l) => n + l.qty, 0);
  const count = `${units} barang`;
  page.drawText(count, {
    x: x + width - f.regular.widthOfTextAtSize(count, 7.5),
    y: top - 10,
    size: 7.5,
    font: f.regular,
  });
  page.drawText(clip(f.bold, f.text(strip.orderNumber), 8, width - f.regular.widthOfTextAtSize(count, 7.5) - 6), {
    x,
    y: top - 10,
    size: 8,
    font: f.bold,
  });
  const footer = [
    strip.note ? clip(f.regular, f.text(`Catatan: ${strip.note}`), 7, width) : null,
    strip.tags.length ? clip(f.bold, f.text(`Tag: ${strip.tags.join(", ")}`), 7, width) : null,
  ].filter((l): l is string => l !== null);
  const step = 8.5;
  const room = Math.max(1, Math.floor((top - 14 - (box.y + pad + footer.length * step)) / step));
  const shown = strip.lines.length > room ? strip.lines.slice(0, room - 1) : strip.lines;
  let y = top - 19;
  for (const l of shown) {
    const what = [l.sku, l.variant ? `(${l.variant})` : null].filter(Boolean).join(" ");
    const rack = l.bin ? `Rak ${l.bin}` : "";
    const rackWidth = rack ? f.bold.widthOfTextAtSize(f.text(rack), 7.5) : 0;
    page.drawText(clip(f.regular, f.text(`${l.qty}x  ${what}`), 7.5, width - rackWidth - 4), {
      x,
      y,
      size: 7.5,
      font: f.regular,
    });
    if (rack) page.drawText(f.text(rack), { x: x + width - rackWidth, y, size: 7.5, font: f.bold });
    y -= step;
  }
  if (shown.length < strip.lines.length) {
    page.drawText(`+${strip.lines.length - shown.length} barang lainnya`, {
      x,
      y,
      size: 7,
      font: f.regular,
      color: GRAY,
    });
  }
  let fy = box.y + pad + (footer.length - 1) * step;
  for (const line of footer) {
    page.drawText(line, { x, y: fy, size: 7, font: line.startsWith("Tag") ? f.bold : f.regular });
    fy -= step;
  }
}

/**
 * Label files, in the order given, on 100 x 150 mm thermal pages or four to an A4 sheet with cut lines
 * (FR-SHP-01). Each label keeps its proportions; nothing on it is changed. An entry with a strip (custom
 * template, FR-SHP-16) is scaled into the space above the strip.
 */
export async function composeLabels(
  entries: readonly (Uint8Array | LabelEntry)[],
  format: "thermal" | "a4",
): Promise<ComposedLabels> {
  const out = await PDFDocument.create();
  out.setTitle("Label pengiriman");
  out.setCreator("OmniSeller");
  out.setProducer("OmniSeller");
  const placed: { label: PDFEmbeddedPage; strip: LabelStrip | null }[] = [];
  const unreadable: number[] = [];
  const pagesPerEntry: number[] = [];
  for (const [i, entry] of entries.entries()) {
    const e: LabelEntry = entry instanceof Uint8Array ? { pdf: entry } : entry;
    try {
      const src = await PDFDocument.load(e.pdf, { ignoreEncryption: true, updateMetadata: false });
      const pages = await out.embedPdf(src, src.getPageIndices());
      for (const label of pages) placed.push({ label, strip: e.strip ?? null });
      pagesPerEntry.push(pages.length);
    } catch {
      unreadable.push(i);
      pagesPerEntry.push(0);
    }
  }
  const f = placed.some((p) => p.strip) ? await embedFonts(out) : null;
  const place = (page: PDFPage, item: (typeof placed)[number], box: Box) => {
    const at = labelPlacement(item.label, box, item.strip !== null);
    if (at.strip && item.strip && f) drawStrip(page, at.strip, item.strip, f);
    page.drawPage(item.label, { x: at.label.x, y: at.label.y, xScale: at.label.scale, yScale: at.label.scale });
  };
  if (format === "thermal") {
    for (const item of placed) {
      const page = out.addPage([THERMAL_PAGE.width, THERMAL_PAGE.height]);
      place(page, item, { x: 0, y: 0, ...THERMAL_PAGE });
    }
  } else {
    const cells = a4Cells();
    const pad = 3 * MM;
    for (let i = 0; i < placed.length; i += 4) {
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
      placed.slice(i, i + 4).forEach((item, j) => {
        const cell = cells[j]!;
        place(page, item, {
          x: cell.x + pad,
          y: cell.y + pad,
          width: cell.width - 2 * pad,
          height: cell.height - 2 * pad,
        });
      });
    }
  }
  return { pdf: await out.save(), pages: out.getPageCount(), labels: placed.length, unreadable, pagesPerEntry };
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

export interface ManualLabel {
  number: string;
  orderedAt: Date;
  /** The business, printed above the order number. */
  business: string;
  /** The order's warehouse (FR-WHS-08): who answers there, phone, address. */
  sender: { name: string; phone: string | null; address: string };
  recipient: { name: string; phone: string | null; address: string };
  /** "J&T Express · Reguler" */
  courier: string | null;
  trackingNumber: string | null;
  /** Amount the courier collects; null for orders paid already. */
  cod: number | null;
  items: { sku: string; name: string; qty: number }[];
  weightG: number | null;
  note: string | null;
}

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const day = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** Words laid into lines no wider than `width`; the last allowed line ends with "…" when text remains. */
function wrap(font: PDFFont, text: string, size: number, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  const words = text.split(" ").filter(Boolean);
  for (const [i, word] of words.entries()) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) {
      lines[maxLines - 1] = clip(font, `${lines[maxLines - 1]} ${words.slice(i).join(" ")}`, size, width);
      return lines;
    }
  }
  if (line) lines.push(lines.length === maxLines ? "" : line);
  return lines.filter(Boolean).map((l) => clip(font, l, size, width));
}

/**
 * The address label of a manual order (FR-ORD-09, FR-WHS-08), 100 x 150 mm: order number, courier and
 * tracking number, the amount to collect for COD, recipient, the sender as the order's warehouse, and
 * what is in the parcel. Marketplace orders use the marketplace's own label instead.
 */
export async function renderManualLabel(label: ManualLabel): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`Label ${label.number}`);
  doc.setCreator("OmniSeller");
  doc.setProducer("OmniSeller");
  const regular = await doc.embedFont(fonts().regular, { subset: true });
  const bold = await doc.embedFont(fonts().bold, { subset: true });
  const supported = new Set(regular.getCharacterSet());
  const t = (s: string) => drawable(supported, s);
  const page = doc.addPage([THERMAL_PAGE.width, THERMAL_PAGE.height]);
  const m = 3 * MM;
  const width = THERMAL_PAGE.width - 2 * m;
  let y = THERMAL_PAGE.height - m;
  const rule = () => {
    page.drawLine({ start: { x: m, y }, end: { x: m + width, y }, thickness: 0.8, color: BLACK });
    y -= 6;
  };
  const right = (text: string, font: PDFFont, size: number, at: number, color = BLACK) =>
    page.drawText(text, { x: m + width - font.widthOfTextAtSize(text, size), y: at, size, font, color });

  // header: business and order number, courier and date
  const number = t(label.number);
  right(number, bold, 11, y - 11);
  const leftWidth = width - bold.widthOfTextAtSize(number, 11) - 8;
  page.drawText(clip(bold, t(label.business), 10, leftWidth), { x: m, y: y - 11, size: 10, font: bold });
  y -= 24;
  right(day.format(label.orderedAt), regular, 8, y, GRAY);
  if (label.courier) page.drawText(clip(regular, t(label.courier), 9, leftWidth), { x: m, y, size: 9, font: regular });
  y -= 8;
  rule();

  if (label.trackingNumber) {
    page.drawText("Resi", { x: m, y: y - 8, size: 7.5, font: regular, color: GRAY });
    page.drawText(clip(bold, t(label.trackingNumber), 15, width), { x: m, y: y - 24, size: 15, font: bold });
    y -= 32;
  }

  // what the courier collects
  const box = 24;
  if (label.cod !== null) {
    page.drawRectangle({ x: m, y: y - box, width, height: box, color: BLACK });
    const text = `COD  Rp${label.cod.toLocaleString("id-ID")}`;
    page.drawText(text, {
      x: m + (width - bold.widthOfTextAtSize(text, 14)) / 2,
      y: y - 17,
      size: 14,
      font: bold,
      color: WHITE,
    });
  } else {
    page.drawRectangle({ x: m, y: y - box, width, height: box, borderColor: BLACK, borderWidth: 1 });
    const text = "NON-COD";
    page.drawText(text, { x: m + (width - bold.widthOfTextAtSize(text, 11)) / 2, y: y - 16, size: 11, font: bold });
  }
  y -= box + 10;

  // recipient
  page.drawText("PENERIMA", { x: m, y: y - 7, size: 7.5, font: bold, color: GRAY });
  y -= 20;
  page.drawText(clip(bold, t(label.recipient.name), 12, width), { x: m, y, size: 12, font: bold });
  y -= 14;
  if (label.recipient.phone) {
    page.drawText(t(label.recipient.phone), { x: m, y, size: 10, font: regular });
    y -= 13;
  }
  for (const line of wrap(regular, t(label.recipient.address), 9.5, width, 5)) {
    page.drawText(line, { x: m, y, size: 9.5, font: regular });
    y -= 12;
  }
  y -= 2;
  rule();

  // sender: the order's warehouse
  page.drawText("PENGIRIM", { x: m, y: y - 7, size: 7.5, font: bold, color: GRAY });
  y -= 18;
  const sender = [label.sender.name, label.sender.phone].filter(Boolean).join(" · ");
  page.drawText(clip(bold, t(sender), 9.5, width), { x: m, y, size: 9.5, font: bold });
  y -= 11;
  for (const line of wrap(regular, t(label.sender.address), 8.5, width, 3)) {
    page.drawText(line, { x: m, y, size: 8.5, font: regular });
    y -= 10.5;
  }
  y -= 2;
  rule();

  // what is in the parcel, as many lines as fit above the footer
  const units = label.items.reduce((n, i) => n + i.qty, 0);
  page.drawText(`ISI PAKET (${units} barang)`, { x: m, y: y - 7, size: 7.5, font: bold, color: GRAY });
  y -= 18;
  const footer = m + (label.note ? 34 : 12);
  const fits = Math.max(1, Math.floor((y - footer) / 10.5));
  const shown = label.items.length > fits ? label.items.slice(0, fits - 1) : label.items;
  for (const i of shown) {
    page.drawText(clip(regular, t(`${i.qty}x  ${i.sku}  ${i.name}`), 8.5, width), {
      x: m,
      y,
      size: 8.5,
      font: regular,
    });
    y -= 10.5;
  }
  if (shown.length < label.items.length) {
    page.drawText(`+${label.items.length - shown.length} baris lainnya`, {
      x: m,
      y,
      size: 8.5,
      font: regular,
      color: GRAY,
    });
  }

  // footer: weight and the buyer's note
  let fy = m + 2;
  if (label.weightG) {
    const kg = `Berat ± ${(label.weightG / 1000).toLocaleString("id-ID", { maximumFractionDigits: 2 })} kg`;
    right(kg, regular, 8, fy, GRAY);
  }
  if (label.note) {
    fy += 10;
    for (const line of wrap(regular, t(`Catatan: ${label.note}`), 8, width, 2).reverse()) {
      page.drawText(line, { x: m, y: fy, size: 8, font: regular });
      fy += 10;
    }
  }
  return doc.save();
}

export interface PackingList {
  number: string;
  /** "Shopee · Toko Utama" */
  source: string;
  orderedAt: Date;
  courier: string | null;
  trackingNumber: string | null;
  /** The buyer's name and destination city: enough to match the parcel, without the full address. */
  buyer: string | null;
  destination: string | null;
  lines: { qty: number; sku: string; name: string; variant: string | null; bin: string | null }[];
  note: string | null;
  tags: string[];
}

/**
 * One order's packing list (FR-SHP-03) on 100 x 150 mm pages: what goes in the parcel with a box to
 * tick per line, the rack, the buyer's note, and who packed and checked it. Long orders continue on the
 * next page. Printed alone or right after the order's label.
 */
export async function renderPackingList(list: PackingList): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Daftar kemas ${list.number}`);
  doc.setCreator("OmniSeller");
  doc.setProducer("OmniSeller");
  const f = await embedFonts(doc);
  const m = 4 * MM;
  const width = THERMAL_PAGE.width - 2 * m;
  const bottomOfLines = m + 58;
  let page!: PDFPage;
  let y = 0;
  const header = (continued: boolean) => {
    page = doc.addPage([THERMAL_PAGE.width, THERMAL_PAGE.height]);
    y = THERMAL_PAGE.height - m;
    const title = continued ? "DAFTAR KEMAS (lanjutan)" : "DAFTAR KEMAS";
    page.drawText(title, { x: m, y: y - 12, size: 11, font: f.bold });
    const number = f.text(list.number);
    page.drawText(number, { x: m + width - f.bold.widthOfTextAtSize(number, 11), y: y - 12, size: 11, font: f.bold });
    y -= 26;
    if (continued) return;
    const meta = [
      `${list.source} · ${day.format(list.orderedAt)}`,
      [list.courier, list.trackingNumber ? `Resi ${list.trackingNumber}` : null].filter(Boolean).join(" · "),
      [list.buyer, list.destination].filter(Boolean).join(" · "),
    ].filter((l) => l.trim() !== "");
    for (const line of meta) {
      page.drawText(clip(f.regular, f.text(line), 8.5, width), { x: m, y, size: 8.5, font: f.regular });
      y -= 11;
    }
    y -= 2;
  };
  const tableHead = () => {
    page.drawRectangle({ x: m, y: y - 13, width, height: 13, color: HEADER_FILL });
    page.drawText("Jml", { x: m + 15, y: y - 9.5, size: 7.5, font: f.bold });
    page.drawText("Barang", { x: m + 38, y: y - 9.5, size: 7.5, font: f.bold });
    const rack = "Rak";
    page.drawText(rack, {
      x: m + width - f.bold.widthOfTextAtSize(rack, 7.5) - 3,
      y: y - 9.5,
      size: 7.5,
      font: f.bold,
    });
    y -= 15;
  };

  header(false);
  tableHead();
  for (const [i, line] of list.lines.entries()) {
    // the last line keeps the total under it, clear of the note below
    if (y - (i === list.lines.length - 1 ? 34 : 22) < bottomOfLines) {
      header(true);
      tableHead();
    }
    page.drawRectangle({ x: m + 2, y: y - 11, width: 8, height: 8, borderColor: GRAY, borderWidth: 0.8 });
    const qty = String(line.qty);
    page.drawText(qty, { x: m + 31 - f.bold.widthOfTextAtSize(qty, 10), y: y - 10.5, size: 10, font: f.bold });
    const rack = line.bin ? f.text(line.bin) : "-";
    const rackWidth = f.bold.widthOfTextAtSize(rack, 8.5);
    const textWidth = width - 38 - rackWidth - 8;
    page.drawText(clip(f.regular, f.text(line.sku), 8, textWidth), { x: m + 38, y: y - 9, size: 8, font: f.regular });
    const name = [line.name, line.variant].filter(Boolean).join(" · ");
    page.drawText(clip(f.regular, f.text(name), 7.5, textWidth), {
      x: m + 38,
      y: y - 18,
      size: 7.5,
      font: f.regular,
      color: GRAY,
    });
    page.drawText(rack, { x: m + width - rackWidth - 3, y: y - 9.5, size: 8.5, font: f.bold });
    y -= 22;
    page.drawLine({ start: { x: m, y: y + 1 }, end: { x: m + width, y: y + 1 }, thickness: 0.3, color: LIGHT });
  }
  const units = list.lines.reduce((n, l) => n + l.qty, 0);
  page.drawText(`${units} barang, ${list.lines.length} baris`, { x: m, y: y - 9, size: 8, font: f.bold });

  // footer of the last page: the buyer's note, tags, and signatures
  let fy = m + 46;
  if (list.note) {
    for (const line of wrap(f.regular, f.text(`Catatan pembeli: ${list.note}`), 7.5, width, 3)) {
      page.drawText(line, { x: m, y: fy, size: 7.5, font: f.regular });
      fy -= 9.5;
    }
  }
  if (list.tags.length) {
    page.drawText(clip(f.bold, f.text(`Tag: ${list.tags.join(", ")}`), 7.5, width), {
      x: m,
      y: m + 18,
      size: 7.5,
      font: f.bold,
    });
  }
  page.drawText("Dikemas: ____________   Dicek: ____________", {
    x: m,
    y: m + 4,
    size: 7.5,
    font: f.regular,
    color: GRAY,
  });
  const pages = doc.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const label = `${i + 1}/${pages.length}`;
      p.drawText(label, {
        x: m + width - f.regular.widthOfTextAtSize(label, 7),
        y: m + 4,
        size: 7,
        font: f.regular,
        color: GRAY,
      });
    });
  }
  return doc.save();
}

export interface BarcodeLabel {
  /** Product name. */
  title: string;
  /** Variant name, and the SKU when the bars hold the barcode. */
  subtitle: string;
  barcode: Barcode;
}

/**
 * Internal barcode labels (FR-PRD-12): product, variant, the bars, and what they hold, on label stock or
 * A4 sheets (`barcodeLabelLayout`). Bars are drawn as rectangles in whole printer dots
 * (`moduleWidth`), centred with their quiet zones. Returns the labels whose bars came out dense.
 */
export async function renderBarcodeLabels(
  labels: readonly BarcodeLabel[],
  format: BarcodeLabelFormat,
): Promise<{ pdf: Uint8Array; pages: number; dense: number[] }> {
  const doc = await PDFDocument.create();
  doc.setTitle("Label barcode");
  doc.setCreator("OmniSeller");
  doc.setProducer("OmniSeller");
  const f = await embedFonts(doc);
  const layout = barcodeLabelLayout(format);
  const dense: number[] = [];
  let page: PDFPage | undefined;
  for (const [i, label] of labels.entries()) {
    const slot = i % layout.cells.length;
    if (slot === 0 || !page) page = doc.addPage([layout.page.width, layout.page.height]);
    if (drawBarcodeLabel(page, layout.cells[slot]!, label, f)) dense.push(i);
  }
  return { pdf: await doc.save(), pages: doc.getPageCount(), dense };
}

function drawBarcodeLabel(page: PDFPage, box: Box, label: BarcodeLabel, f: Fonts): boolean {
  const pad = 1.5 * MM;
  const x = box.x + pad;
  const width = box.width - 2 * pad;
  let y = box.y + box.height - pad;
  page.drawText(clip(f.bold, f.text(label.title), 7.5, width), { x, y: y - 7.5, size: 7.5, font: f.bold });
  y -= 7.5 + 1.5;
  if (label.subtitle) {
    page.drawText(clip(f.regular, f.text(label.subtitle), 6.5, width), { x, y: y - 6.5, size: 6.5, font: f.regular });
    y -= 6.5 + 2;
  }
  const b = label.barcode;
  const { module, dense } = moduleWidth(b.modules + b.quiet.left + b.quiet.right, width);
  const textSize = 7;
  const bottom = box.y + pad + textSize + 1.5;
  const left = x + (width - (b.modules + b.quiet.left + b.quiet.right) * module) / 2 + b.quiet.left * module;
  for (const bar of b.bars) {
    page.drawRectangle({
      x: left + bar.x * module,
      y: bottom,
      width: bar.w * module,
      height: y - 1 - bottom,
      color: BLACK,
    });
  }
  const text = clip(f.regular, f.text(b.text), textSize, width);
  page.drawText(text, {
    x: x + (width - f.regular.widthOfTextAtSize(text, textSize)) / 2,
    y: box.y + pad,
    size: textSize,
    font: f.regular,
  });
  return dense;
}

/** A stand-in for a marketplace label, for the template's test print (UI L42 "Cetak percobaan"). */
export async function sampleMarketplaceLabel(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const f = await embedFonts(doc);
  const page = doc.addPage([105 * MM, 148 * MM]);
  const { width, height } = page.getSize();
  page.drawRectangle({ x: 6, y: 6, width: width - 12, height: height - 12, borderColor: GRAY, borderWidth: 1.2 });
  const title = "Label resmi marketplace";
  page.drawText(title, {
    x: (width - f.bold.widthOfTextAtSize(title, 13)) / 2,
    y: height / 2 + 8,
    size: 13,
    font: f.bold,
  });
  const hint = "Contoh. Isi label asli tidak diubah.";
  page.drawText(hint, {
    x: (width - f.regular.widthOfTextAtSize(hint, 9)) / 2,
    y: height / 2 - 10,
    size: 9,
    font: f.regular,
    color: GRAY,
  });
  return doc.save();
}
