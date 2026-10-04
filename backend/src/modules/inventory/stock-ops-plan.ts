/**
 * Stock count and transfer decisions as pure functions (backend doc 8.27, PRD FR-STK-08, 09): document
 * numbers, what applying a counted line moves, and what a transfer's lines must hold. The services load
 * data, call these, and write the result.
 */

export interface Problem {
  path: string;
  message: string;
}

/** OP-YYMM-NNNN: stock counts numbered per month in the business's time zone. */
export const stockCountNumber = (period: string, n: number): string => `OP-${period}-${String(n).padStart(4, "0")}`;

/** TF-YYMM-NNNN: stock transfers numbered per month in the business's time zone. */
export const stockTransferNumber = (period: string, n: number): string => `TF-${period}-${String(n).padStart(4, "0")}`;

/** Lines one count may list; a bigger warehouse is counted rack by rack (partial counts). */
export const MAX_COUNT_LINES = 20_000;

/** Lines one transfer may carry. */
export const MAX_TRANSFER_LINES = 500;

/**
 * How far applying a counted line moves the stock: the difference between the count and the quantity on
 * hand when it was counted, so what shipped or arrived after the count is kept. Never below zero now: if
 * stock left after a count that found less, the move is smaller (the count was short anyway).
 */
export function countApplyDelta(counted: number, expected: number, onHandNow: number): number {
  return Math.max(counted - expected, -onHandNow) || 0;
}

/** A count answer: `set` replaces what was counted, `add` adds scanned units to it. */
export interface CountEntry {
  variantId: string;
  qty: number;
  mode: "set" | "add";
}

/** Each variant at most once per request; quantities whole and not negative (checked by the DTO). */
export function countEntryProblems(entries: readonly CountEntry[]): Problem[] {
  const seen = new Set<string>();
  const out: Problem[] = [];
  entries.forEach((e, i) => {
    if (seen.has(e.variantId)) out.push({ path: `lines.${i}.variantId`, message: "SKU ini disebut dua kali." });
    seen.add(e.variantId);
  });
  return out;
}

export interface TransferLineInput {
  variantId: string;
  qty: number;
}

/** A transfer carries something, each variant once. */
export function transferLineProblems(lines: readonly TransferLineInput[]): Problem[] {
  if (lines.length === 0) return [{ path: "lines", message: "Isi paling sedikit satu SKU." }];
  const seen = new Set<string>();
  const out: Problem[] = [];
  lines.forEach((l, i) => {
    if (seen.has(l.variantId)) out.push({ path: `lines.${i}.variantId`, message: "SKU ini disebut dua kali." });
    seen.add(l.variantId);
  });
  return out;
}

/**
 * A receipt answers every line of the transfer once, with no more than was sent. Lines left out of the
 * receipt arrived in full.
 */
export function receiptLines(
  lines: readonly { id: string; qty: number }[],
  input: readonly { lineId: string; receivedQty: number }[],
): { problems: Problem[]; received: Map<string, number> } {
  const problems: Problem[] = [];
  const received = new Map<string, number>();
  input.forEach((r, i) => {
    const line = lines.find((l) => l.id === r.lineId);
    if (!line) {
      problems.push({ path: `lines.${i}.lineId`, message: "Baris ini bukan bagian dari transfer." });
      return;
    }
    if (received.has(line.id)) {
      problems.push({ path: `lines.${i}.lineId`, message: "Baris ini disebut dua kali." });
      return;
    }
    if (r.receivedQty > line.qty) {
      problems.push({ path: `lines.${i}.receivedQty`, message: `Paling banyak ${line.qty}, sebanyak yang dikirim.` });
      return;
    }
    received.set(line.id, r.receivedQty);
  });
  for (const l of lines) if (!received.has(l.id)) received.set(l.id, l.qty);
  return { problems, received };
}
