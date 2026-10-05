import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";

export type ImportJob = components["schemas"]["ImportJobDto_Output"];
export type ImportStatus = ImportJob["status"];
export type SourceApp = ImportJob["sourceApp"];
export type ImportField = components["schemas"]["ImportFieldsDto_Output"]["fields"][number];
export type Mapping = NonNullable<ImportJob["mapping"]>;
export type MappingBody = components["schemas"]["SetMappingDto"];
/** The header's row in the file, counted from 1 as the spreadsheet shows it (the api reads up to row 50). */
export const MAX_HEADER_ROW = 50;
export type Preset = components["schemas"]["PresetDto_Output"];
export type RowError = components["schemas"]["RowErrorListDto_Output"]["items"][number];
export type StoreState = components["schemas"]["StoreStateListDto_Output"]["items"][number];
export type ChecklistItem = StoreState["checklist"][number];
export type Comparison = components["schemas"]["StockComparisonDto_Output"];
export type ComparisonStatus = Comparison["items"][number]["status"];
export type Cutover = components["schemas"]["CutoverDto_Output"];

/** Excel or CSV up to 8 MB (backend 8.19). */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
export const IMPORT_ACCEPT = ".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const IMPORT_TONE: Record<ImportStatus, Tone> = {
  uploaded: "neutral",
  validating: "info",
  validated: "success",
  invalid: "danger",
  importing: "info",
  imported: "success",
  failed: "danger",
};

/** The worker is reading the file: the page asks again until it is done. */
export function importWorking(status: ImportStatus): boolean {
  return status === "validating" || status === "importing";
}

/** Where a job is on the way: upload, mapping, checking, importing (L46 steps 1 to 3). */
export function importStep(status: ImportStatus): 1 | 2 | 3 | 4 {
  if (status === "uploaded") return 2;
  if (status === "validating" || status === "validated" || status === "invalid") return 3;
  if (status === "importing" || status === "imported") return 4;
  return 3;
}

/** "A", "B", ..., "Z", "AA": the column as the spreadsheet names it. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "C · Harga Jual"; a column without a header (the api names it "Kolom C") is its letter alone. */
export function columnLabel(columns: readonly string[], index: number): string {
  const letter = columnLetter(index);
  const name = columns[index]?.trim();
  return name && name !== `Kolom ${letter}` ? `${letter} · ${name}` : letter;
}

/** Required fields not mapped to a column yet. */
export function missingRequired(fields: readonly ImportField[], mapped: Mapping["fields"]): ImportField[] {
  return fields.filter((f) => f.required && mapped[f.key] === undefined);
}

/** Columns read by more than one field: usually a mistake worth a look, never refused. */
export function sharedColumns(mapped: Mapping["fields"]): number[] {
  const seen = new Map<number, number>();
  for (const i of Object.values(mapped)) seen.set(i, (seen.get(i) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([i]) => i);
}

export function mappingBody(m: Mapping, savePresetAs: string): MappingBody {
  return {
    headerRow: m.headerRow,
    fields: m.fields,
    weightUnit: m.weightUnit,
    dimensionUnit: m.dimensionUnit,
    ...(savePresetAs.trim() ? { savePresetAs: savePresetAs.trim() } : {}),
  };
}

/** Stock comparison pills (backend 8.19): equal green, different red, not comparable yellow, gray for the rest. */
export const COMPARISON_TONE: Record<ComparisonStatus, Tone> = {
  match: "success",
  differ: "danger",
  unset: "warning",
  unknown: "warning",
  managed: "neutral",
  inactive: "neutral",
};

/** Read-only stores whose checklist passes; the seller's confirmation about the old app comes at cutover. */
export function readyStores(stores: readonly StoreState[]): StoreState[] {
  return stores.filter((s) => s.syncMode === "read_only" && s.ready);
}

/** Blocking items not yet done, leaving out the old-app confirmation the cutover form asks for. */
export function openChecks(s: StoreState): ChecklistItem[] {
  return s.checklist.filter((c) => c.blocking && !c.ok && c.key !== "old_app_revoked");
}

/** Time left to undo a cutover, in milliseconds; 0 when it can no longer be undone. */
export function undoLeft(c: Pick<Cutover, "canUndo" | "undoUntil">, now: Date = new Date()): number {
  return c.canUndo ? Math.max(0, Date.parse(c.undoUntil) - now.getTime()) : 0;
}
