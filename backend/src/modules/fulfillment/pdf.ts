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
