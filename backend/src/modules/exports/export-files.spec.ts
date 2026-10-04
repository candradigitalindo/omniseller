import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CSV_BOM } from "../../common/csv";
import { writeCsvFile } from "./csv-file";
import { exportReadme } from "./readme";
import { writeZip } from "./zip";

async function* pages(...list: unknown[][][]) {
  for (const p of list) yield p as never;
}

describe("export files", () => {
  let dir: string;
  beforeAll(async () => {
    const base = resolve(__dirname, "../../../.local");
    await mkdir(base, { recursive: true });
    dir = await mkdtemp(join(base, "export-spec-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("writes a CSV page by page and counts its data rows", async () => {
    const path = join(dir, "pesanan.csv");
    const rows = await writeCsvFile(
      path,
      ["no_pesanan", "total", "dipesan_pada", "cod"],
      pages(
        [
          ["A-1", 50_000, new Date("2026-10-03T07:15:00Z"), true],
          ["A-2", 75_000, null, false],
        ],
        [],
        [["=A-3", 0, null, null]],
      ),
      { timeZone: "Asia/Jakarta" },
    );
    expect(rows).toBe(3);
    expect(await readFile(path, "utf8")).toBe(
      `${CSV_BOM}no_pesanan;total;dipesan_pada;cod\r\n` +
        "A-1;50000;2026-10-03T14:15:00+07:00;ya\r\n" +
        "A-2;75000;;tidak\r\n" +
        "'=A-3;0;;\r\n",
    );
  });

  it("zips files from disk and text into one archive", async () => {
    const csv = join(dir, "toko.csv");
    await writeCsvFile(csv, ["id", "nama_toko"], pages([["01T", "Toko Utama"]]), {});
    const zipPath = join(dir, "ekspor.zip");
    await writeZip(zipPath, [
      { name: "README.txt", content: "halo\r\n" },
      { name: "toko.csv", path: csv },
    ]);
    const files = unzipSync(new Uint8Array(await readFile(zipPath)));
    expect(Object.keys(files)).toEqual(["README.txt", "toko.csv"]);
    // keep the BOM: TextDecoder drops it unless told not to
    const text = (b: Uint8Array | undefined) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);
    expect(text(files["README.txt"])).toBe("halo\r\n");
    expect(text(files["toko.csv"])).toBe(`${CSV_BOM}id;nama_toko\r\n01T;Toko Utama\r\n`);
  });

  it("explains every file and code in the README", () => {
    const text = exportReadme({
      business: "Toko Rina",
      timezone: "Asia/Jakarta",
      at: new Date("2026-10-03T07:15:00Z"),
      files: [
        { name: "pesanan.csv", rows: 12, description: "Pesanan." },
        { name: "stok.csv", rows: 0, description: "Stok." },
      ],
    });
    expect(text).toContain("Bisnis : Toko Rina");
    expect(text).toContain("Dibuat : 2026-10-03T14:15:00+07:00 (Asia/Jakarta)");
    expect(text).toContain("- pesanan.csv (12 baris): Pesanan.");
    expect(text).toContain("- ready_to_pack: Siap Dikemas");
    expect(text).toContain("- handed_over: diserahkan ke kurir");
    expect(text).toContain("- published: sudah diterbitkan ke toko tujuan");
    expect(text).toContain("- migration_initial: stok awal saat pindah ke OmniSeller");
    expect(text).toContain("- damaged: Rusak");
    expect(text.endsWith("\r\n")).toBe(true);
  });
});
