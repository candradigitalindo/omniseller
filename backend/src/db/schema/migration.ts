import type { MigrationJobStatus, MigrationSourceApp, StoreCutoverStatus } from "@omniseller/shared";
import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { appendOnlyColumns, baseColumns, tstz, ulid } from "../columns";

/** Where each OmniSeller field comes from in the source file (backend doc 8.19). */
export interface ColumnMapping {
  /** 1-based row of the header in the sheet; data starts on the next row. */
  headerRow: number;
  /** OmniSeller field to 0-based column index of the source file. */
  fields: Record<string, number>;
  weightUnit: "g" | "kg";
  dimensionUnit: "cm" | "mm";
}

/** A saved mapping, by header name so it fits the next file of the same app (FR-MIG-01). */
export interface PresetMapping {
  fields: Record<string, string>;
  weightUnit: "g" | "kg";
  dimensionUnit: "cm" | "mm";
}

export interface MigrationStats {
  rows?: number;
  errors?: number;
  errorRows?: number;
  products?: { created: number; updated: number };
  variants?: { created: number; updated: number };
  stock?: { set: number; confirmed: number; skipped: number };
}

/** Imports from another app (PRD FR-MIG-01). Status changes are checked by trigger. */
export const migrationJob = pgTable("migration_job", {
  ...baseColumns(),
  sourceApp: text("source_app").$type<MigrationSourceApp>().notNull(),
  kind: text("kind").$type<"products" | "costs" | "mappings" | "stock">().notNull().default("products"),
  status: text("status").$type<MigrationJobStatus>().notNull().default("uploaded"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  fileObjectId: ulid("file_object_id"),
  fileName: text("file_name").notNull(),
  fileType: text("file_type").$type<"xlsx" | "csv">().notNull(),
  columns: jsonb("columns").$type<string[]>().notNull().default([]),
  preview: jsonb("preview").$type<string[][]>().notNull().default([]),
  columnMapping: jsonb("column_mapping").$type<ColumnMapping | Record<string, never>>().notNull().default({}),
  stats: jsonb("stats").$type<MigrationStats>().notNull().default({}),
  error: text("error"),
  startedAt: tstz("started_at"),
  finishedAt: tstz("finished_at"),
  createdBy: ulid("created_by"),
});

export const migrationRowError = pgTable("migration_row_error", {
  ...appendOnlyColumns(),
  migrationJobId: ulid("migration_job_id").notNull(),
  rowNumber: integer("row_number").notNull(),
  field: text("field"),
  message: text("message").notNull(),
  raw: jsonb("raw").$type<string[]>().notNull().default([]),
});

export const migrationPreset = pgTable("migration_preset", {
  ...baseColumns(),
  name: text("name").notNull(),
  sourceApp: text("source_app").$type<MigrationSourceApp>().notNull(),
  mapping: jsonb("mapping").$type<PresetMapping>().notNull(),
  createdBy: ulid("created_by"),
});

export interface CutoverChecklist {
  checks: { key: string; ok: boolean; detail: string | null }[];
  oldAppRevoked: boolean;
  stock: { match: number; differ: number; unset: number };
}

/** A read-only store switched live once its checklist passed (PRD FR-MIG-06). */
export const storeCutover = pgTable("store_cutover", {
  ...baseColumns(),
  storeId: ulid("store_id").notNull(),
  status: text("status").$type<StoreCutoverStatus>().notNull().default("done"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  checklist: jsonb("checklist").$type<CutoverChecklist>().notNull(),
  undoUntil: tstz("undo_until").notNull(),
  performedBy: ulid("performed_by"),
  undoneAt: tstz("undone_at"),
  undoneBy: ulid("undone_by"),
});
