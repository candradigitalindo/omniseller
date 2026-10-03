import { createWriteStream } from "node:fs";
import { ZipFile } from "yazl";

export type ZipEntry = { name: string; path: string } | { name: string; content: string };

/**
 * Writes a ZIP to `out`, streaming each file from disk (yazl: deflate, ZIP64 when a file passes 4 GB),
 * so an export never has to fit in memory.
 */
export async function writeZip(out: string, entries: ZipEntry[], mtime = new Date()): Promise<void> {
  const zip = new ZipFile();
  const done = new Promise<void>((resolve, reject) => {
    const file = createWriteStream(out);
    file.on("close", () => resolve());
    file.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(file);
  });
  for (const e of entries) {
    if ("path" in e) zip.addFile(e.path, e.name, { mtime, compress: true });
    else zip.addBuffer(Buffer.from(e.content, "utf8"), e.name, { mtime, compress: true });
  }
  zip.end();
  await done;
}
