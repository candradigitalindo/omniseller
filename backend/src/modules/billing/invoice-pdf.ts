import { PDFDocument, type PDFFont, type PDFPage, type RGB, rgb } from "pdf-lib";
import { clipText, embedFonts, wrapText } from "../../common/pdf-text";
import type { InvoiceDocument } from "./invoice-document";

/**
 * An invoice as one A4 page (backend doc 8.32, UI L45), drawn with pdf-lib on request in the api: no
 * external data, one page, a few milliseconds. The issuer and the status at the top, who it is billed to
 * beside the dates, the plan and the credit as a table, the total, then the notes.
 */
const MM = 72 / 25.4;
const A4 = { width: 595.28, height: 841.89 } as const;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.4, 0.4, 0.44);
const RULE = rgb(0.82, 0.82, 0.85);
const HEADER_FILL = rgb(0.95, 0.95, 0.96);

const STATUS_COLORS: Record<InvoiceDocument["status"], { fill: RGB; text: RGB }> = {
  paid: { fill: rgb(0.86, 0.95, 0.89), text: rgb(0.06, 0.42, 0.2) },
  pending: { fill: rgb(1, 0.94, 0.8), text: rgb(0.52, 0.33, 0) },
  failed: { fill: rgb(0.99, 0.88, 0.88), text: rgb(0.62, 0.1, 0.1) },
  expired: { fill: rgb(0.93, 0.93, 0.94), text: rgb(0.33, 0.33, 0.36) },
  void: { fill: rgb(0.93, 0.93, 0.94), text: rgb(0.33, 0.33, 0.36) },
};

export async function renderInvoicePdf(d: InvoiceDocument): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Tagihan ${d.number}`);
  doc.setLanguage("id-ID");
  doc.setCreator("OmniSeller");
  doc.setProducer("OmniSeller");
  const f = await embedFonts(doc);
  const page = doc.addPage([A4.width, A4.height]);
  const m = 18 * MM;
  const width = A4.width - 2 * m;
  const right = A4.width - m;
  const top = A4.height - m;

  const write = (text: string, x: number, y: number, size: number, font: PDFFont, color: RGB = INK) =>
    page.drawText(text, { x, y, size, font, color });
  const writeRight = (text: string, xRight: number, y: number, size: number, font: PDFFont, color: RGB = INK) =>
    write(text, xRight - font.widthOfTextAtSize(text, size), y, size, font, color);
  const rule = (y: number) => page.drawLine({ start: { x: m, y }, end: { x: right, y }, thickness: 0.6, color: RULE });

  // ---- the issuer on the left, the title, number, and status on the right ----
  const titleWidth = f.bold.widthOfTextAtSize(d.title, 22);
  const sideWidth = Math.max(titleWidth, 60 * MM);
  const issuerWidth = width - sideWidth - 8 * MM;
  let left = top;
  for (const line of wrapText(f.bold, f.text(d.issuer.name), 14, issuerWidth, 2)) {
    write(line, m, left - 14, 14, f.bold);
    left -= 18;
  }
  left -= 2;
  for (const raw of d.issuer.lines) {
    for (const line of wrapText(f.regular, f.text(raw), 9, issuerWidth, 3)) {
      write(line, m, left - 9, 9, f.regular, MUTED);
      left -= 12.5;
    }
  }

  let side = top;
  writeRight(d.title, right, side - 22, 22, f.bold);
  side -= 30;
  writeRight(clipText(f.bold, f.text(d.number), 11, sideWidth), right, side - 11, 11, f.bold);
  side -= 20;
  drawStatus(page, d, f.bold, right, side);
  side -= 18;

  let y = Math.min(left, side) - 14;
  rule(y);
  y -= 18;

  // ---- billed to on the left, the facts on the right ----
  const factsX = m + width * 0.56;
  const billWidth = factsX - m - 8 * MM;
  let bill = y;
  write("Ditagihkan kepada", m, bill - 8.5, 8.5, f.bold, MUTED);
  bill -= 15;
  for (const line of wrapText(f.bold, f.text(d.billTo.name), 11, billWidth, 2)) {
    write(line, m, bill - 11, 11, f.bold);
    bill -= 14.5;
  }
  bill -= 1;
  for (const raw of d.billTo.lines) {
    for (const line of wrapText(f.regular, f.text(raw), 9.5, billWidth, 2)) {
      write(line, m, bill - 9.5, 9.5, f.regular);
      bill -= 13;
    }
  }

  let facts = y;
  const labelWidth = 32 * MM;
  for (const fact of d.facts) {
    write(f.text(fact.label), factsX, facts - 9, 8.5, f.regular, MUTED);
    const value = clipText(f.bold, f.text(fact.value), 9.5, right - factsX - labelWidth);
    writeRight(value, right, facts - 9, 9.5, f.bold);
    facts -= 15;
  }

  y = Math.min(bill, facts) - 18;

  // ---- the lines ----
  const amountWidth = 38 * MM;
  const textWidth = width - amountWidth - 12;
  page.drawRectangle({ x: m, y: y - 18, width, height: 18, color: HEADER_FILL });
  write("Uraian", m + 6, y - 12.5, 8.5, f.bold, MUTED);
  writeRight("Jumlah", right - 6, y - 12.5, 8.5, f.bold, MUTED);
  y -= 18;
  for (const line of d.lines) {
    y -= 8;
    write(clipText(f.bold, f.text(line.description), 10, textWidth), m + 6, y - 10, 10, f.bold);
    writeRight(f.text(line.amount), right - 6, y - 10, 10, f.regular);
    y -= 14;
    for (const detail of wrapText(f.regular, f.text(line.detail), 8.5, textWidth, 2)) {
      write(detail, m + 6, y - 8.5, 8.5, f.regular, MUTED);
      y -= 12;
    }
    y -= 6;
    rule(y);
  }

  // ---- the totals, under the amounts ----
  y -= 10;
  const totalsX = m + width * 0.56;
  for (const total of d.totals) {
    const size = total.strong ? 12 : 10;
    const font = total.strong ? f.bold : f.regular;
    write(f.text(total.label), totalsX, y - size, size, font, total.strong ? INK : MUTED);
    writeRight(f.text(total.value), right - 6, y - size, size, font);
    y -= size + 8;
  }

  // ---- the notes ----
  y -= 18;
  for (const note of d.notes) {
    for (const line of wrapText(f.regular, f.text(note), 8.5, width, 3)) {
      write(line, m, y - 8.5, 8.5, f.regular, MUTED);
      y -= 12;
    }
    y -= 4;
  }

  return doc.save();
}

/** The status as a pill, its right edge on `xRight`, its top on `y`. */
function drawStatus(page: PDFPage, d: InvoiceDocument, bold: PDFFont, xRight: number, y: number): void {
  const label = d.statusLabel.toUpperCase();
  const size = 8;
  const w = bold.widthOfTextAtSize(label, size) + 14;
  const colors = STATUS_COLORS[d.status];
  page.drawRectangle({ x: xRight - w, y: y - 15, width: w, height: 15, color: colors.fill });
  page.drawText(label, { x: xRight - w + 7, y: y - 10.5, size, font: bold, color: colors.text });
}
