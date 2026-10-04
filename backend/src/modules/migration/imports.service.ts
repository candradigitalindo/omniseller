import { Inject, Injectable } from "@nestjs/common";
import { type MigrationSourceApp, newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { toCsv } from "../../common/csv";
import type { DbHandle } from "../../db/client";
import type { ColumnMapping, PresetMapping } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { MAX_IMPORT_ROWS } from "../catalog/product-transfer.service";
import { FilesService } from "../files/files.service";
import {
  dataRows,
  FIELD_KEYS,
  IMPORT_FIELDS,
  mappingFromPreset,
  mappingProblems,
  presetFromMapping,
  suggestMapping,
} from "./import-plan";
import {
  fileGone,
  fileTooLarge,
  fileUnreadable,
  importAlreadyDone,
  importBusy,
  importNotFound,
  importNotValidated,
  mappingInvalid,
  noDataRows,
  permissionMissing,
  presetNameTaken,
  presetNotFound,
  tooManyRows,
} from "./migration.errors";
import { migrationImportRequested, migrationValidateRequested } from "./migration.events";
import { type MigrationJobRow, MigrationRepository, type PresetRow, type RowErrorRow } from "./migration.repository";
import { MAX_UPLOAD_BYTES, readSheet, SheetError } from "./sheet";

/** Uploaded files are kept this long: time to fix the mapping and import, short for business data. */
export const UPLOAD_TTL_DAYS = 30;
/** Rows read from a file: the data rows of the product import plus a few above the header. */
export const MAX_SHEET_ROWS = MAX_IMPORT_ROWS + 20;
const PREVIEW_ROWS = 5;
const MIME = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
} as const;

/** "A", "B", ..., "AA" for column i. */
export function columnLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Header names (blank ones named after their column), the first data rows, and how many there are. */
export function sheetShape(rows: readonly string[][], headerRow: number) {
  const header = rows[headerRow - 1] ?? [];
  const data = dataRows(rows, headerRow);
  const width = Math.max(header.length, ...data.slice(0, 50).map((r) => r.cells.length));
  const columns = Array.from({ length: width }, (_, i) => header[i]?.trim() || `Kolom ${columnLetter(i)}`);
  const preview = data
    .slice(0, PREVIEW_ROWS)
    .map((r) => Array.from({ length: width }, (_, i) => (r.cells[i] ?? "").trim()));
  return { columns, preview, rows: data.length };
}

function readOrRefuse(bytes: Uint8Array) {
  try {
    const sheet = readSheet(bytes, MAX_SHEET_ROWS);
    if (sheet.truncated) throw tooManyRows(MAX_IMPORT_ROWS);
    return sheet;
  } catch (err) {
    if (err instanceof SheetError) throw fileUnreadable(err.message);
    throw err;
  }
}

/**
 * Imports from another app (PRD FR-MIG-01, UI L46 steps 1 to 3, backend doc 8.19): upload a file
 * (Excel or CSV), map its columns to OmniSeller fields with a suggestion per app, validate every row,
 * then import. Validation and import run in the worker (ImportRunnerService); the file is kept
 * privately for 30 days. Importing products needs `catalog:write`, initial stock `inventory:adjust`.
 */
@Injectable()
export class ImportsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(MigrationRepository) private readonly repo: MigrationRepository,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  async upload(
    ctx: RequestContext,
    input: { sourceApp: MigrationSourceApp; fileName: string; content: string; presetId?: string | undefined },
  ): Promise<MigrationJobRow> {
    this.require(ctx, "catalog:write");
    const bytes = new Uint8Array(Buffer.from(input.content, "base64"));
    if (bytes.length === 0) throw fileUnreadable("Berkas kosong.");
    if (bytes.length > MAX_UPLOAD_BYTES) throw fileTooLarge();
    const sheet = readOrRefuse(bytes);
    const preset = input.presetId ? await this.preset(ctx, input.presetId) : null;
    const mapping = preset
      ? mappingFromPreset(sheet.rows, preset.mapping)
      : suggestMapping(sheet.rows, input.sourceApp);
    const shape = sheetShape(sheet.rows, mapping.headerRow);
    if (shape.rows === 0) throw noDataRows();
    if (shape.rows > MAX_IMPORT_ROWS) throw tooManyRows(MAX_IMPORT_ROWS);

    // the file is stored before its row is written; no transaction stays open during the upload
    const file = await this.files.save(ctx, {
      purpose: "import",
      mime: MIME[sheet.type],
      ext: sheet.type,
      bytes,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_DAYS * 86_400_000),
      createdBy: ctx.actor.type === "user" ? ctx.actor.id : null,
    });
    return withTenantTx(this.db, ctx, (tx) =>
      this.repo.insertJob(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        sourceApp: preset?.sourceApp ?? input.sourceApp,
        status: "uploaded",
        fileObjectId: file.id,
        fileName: input.fileName,
        fileType: sheet.type,
        columns: shape.columns,
        preview: shape.preview,
        columnMapping: mapping,
        stats: { rows: shape.rows },
        createdBy: ctx.actor.type === "user" ? ctx.actor.id : null,
      }),
    );
  }

  async list(ctx: RequestContext, limit = 20): Promise<MigrationJobRow[]> {
    return withTenantTx(this.db, ctx, (tx) => this.repo.listJobs(tx, limit));
  }

  async get(ctx: RequestContext, id: string): Promise<MigrationJobRow> {
    const job = await withTenantTx(this.db, ctx, (tx) => this.repo.getJob(tx, id));
    if (!job) throw importNotFound();
    return job;
  }

  /**
   * A new mapping (UI L46 step 2). Changing the header row reads the file again for its columns. The
   * job goes back to `uploaded`: the last validation no longer applies. `savePresetAs` keeps the
   * mapping by header name for the next file of the same app.
   */
  async setMapping(
    ctx: RequestContext,
    id: string,
    input: ColumnMapping & { savePresetAs?: string | undefined },
  ): Promise<MigrationJobRow> {
    this.require(ctx, "catalog:write");
    const before = await this.get(ctx, id);
    this.requireEditable(before);
    const mapping: ColumnMapping = {
      headerRow: input.headerRow,
      fields: input.fields,
      weightUnit: input.weightUnit,
      dimensionUnit: input.dimensionUnit,
    };
    let shape = { columns: before.columns, preview: before.preview, rows: before.stats.rows ?? 0 };
    if (mapping.headerRow !== (before.columnMapping as ColumnMapping).headerRow) {
      const bytes = before.fileObjectId ? await this.files.read(ctx, before.fileObjectId) : null;
      if (!bytes) throw fileGone();
      shape = sheetShape(readOrRefuse(bytes).rows, mapping.headerRow);
      if (shape.rows === 0) throw noDataRows();
    }
    const problems = mappingProblems(mapping, shape.columns.length);
    if (problems.length > 0) throw mappingInvalid(problems);

    return withTenantTx(this.db, ctx, async (tx) => {
      const job = await this.repo.getJob(tx, id, true);
      if (!job) throw importNotFound();
      this.requireEditable(job);
      await this.repo.updateJob(tx, id, {
        columnMapping: mapping,
        columns: shape.columns,
        preview: shape.preview,
        stats: { rows: shape.rows },
        error: null,
        ...(job.status !== "uploaded" ? { status: "uploaded" as const } : {}),
      });
      await this.repo.replaceErrors(tx, ctx.tenantId, id, []);
      if (input.savePresetAs?.trim()) {
        const saved = await this.repo.insertPreset(tx, {
          id: newId(),
          tenantId: ctx.tenantId,
          name: input.savePresetAs.trim(),
          sourceApp: job.sourceApp,
          mapping: presetFromMapping(shape.columns, mapping),
          createdBy: ctx.actor.type === "user" ? ctx.actor.id : null,
        });
        if (!saved) throw presetNameTaken();
      }
      return (await this.repo.getJob(tx, id))!;
    });
  }

  /** UI L46 step 3: every row is checked in the worker against the catalog, nothing is written. */
  async requestValidation(ctx: RequestContext, id: string): Promise<MigrationJobRow> {
    this.require(ctx, "catalog:write");
    return withTenantTx(this.db, ctx, async (tx) => {
      const job = await this.repo.getJob(tx, id, true);
      if (!job) throw importNotFound();
      this.requireEditable(job);
      const problems = mappingProblems(job.columnMapping as ColumnMapping, job.columns.length);
      if (problems.length > 0) throw mappingInvalid(problems);
      await this.repo.updateJob(tx, id, { status: "validating", startedAt: new Date(), finishedAt: null, error: null });
      await this.outbox.enqueue(tx, ctx, migrationValidateRequested, { jobId: id }, id);
      return (await this.repo.getJob(tx, id))!;
    });
  }

  /** Imports a validated file in the worker: all rows or none. */
  async requestImport(ctx: RequestContext, id: string): Promise<MigrationJobRow> {
    this.require(ctx, "catalog:write");
    return withTenantTx(this.db, ctx, async (tx) => {
      const job = await this.repo.getJob(tx, id, true);
      if (!job) throw importNotFound();
      if (job.status === "imported") throw importAlreadyDone();
      if (job.status === "validating" || job.status === "importing") throw importBusy();
      if (job.status !== "validated") throw importNotValidated();
      if ((job.columnMapping as ColumnMapping).fields.stok_awal !== undefined) this.require(ctx, "inventory:adjust");
      await this.repo.updateJob(tx, id, { status: "importing", startedAt: new Date(), finishedAt: null, error: null });
      await this.outbox.enqueue(tx, ctx, migrationImportRequested, { jobId: id }, id);
      return (await this.repo.getJob(tx, id))!;
    });
  }

  async errors(
    ctx: RequestContext,
    id: string,
    after: { row: number; id: string } | undefined,
    limit: number,
  ): Promise<RowErrorRow[]> {
    return withTenantTx(this.db, ctx, async (tx) => {
      if (!(await this.repo.getJob(tx, id))) throw importNotFound();
      return this.repo.errors(tx, id, after, limit);
    });
  }

  /** UI L46 step 3 "unduh daftar gagal": each problem with the row as it was in the file. */
  async errorsCsv(ctx: RequestContext, id: string): Promise<{ fileName: string; csv: string }> {
    const job = await this.get(ctx, id);
    const errors = await withTenantTx(this.db, ctx, (tx) => this.repo.errors(tx, id, undefined, 50_000));
    const label = new Map(IMPORT_FIELDS.map((f) => [f.key, f.label]));
    const rows = [
      ["baris", "kolom", "masalah", ...job.columns],
      ...errors.map((e) => [e.rowNumber, e.field ? (label.get(e.field) ?? e.field) : "", e.message, ...e.raw]),
    ];
    const base = job.fileName.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-") || "impor";
    return { fileName: `${base}-gagal.csv`, csv: toCsv(rows) };
  }

  // ---- presets (FR-MIG-01 "dapat disimpan") ----

  async presets(ctx: RequestContext): Promise<PresetRow[]> {
    return withTenantTx(this.db, ctx, (tx) => this.repo.presets(tx));
  }

  async preset(ctx: RequestContext, id: string): Promise<PresetRow> {
    const p = await withTenantTx(this.db, ctx, (tx) => this.repo.getPreset(tx, id));
    if (!p) throw presetNotFound();
    return p;
  }

  async savePreset(
    ctx: RequestContext,
    input: { name: string; sourceApp: MigrationSourceApp; mapping: PresetMapping },
  ): Promise<PresetRow> {
    const unknown = Object.keys(input.mapping.fields).filter((k) => !FIELD_KEYS.has(k));
    if (unknown.length > 0) {
      throw mappingInvalid(
        unknown.map((k) => ({ path: `mapping.fields.${k}`, message: "Kolom OmniSeller tidak dikenal." })),
      );
    }
    return withTenantTx(this.db, ctx, async (tx) => {
      const saved = await this.repo.insertPreset(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        name: input.name.trim(),
        sourceApp: input.sourceApp,
        mapping: input.mapping,
        createdBy: ctx.actor.type === "user" ? ctx.actor.id : null,
      });
      if (!saved) throw presetNameTaken();
      return saved;
    });
  }

  async deletePreset(ctx: RequestContext, id: string): Promise<void> {
    const deleted = await withTenantTx(this.db, ctx, (tx) => this.repo.deletePreset(tx, id));
    if (!deleted) throw presetNotFound();
  }

  private requireEditable(job: MigrationJobRow): void {
    if (job.status === "validating" || job.status === "importing") throw importBusy();
    if (job.status === "imported") throw importAlreadyDone();
  }

  private require(ctx: RequestContext, permission: string): void {
    if (!ctx.permissions.has(permission)) throw permissionMissing(permission);
  }
}
