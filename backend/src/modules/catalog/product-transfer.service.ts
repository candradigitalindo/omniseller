import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { CsvValue } from "../../common/csv";
import { DomainError, type FieldIssue } from "../../common/errors/domain-errors";
import type { ExportSheet } from "../../common/export-sheet";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { importInvalid } from "./catalog.errors";
import { CatalogRepository, normSku, type ProductRow } from "./catalog.repository";
import { formatAttributes, IMAGE_SEPARATOR, parseAttributes, parseCsv, parseWholeNumber, toCsv } from "./csv";
import { ProductsService, type VariantInput } from "./products.service";

/** Columns of the product template, in order (FR-PRD-04). */
export const PRODUCT_COLUMNS = [
  "sku_produk",
  "nama_produk",
  "deskripsi",
  "merek",
  "kategori",
  "sku_varian",
  "nama_varian",
  "atribut",
  "barcode",
  "harga_jual",
  "hpp",
  "berat_gram",
  "panjang_mm",
  "lebar_mm",
  "tinggi_mm",
  "status",
  "gambar",
] as const;
type Column = (typeof PRODUCT_COLUMNS)[number];
export type ProductCells = Record<Column, string>;
/** One product row in the template's columns; `line` is its spreadsheet row, for error paths. */
export interface ProductRecord {
  line: number;
  cells: ProductCells;
}
const REQUIRED: Column[] = ["sku_produk", "nama_produk", "sku_varian", "harga_jual", "berat_gram"];
const PRODUCT_FIELDS: Column[] = ["nama_produk", "deskripsi", "merek", "kategori", "gambar"];
export const MAX_IMPORT_ROWS = 10_000;

export interface ImportSummary {
  rows: number;
  products: { created: number; updated: number };
  variants: { created: number; updated: number };
  dryRun: boolean;
}

interface ParsedRow {
  line: number;
  cells: Record<Column, string>;
  variant: VariantInput;
}

class DryRunRollback extends Error {
  constructor(readonly summary: ImportSummary) {
    super("dry run");
  }
}

const STATUS: Record<string, "active" | "archived"> = {
  aktif: "active",
  active: "active",
  arsip: "archived",
  archived: "archived",
};

/**
 * Product import and export as CSV (FR-PRD-04). Import is all or nothing: every row is validated, and
 * any error (reported per row and column, spreadsheet row numbers) leaves the catalog untouched.
 * `dryRun` runs the whole import inside a transaction and rolls it back, so the preview is exact.
 * Rows are matched by `sku_varian`; rows of one product share `sku_produk` and its product columns.
 */
@Injectable()
export class ProductTransferService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(CatalogRepository) private readonly repo: CatalogRepository,
    @Inject(ProductsService) private readonly products: ProductsService,
  ) {}

  async exportCsv(ctx: RequestContext): Promise<string> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const rows: CsvValue[][] = [[...PRODUCT_COLUMNS]];
      for await (const page of this.productPages(tx)) rows.push(...page);
      return toCsv(rows);
    });
  }

  /** produk.csv of the full data export (FR-MIG-09): the template's columns, so it imports again. */
  exportSheets(): ExportSheet[] {
    return [
      {
        file: "produk.csv",
        description: "Produk dan varian dengan kolom templat impor produk; berkas ini bisa diimpor ulang.",
        columns: PRODUCT_COLUMNS,
        pages: (tx) => this.productPages(tx),
      },
    ];
  }

  /** One page per 500 products, products by SKU within a page, one row per variant. */
  private async *productPages(tx: Tx): AsyncIterable<CsvValue[][]> {
    let before: string | undefined;
    for (;;) {
      const page = await this.repo.listProducts(tx, {}, before, 500);
      const batch = page.slice(0, 500);
      const views = await this.products.view(tx, batch);
      const rows: CsvValue[][] = [];
      for (const v of views.sort((a, b) => a.product.sku.localeCompare(b.product.sku))) {
        for (const variant of v.variants) {
          rows.push([
            v.product.sku,
            v.product.name,
            v.product.description,
            v.product.brand,
            v.product.categoryPath,
            variant.sku,
            variant.name,
            formatAttributes(variant.attributes),
            variant.barcode,
            variant.basePrice,
            variant.costPrice,
            variant.weightG,
            variant.lengthMm,
            variant.widthMm,
            variant.heightMm,
            variant.status === "active" ? "aktif" : "arsip",
            v.imageUrls.join(IMAGE_SEPARATOR),
          ]);
        }
      }
      yield rows;
      if (page.length <= 500) return;
      before = batch[batch.length - 1]!.id;
    }
  }

  async importCsv(ctx: RequestContext, content: string, dryRun: boolean): Promise<ImportSummary> {
    const table = parseCsv(content);
    const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
    const errors: FieldIssue[] = [];
    const unknown = header.filter((h) => !(PRODUCT_COLUMNS as readonly string[]).includes(h));
    if (unknown.length) errors.push({ path: "rows.1", message: `Kolom tidak dikenal: ${unknown.join(", ")}.` });
    const missing = REQUIRED.filter((c) => !header.includes(c));
    if (missing.length) errors.push({ path: "rows.1", message: `Kolom wajib tidak ada: ${missing.join(", ")}.` });
    if (table.length < 2) errors.push({ path: "rows.2", message: "File tidak berisi baris produk." });
    if (table.length - 1 > MAX_IMPORT_ROWS) {
      errors.push({ path: "rows", message: `Maksimal ${MAX_IMPORT_ROWS} baris per file.` });
    }
    if (errors.length) throw importInvalid(errors);

    const records = table.slice(1).map((raw, i) => ({
      line: i + 2,
      cells: Object.fromEntries(PRODUCT_COLUMNS.map((c) => [c, raw[header.indexOf(c)] ?? ""])) as ProductCells,
    }));
    try {
      return await withTenantTx(this.db, ctx, async (tx) => {
        const result = await this.importRecordsIn(tx, ctx, records);
        if (result.errors.length) throw importInvalid(result.errors);
        const summary = { ...result.summary, dryRun };
        if (dryRun) throw new DryRunRollback(summary);
        return summary;
      });
    } catch (err) {
      if (err instanceof DryRunRollback) return err.summary;
      throw err;
    }
  }

  /**
   * Validates and applies product rows in the caller's transaction, rows in the template's columns
   * (the CSV above, and the migration import after its column mapping, FR-MIG-01). Problems come back
   * per row and column (`rows.<line>.<column>`) instead of being thrown; when there are any, nothing
   * is written or the caller must roll its transaction back. `variantIds` gives each imported variant
   * SKU (normalized) its id.
   */
  async importRecordsIn(
    tx: Tx,
    ctx: RequestContext,
    records: ProductRecord[],
  ): Promise<{ summary: ImportSummary; errors: FieldIssue[]; variantIds: Map<string, string> }> {
    const errors: FieldIssue[] = [];
    const summary: ImportSummary = {
      rows: records.length,
      products: { created: 0, updated: 0 },
      variants: { created: 0, updated: 0 },
      dryRun: false,
    };
    const rows = records.map((r) => this.parseRow(r, errors));
    const groups = new Map<string, ParsedRow[]>();
    for (const r of rows) {
      if (!r) continue;
      const key = r.cells.sku_produk;
      const first = groups.get(key)?.[0];
      if (first) {
        for (const f of PRODUCT_FIELDS) {
          if (r.cells[f] && r.cells[f] !== first.cells[f]) {
            errors.push({
              path: `rows.${r.line}.${f}`,
              message: `Berbeda dengan baris ${first.line} untuk produk yang sama.`,
            });
          }
        }
      }
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const seen = new Map<string, number>();
    for (const r of rows) {
      if (!r) continue;
      const k = normSku(r.cells.sku_varian)!;
      if (seen.has(k))
        errors.push({ path: `rows.${r.line}.sku_varian`, message: `SKU varian sama dengan baris ${seen.get(k)}.` });
      else seen.set(k, r.line);
    }
    if (errors.length) return { summary, errors, variantIds: new Map() };

    for (const group of groups.values()) {
      try {
        await this.applyGroup(tx, ctx, group, summary);
      } catch (err) {
        if (err instanceof DomainError) {
          errors.push(...this.rowIssues(group, err));
          continue;
        }
        throw err;
      }
    }
    if (errors.length) return { summary, errors, variantIds: new Map() };
    const bySku = await this.repo.variantsByNormSku(tx, [...seen.keys()]);
    const variantIds = new Map<string, string>();
    for (const [k, owners] of bySku) if (owners[0]) variantIds.set(k, owners[0].id);
    return { summary, errors, variantIds };
  }

  private parseRow(record: ProductRecord, errors: FieldIssue[]): ParsedRow | null {
    const line = record.line;
    const cells = Object.fromEntries(PRODUCT_COLUMNS.map((c) => [c, (record.cells[c] ?? "").trim()])) as ProductCells;
    const before = errors.length;
    const err = (col: Column, message: string) => errors.push({ path: `rows.${line}.${col}`, message });
    for (const c of REQUIRED) if (!cells[c]) err(c, "Wajib diisi.");
    const num = (col: Column, required: boolean, min: number) => {
      if (!cells[col]) return required ? null : undefined;
      const n = parseWholeNumber(cells[col]);
      if (n === null || n < min) {
        err(col, min > 0 ? "Harus bilangan bulat lebih dari 0." : "Harus bilangan bulat rupiah tanpa desimal.");
        return null;
      }
      return n;
    };
    const basePrice = num("harga_jual", true, 0);
    const costPrice = num("hpp", false, 0);
    const weightG = num("berat_gram", true, 1);
    const lengthMm = num("panjang_mm", false, 1);
    const widthMm = num("lebar_mm", false, 1);
    const heightMm = num("tinggi_mm", false, 1);
    const attributes = cells.atribut ? parseAttributes(cells.atribut) : {};
    if (attributes === null) err("atribut", 'Format: "Warna=Hitam; Ukuran=L".');
    const status = cells.status ? STATUS[cells.status.toLowerCase()] : "active";
    if (!status) err("status", 'Isi "aktif" atau "arsip".');
    for (const col of ["sku_produk", "sku_varian"] as const) {
      if (cells[col] && (cells[col].length > 64 || /\s{2,}|[\r\n\t]/.test(cells[col])))
        err(col, "SKU maksimal 64 karakter tanpa baris baru.");
    }
    for (const url of cells.gambar
      ? cells.gambar
          .split("|")
          .map((u) => u.trim())
          .filter(Boolean)
      : []) {
      if (!/^https:\/\/\S+$/.test(url)) err("gambar", "Setiap gambar harus URL https.");
    }
    if (errors.length > before) return null;
    return {
      line,
      cells,
      variant: {
        sku: cells.sku_varian,
        ...(cells.nama_varian ? { name: cells.nama_varian } : {}),
        attributes: attributes ?? {},
        barcode: cells.barcode || null,
        basePrice: basePrice!,
        ...(costPrice !== undefined && costPrice !== null ? { costPrice } : {}),
        weightG: weightG!,
        lengthMm: lengthMm ?? null,
        widthMm: widthMm ?? null,
        heightMm: heightMm ?? null,
        status: status ?? "active",
      },
    };
  }

  private async applyGroup(tx: Tx, ctx: RequestContext, group: ParsedRow[], summary: ImportSummary): Promise<void> {
    const first = group[0]!;
    const images = first.cells.gambar
      ? first.cells.gambar
          .split("|")
          .map((u) => u.trim())
          .filter(Boolean)
      : undefined;
    const fields = {
      name: first.cells.nama_produk,
      description: first.cells.deskripsi || null,
      brand: first.cells.merek || null,
      categoryPath: first.cells.kategori || null,
    };
    const existing = await this.repo.productBySku(tx, first.cells.sku_produk);
    if (!existing) {
      await tx.transaction((sp) =>
        this.products.createIn(sp, ctx, {
          sku: first.cells.sku_produk,
          ...fields,
          attributeNames: Object.keys(first.variant.attributes ?? {}),
          ...(images ? { imageUrls: images } : {}),
          variants: group.map((r) => r.variant),
        }),
      );
      summary.products.created++;
      summary.variants.created += group.length;
      return;
    }
    await tx.transaction(async (sp) => {
      await this.products.updateIn(sp, ctx, existing, { ...fields, ...(images ? { imageUrls: images } : {}) });
      await this.applyVariants(sp, ctx, existing, group, summary);
    });
    summary.products.updated++;
  }

  private async applyVariants(tx: Tx, ctx: RequestContext, p: ProductRow, group: ParsedRow[], summary: ImportSummary) {
    const bySku = await this.repo.variantsByNormSku(
      tx,
      group.map((r) => r.variant.sku),
    );
    for (const r of group) {
      const owners = bySku.get(normSku(r.variant.sku)!) ?? [];
      const own = owners.find((v) => v.productId === p.id);
      if (owners.length && !own) {
        throw new ImportRowError(r.line, "sku_varian", "SKU varian ini milik produk lain.");
      }
      if (own) {
        await this.products.updateVariantIn(tx, ctx, p, own, r.variant);
        summary.variants.updated++;
      } else {
        await this.products.addVariantIn(tx, ctx, p, r.variant);
        summary.variants.created++;
      }
    }
  }

  /** A domain error inside a product group is reported on that group's rows. */
  private rowIssues(group: ParsedRow[], err: DomainError): FieldIssue[] {
    if (err instanceof ImportRowError)
      return [{ path: `rows.${err.line}.${err.column}`, message: err.detail ?? err.code }];
    const message = err.detail ?? err.code;
    const variantIndex = (err.errors ?? [])
      .map((e) => /^variants\.(\d+)/.exec(e.path)?.[1])
      .find((x) => x !== undefined);
    const row = variantIndex !== undefined ? group[Number(variantIndex)] : group[0];
    const fieldMessage = err.errors?.[0]?.message;
    return [
      {
        path: `rows.${row!.line}`,
        message: fieldMessage && fieldMessage !== message ? `${message} ${fieldMessage}` : message,
      },
    ];
  }
}

class ImportRowError extends DomainError {
  readonly status = 422;
  constructor(
    readonly line: number,
    readonly column: Column,
    message: string,
  ) {
    super("import.row_invalid", message);
  }
}
