import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { CSV_BOM, type CsvOptions, type CsvValue, csvLine } from "../../common/csv";

async function write(out: WriteStream, chunk: string): Promise<void> {
  if (!out.write(chunk)) await once(out, "drain");
}

/** Writes a CSV file page by page (BOM, header, rows) and returns the number of data rows. */
export async function writeCsvFile(
  path: string,
  columns: readonly string[],
  pages: AsyncIterable<CsvValue[][]>,
  opts: CsvOptions,
): Promise<number> {
  const out = createWriteStream(path);
  const closed = once(out, "close");
  closed.catch(() => undefined); // an error is rethrown below
  let rows = 0;
  try {
    await write(out, CSV_BOM + csvLine(columns, opts));
    for await (const page of pages) {
      if (page.length === 0) continue;
      await write(out, page.map((r) => csvLine(r, opts)).join(""));
      rows += page.length;
    }
    out.end();
    await closed;
    return rows;
  } catch (err) {
    out.destroy();
    throw err;
  }
}
