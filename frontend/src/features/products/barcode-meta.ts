import type { components } from "@/lib/api/schema";

export type LabelFormat = components["schemas"]["RequestBarcodeLabelsDto"]["format"];

/** The label stock of barcode printers, and A4 sheets of 30 (backend 8.24, FR-PRD-12). */
export const LABEL_FORMATS = ["label_50x30", "label_40x30", "a4_3x10"] as const satisfies readonly LabelFormat[];

/** At most this many labels per variant and per document (backend `RequestBarcodeLabelsDto`). */
export const MAX_COPIES = 500;
export const MAX_LABELS = 2_000;

const WHOLE = /^\d+$/;

/** Copies as typed: a whole number from 0 (skip this variant) to 500; empty counts as 0. */
export function copiesOf(text: string): number | null {
  const typed = text.trim();
  if (typed === "") return 0;
  if (!WHOLE.test(typed)) return null;
  const n = Number(typed);
  return n <= MAX_COPIES ? n : null;
}

/** The lines to send: variants with at least one label, in the order shown. */
export function labelItems(
  variantIds: readonly string[],
  copies: Readonly<Record<string, string>>,
): { variantId: string; copies: number }[] {
  return variantIds.flatMap((variantId) => {
    const n = copiesOf(copies[variantId] ?? "");
    return n !== null && n > 0 ? [{ variantId, copies: n }] : [];
  });
}

/** Variants whose count cannot be read, and whether the whole document stays within 2,000 labels. */
export function labelProblems(
  variantIds: readonly string[],
  copies: Readonly<Record<string, string>>,
): { invalid: string[]; total: number; tooMany: boolean } {
  const invalid = variantIds.filter((id) => copiesOf(copies[id] ?? "") === null);
  const total = labelItems(variantIds, copies).reduce((n, i) => n + i.copies, 0);
  return { invalid, total, tooMany: total > MAX_LABELS };
}
