import {
  MIGRATION_JOB_STATUSES,
  MIGRATION_SOURCE_APPS,
  type MigrationSourceApp,
  STORE_CUTOVER_STATUSES,
  ulidSchema,
} from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { ColumnMapping } from "../../db/schema";
import { channelDisplayName } from "../channel/stores.service";
import {
  COMPARISON_STATUSES,
  type ComparisonStatus,
  type StoreComparison,
} from "../inventory/stock-comparison.service";
import { IMPORT_FIELDS, SOURCE_APP_NAMES } from "./import-plan";
import type { CutoverRow, MigrationJobRow, PresetRow, RowErrorRow } from "./migration.repository";
import type { StoreState } from "./parallel-mode.service";

const iso = z.iso.datetime();
const sourceApp = z.enum(MIGRATION_SOURCE_APPS);
const comparisonStatus = z.enum(COMPARISON_STATUSES as [ComparisonStatus, ...ComparisonStatus[]]);

// ---- imports ----

export class UploadImportDto extends createZodDto(
  z.object({
    sourceApp,
    fileName: z.string().trim().min(1).max(255),
    /** The file, base64 encoded: Excel (.xlsx) or CSV, at most 8 MB. */
    content: z
      .string()
      .min(1)
      .max(11_200_000)
      .regex(/^[A-Za-z0-9+/=\r\n]+$/, "Isi berkas harus base64."),
    /** A saved mapping to apply instead of the suggestion. */
    presetId: ulidSchema.optional(),
  }),
) {}

const mappingSchema = z.object({
  /** 1-based row of the header; data starts on the next row. */
  headerRow: z.number().int().min(1).max(50),
  /** OmniSeller field to 0-based column of the file (fields in GET /v1/migration/fields). */
  fields: z.record(z.string(), z.number().int().min(0).max(1000)),
  weightUnit: z.enum(["g", "kg"]),
  dimensionUnit: z.enum(["cm", "mm"]),
});

export class SetMappingDto extends createZodDto(
  mappingSchema.extend({
    /** Also save this mapping, by header name, for the next file of the same app. */
    savePresetAs: z.string().trim().min(1).max(80).optional(),
  }),
) {}

export class ImportIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

const counts = z.object({ created: z.number().int(), updated: z.number().int() });
const statsSchema = z.object({
  rows: z.number().int().optional(),
  errors: z.number().int().optional(),
  errorRows: z.number().int().optional(),
  products: counts.optional(),
  variants: counts.optional(),
  stock: z.object({ set: z.number().int(), confirmed: z.number().int(), skipped: z.number().int() }).optional(),
});

const jobSchema = z.object({
  id: ulidSchema,
  sourceApp,
  sourceAppName: z.string(),
  status: z.enum(MIGRATION_JOB_STATUSES),
  fileName: z.string(),
  fileType: z.enum(["xlsx", "csv"]),
  /** False after 30 days, when the file was deleted. */
  fileAvailable: z.boolean(),
  columns: z.array(z.string()),
  preview: z.array(z.array(z.string())),
  mapping: mappingSchema.nullable(),
  stats: statsSchema,
  error: z.string().nullable(),
  createdBy: ulidSchema.nullable(),
  createdAt: iso,
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
});

export class ImportJobDto extends createZodDto(jobSchema) {}
export class ImportJobListDto extends createZodDto(z.object({ items: z.array(jobSchema) })) {}

export function importJobView(j: MigrationJobRow): z.infer<typeof jobSchema> {
  const mapping = "headerRow" in j.columnMapping ? (j.columnMapping as ColumnMapping) : null;
  return {
    id: j.id,
    sourceApp: j.sourceApp,
    sourceAppName: SOURCE_APP_NAMES[j.sourceApp],
    status: j.status,
    fileName: j.fileName,
    fileType: j.fileType,
    fileAvailable: j.fileObjectId !== null,
    columns: j.columns,
    preview: j.preview,
    mapping,
    stats: j.stats,
    error: j.error,
    createdBy: j.createdBy,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}

export class ErrorsQueryDto extends createZodDto(
  z.object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
) {}

const rowErrorSchema = z.object({
  id: ulidSchema,
  /** The spreadsheet row. */
  rowNumber: z.number().int(),
  field: z.string().nullable(),
  fieldLabel: z.string().nullable(),
  message: z.string(),
  /** The row's cells as in the file, in the order of `columns`. */
  raw: z.array(z.string()),
});

export class RowErrorListDto extends createZodDto(
  z.object({ items: z.array(rowErrorSchema), nextCursor: z.string().nullable() }),
) {}

const labels = new Map(IMPORT_FIELDS.map((f) => [f.key, f.label]));

export function rowErrorView(e: RowErrorRow): z.infer<typeof rowErrorSchema> {
  return {
    id: e.id,
    rowNumber: e.rowNumber,
    field: e.field,
    fieldLabel: e.field ? (labels.get(e.field) ?? e.field) : null,
    message: e.message,
    raw: e.raw,
  };
}

export const encodeErrorCursor = (e: RowErrorRow) => Buffer.from(`${e.rowNumber}|${e.id}`).toString("base64url");

export function decodeErrorCursor(cursor: string | undefined): { row: number; id: string } | undefined {
  if (!cursor) return undefined;
  const [row, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const parsed = ulidSchema.safeParse(id);
  return Number.isInteger(Number(row)) && parsed.success ? { row: Number(row), id: parsed.data } : undefined;
}

const fieldDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  unit: z.enum(["weight", "dimension"]).nullable(),
});

export class ImportFieldsDto extends createZodDto(
  z.object({
    fields: z.array(fieldDefSchema),
    sourceApps: z.array(z.object({ key: sourceApp, name: z.string() })),
  }),
) {}

export function importFieldsView(): z.infer<typeof ImportFieldsDto.schema> {
  return {
    fields: IMPORT_FIELDS.map((f) => ({ key: f.key, label: f.label, required: f.required, unit: f.unit ?? null })),
    sourceApps: MIGRATION_SOURCE_APPS.map((k: MigrationSourceApp) => ({ key: k, name: SOURCE_APP_NAMES[k] })),
  };
}

// ---- presets ----

const presetMappingSchema = z.object({
  /** OmniSeller field to the header name in the file. */
  fields: z.record(z.string(), z.string().min(1).max(200)),
  weightUnit: z.enum(["g", "kg"]),
  dimensionUnit: z.enum(["cm", "mm"]),
});

export class SavePresetDto extends createZodDto(
  z.object({ name: z.string().trim().min(1).max(80), sourceApp, mapping: presetMappingSchema }),
) {}

const presetSchema = z.object({
  id: ulidSchema,
  name: z.string(),
  sourceApp,
  sourceAppName: z.string(),
  mapping: presetMappingSchema,
  createdAt: iso,
});

export class PresetDto extends createZodDto(presetSchema) {}
export class PresetListDto extends createZodDto(z.object({ items: z.array(presetSchema) })) {}
export class PresetIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export function presetView(p: PresetRow): z.infer<typeof presetSchema> {
  return {
    id: p.id,
    name: p.name,
    sourceApp: p.sourceApp,
    sourceAppName: SOURCE_APP_NAMES[p.sourceApp],
    mapping: p.mapping,
    createdAt: p.createdAt.toISOString(),
  };
}

// ---- parallel mode and cutover ----

const cutoverSchema = z.object({
  id: ulidSchema,
  storeId: ulidSchema,
  status: z.enum(STORE_CUTOVER_STATUSES),
  undoUntil: iso,
  /** Still within the 24 hours and not undone. */
  canUndo: z.boolean(),
  checklist: z.object({
    checks: z.array(z.object({ key: z.string(), ok: z.boolean(), detail: z.string().nullable() })),
    oldAppRevoked: z.boolean(),
    stock: z.object({ match: z.number().int(), differ: z.number().int(), unset: z.number().int() }),
  }),
  performedBy: ulidSchema.nullable(),
  createdAt: iso,
  undoneAt: iso.nullable(),
  undoneBy: ulidSchema.nullable(),
});

export class CutoverDto extends createZodDto(cutoverSchema) {}
export class CutoverListDto extends createZodDto(z.object({ items: z.array(cutoverSchema) })) {}
export class CutoverIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export function cutoverView(c: CutoverRow, now = new Date()): z.infer<typeof cutoverSchema> {
  return {
    id: c.id,
    storeId: c.storeId,
    status: c.status,
    undoUntil: c.undoUntil.toISOString(),
    canUndo: c.status === "done" && now.getTime() <= c.undoUntil.getTime(),
    checklist: c.checklist,
    performedBy: c.performedBy,
    createdAt: c.createdAt.toISOString(),
    undoneAt: c.undoneAt?.toISOString() ?? null,
    undoneBy: c.undoneBy,
  };
}

const statusCounts = z.record(comparisonStatus, z.number().int());

const storeStateSchema = z.object({
  /** The store. */
  id: ulidSchema,
  name: z.string(),
  channel: z.string(),
  displayName: z.string(),
  syncMode: z.enum(["read_only", "live"]),
  parallelSince: iso.nullable(),
  parallelDays: z.number().int().nullable(),
  /** Orders received per status since parallel mode began. */
  orders: z.record(z.string(), z.number().int()),
  stock: z.object({
    counts: statusCounts,
    unverified: z.number().int(),
    pulledAt: iso.nullable(),
    blocked: z.enum(["store_unusable", "warehouses_unmapped"]).nullable(),
  }),
  unmappedListings: z.number().int(),
  unmappedWarehouses: z.number().int(),
  checklist: z.array(
    z.object({ key: z.string(), ok: z.boolean(), blocking: z.boolean(), detail: z.string().nullable() }),
  ),
  /** Ready for cutover, the confirmation of the old app's revocation aside. */
  ready: z.boolean(),
  lastCutover: cutoverSchema.nullable(),
});

export class StoreStateListDto extends createZodDto(z.object({ items: z.array(storeStateSchema) })) {}

export function storeStateView(s: StoreState, now = new Date()): z.infer<typeof storeStateSchema> {
  return {
    id: s.store.id,
    name: s.store.name,
    channel: s.store.channel,
    displayName: channelDisplayName(s.store.channel),
    syncMode: s.store.syncMode,
    parallelSince: s.parallelSince?.toISOString() ?? null,
    parallelDays: s.parallelSince ? Math.floor((now.getTime() - s.parallelSince.getTime()) / 86_400_000) : null,
    orders: s.orders,
    stock: { ...s.stock, pulledAt: s.stock.pulledAt?.toISOString() ?? null },
    unmappedListings: s.unmappedListings,
    unmappedWarehouses: s.unmappedWarehouses,
    checklist: s.checklist,
    ready: s.ready,
    lastCutover: s.lastCutover ? cutoverView(s.lastCutover, now) : null,
  };
}

export class StoreIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export class ComparisonQueryDto extends createZodDto(
  z.object({
    status: comparisonStatus.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  }),
) {}

const comparisonLineSchema = z.object({
  listingId: ulidSchema,
  variantId: ulidSchema,
  sku: z.string(),
  externalSku: z.string().nullable(),
  title: z.string(),
  status: comparisonStatus,
  marketplace: z.number().int().nullable(),
  omniseller: z.number().int().nullable(),
  difference: z.number().int().nullable(),
  locations: z.array(
    z.object({
      externalWarehouseId: z.string(),
      warehouseName: z.string().nullable(),
      marketplace: z.number().int().nullable(),
      omniseller: z.number().int().nullable(),
    }),
  ),
});

export class StockComparisonDto extends createZodDto(
  z.object({
    storeId: ulidSchema,
    pulledAt: iso.nullable(),
    blocked: z.enum(["store_unusable", "warehouses_unmapped"]).nullable(),
    counts: statusCounts,
    items: z.array(comparisonLineSchema),
    /** More lines than `limit` match. */
    more: z.boolean(),
  }),
) {}

export function comparisonView(
  c: StoreComparison,
  q: { status?: ComparisonStatus | undefined; limit: number },
): z.infer<typeof StockComparisonDto.schema> {
  const lines = q.status ? c.lines.filter((l) => l.status === q.status) : c.lines;
  return {
    storeId: c.storeId,
    pulledAt: c.pulledAt?.toISOString() ?? null,
    blocked: c.blocked,
    counts: c.counts,
    items: lines.slice(0, q.limit),
    more: lines.length > q.limit,
  };
}

export class CutoverCheckQueryDto extends createZodDto(
  z.object({
    /** Repeat for several stores; all stores in parallel mode when absent. */
    storeId: z
      .union([ulidSchema, z.array(ulidSchema).max(50)])
      .transform((v) => (Array.isArray(v) ? v : [v]))
      .optional(),
  }),
) {}

export class CutoverRequestDto extends createZodDto(
  z.object({
    /** Stores to move; all stores in parallel mode when absent. */
    storeIds: z.array(ulidSchema).min(1).max(50).optional(),
    /** The seller revoked the old app's authorization in every Seller Center (FR-MIG-06). */
    oldAppRevoked: z.boolean(),
  }),
) {}
