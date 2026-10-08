import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";

/**
 * Text in documents drawn with pdf-lib (technology doc 13, ADR-038): Noto Sans, bundled in assets/fonts
 * (SIL Open Font License), embedded as a subset, and text fitted to a width. Shipping labels, lists, and
 * manifests (fulfillment) and invoices (billing) use it.
 */
const FONT_DIR = resolve(__dirname, "../../assets/fonts");

let fontFiles: { regular: Uint8Array; bold: Uint8Array } | undefined;
function fontBytes() {
  fontFiles ??= {
    regular: readFileSync(join(FONT_DIR, "NotoSans-Regular.ttf")),
    bold: readFileSync(join(FONT_DIR, "NotoSans-Bold.ttf")),
  };
  return fontFiles;
}

export interface PdfFonts {
  regular: PDFFont;
  bold: PDFFont;
  /** The text as the fonts can draw it (see `drawable`). */
  text: (s: string) => string;
}

/** Noto Sans regular and bold in the document, each as a subset of the characters drawn. */
export async function embedFonts(doc: PDFDocument): Promise<PdfFonts> {
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fontBytes().regular, { subset: true });
  const bold = await doc.embedFont(fontBytes().bold, { subset: true });
  const supported = new Set(regular.getCharacterSet());
  return { regular, bold, text: (s: string) => drawable(supported, s) };
}

/** Text the font can draw: other characters (emoji, CJK) are dropped, whitespace is one space. */
export function drawable(supported: Set<number>, text: string): string {
  let out = "";
  for (const ch of text.replace(/\s+/g, " ")) if (supported.has(ch.codePointAt(0)!)) out += ch;
  return out.trim();
}

/** The text cut to fit `width`, ending with "…" when cut. */
export function clipText(font: PDFFont, text: string, size: number, width: number): string {
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

/** Words laid into lines no wider than `width`; the last allowed line ends with "…" when text remains. */
export function wrapText(font: PDFFont, text: string, size: number, width: number, maxLines: number): string[] {
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
      lines[maxLines - 1] = clipText(font, `${lines[maxLines - 1]} ${words.slice(i).join(" ")}`, size, width);
      return lines;
    }
  }
  if (line) lines.push(lines.length === maxLines ? "" : line);
  return lines.filter(Boolean).map((l) => clipText(font, l, size, width));
}
