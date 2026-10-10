import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";

export type PackingView = components["schemas"]["PackingViewDto_Output"];
export type PackLine = PackingView["lines"][number];
export type DocumentView = components["schemas"]["DocumentDto_Output"];
export type PrintJob = components["schemas"]["PrintJobPageDto_Output"]["items"][number];
export type PrintAgent = components["schemas"]["PrintAgentListDto_Output"]["items"][number];
export type Handover = components["schemas"]["HandoverDetailDto_Output"];

export const JOB_TONE: Record<PrintJob["status"], Tone> = {
  queued: "neutral",
  sent: "info",
  printed: "success",
  failed: "danger",
  cancelled: "neutral",
};

/**
 * The line a scanned code belongs to: its barcode, its SKU (case ignored, as the api does), or its line
 * key. Null for a code that is not in the order.
 */
export function lineOf(lines: readonly PackLine[], code: string): PackLine | null {
  const c = code.trim().toLowerCase();
  if (!c) return null;
  return (
    lines.find((l) => l.barcode?.toLowerCase() === c) ??
    lines.find((l) => l.sku.toLowerCase() === c) ??
    lines.find((l) => l.key.toLowerCase() === c) ??
    null
  );
}

export type ScanOutcome = "counted" | "unknown" | "complete";

/**
 * One scan at the packing station (L06): counts the unit on its line, or says why not (not in the order,
 * or the line already has every unit). Returns the new counts.
 */
export function scanUnit(
  lines: readonly PackLine[],
  counts: Readonly<Record<string, number>>,
  code: string,
): { outcome: ScanOutcome; line: PackLine | null; counts: Record<string, number> } {
  const line = lineOf(lines, code);
  if (!line) return { outcome: "unknown", line: null, counts: { ...counts } };
  const now = counts[line.key] ?? 0;
  if (now >= line.qty) return { outcome: "complete", line, counts: { ...counts } };
  return { outcome: "counted", line, counts: { ...counts, [line.key]: now + 1 } };
}

/** Every line has exactly its units: "Cetak label dan lanjut" unlocks (the api checks the same). */
export function packed(lines: readonly PackLine[], counts: Readonly<Record<string, number>>): boolean {
  return lines.length > 0 && lines.every((l) => (counts[l.key] ?? 0) === l.qty);
}

/** What the station sends: one entry per line, by its key, with the units counted. */
export function packingScans(lines: readonly PackLine[], counts: Readonly<Record<string, number>>) {
  return lines.flatMap((l) => {
    const qty = counts[l.key] ?? 0;
    return qty > 0 ? [{ code: l.key, qty }] : [];
  });
}

/** The api's longest packing time, a day; a station left open longer still sends a day. */
export const MAX_PACK_SECONDS = 86_400;

/**
 * Whole seconds from scanning the order to finishing it, from two `performance.now()` readings (the team
 * report's minutes per order, FR-RPT-10). The station's own clock, so a wrong system time does not matter.
 */
export function packSeconds(startMs: number, endMs: number): number {
  return Math.min(MAX_PACK_SECONDS, Math.max(0, Math.round((endMs - startMs) / 1000)));
}

/** A document is done once it is ready or failed; until then its page polls it. */
export function documentDone(d: Pick<DocumentView, "status"> | undefined): boolean {
  return d?.status === "ready" || d?.status === "failed";
}

export type PrintSettings = {
  /** "" downloads the PDF instead of sending it to a print agent */
  deviceId: string;
  format: "thermal" | "a4";
  template: "standard" | "custom";
  packingList: boolean;
};

export const DEFAULT_PRINT: PrintSettings = {
  deviceId: "",
  format: "thermal",
  template: "standard",
  packingList: false,
};

const STORAGE_KEY = "omniseller.print";

/**
 * The station's print choices, kept in this browser only: each packing PC has its own printer. Storage can
 * be missing or refused (private windows); the defaults then apply.
 */
export function loadPrintSettings(): PrintSettings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PRINT;
    const v = JSON.parse(raw) as Partial<PrintSettings>;
    return {
      deviceId: typeof v.deviceId === "string" ? v.deviceId : "",
      format: v.format === "a4" ? "a4" : "thermal",
      template: v.template === "custom" ? "custom" : "standard",
      packingList: v.packingList === true,
    };
  } catch {
    return DEFAULT_PRINT;
  }
}

export function savePrintSettings(s: PrintSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // the choice simply is not remembered
  }
}
