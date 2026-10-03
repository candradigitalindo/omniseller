import type { Tx } from "../db/client";
import type { CsvValue } from "./csv";

/** Names the sheets show next to ids, read once before the sheets run (stores, warehouses, users are few). */
export interface ExportLookups {
  storeName(id: string | null): string | null;
  warehouseCode(id: string | null): string | null;
  userName(id: string | null): string | null;
}

/**
 * One CSV file of the full data export (PRD FR-MIG-09, backend doc 8.18). The module that owns the
 * data defines its sheets, so every table is read by its owner (backend doc 11); the `exports`
 * module writes the rows, zips the files, and stores the ZIP.
 */
export interface ExportSheet {
  /** File name inside the ZIP, e.g. `pesanan.csv`. */
  file: string;
  /** One line for README.txt in the ZIP. */
  description: string;
  columns: readonly string[];
  /**
   * Rows page by page, read inside the export's single snapshot transaction (repeatable read): every
   * file shows the same moment. Each page is one short query (statement timeout 5 s).
   */
  pages(tx: Tx, lookups: ExportLookups): AsyncIterable<CsvValue[][]>;
}

/** Rows per query of an export sheet. */
export const EXPORT_PAGE_SIZE = 2_000;

/** Keyset pages: `read(after)` returns up to EXPORT_PAGE_SIZE rows with ids above `after`, in id order. */
export async function* keysetPages<R extends { id: string }>(
  read: (after: string | undefined) => Promise<R[]>,
  toRows: (page: R[]) => Promise<CsvValue[][]> | CsvValue[][],
): AsyncIterable<CsvValue[][]> {
  let after: string | undefined;
  for (;;) {
    const page = await read(after);
    if (page.length === 0) return;
    yield await toRows(page);
    if (page.length < EXPORT_PAGE_SIZE) return;
    after = page[page.length - 1]!.id;
  }
}

/** A sheet small enough for one query (stores, warehouses). */
export async function* singlePage(read: () => Promise<CsvValue[][]>): AsyncIterable<CsvValue[][]> {
  yield await read();
}
