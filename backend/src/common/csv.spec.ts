import { describe, expect, it } from "vitest";
import { detectDelimiter, parseCsv } from "../modules/catalog/csv";
import { CSV_BOM, csvCell, csvLine, toCsv, unguardCell } from "./csv";

describe("CSV writer (common/csv.ts)", () => {
  it("quotes fields holding the delimiter, quotes, or line breaks (RFC 4180)", () => {
    expect(csvCell("Kaos; Hitam")).toBe('"Kaos; Hitam"');
    expect(csvCell('Ukuran "L"')).toBe('"Ukuran ""L"""');
    expect(csvCell("baris 1\nbaris 2")).toBe('"baris 1\nbaris 2"');
    expect(csvCell("Kaos, Hitam")).toBe("Kaos, Hitam");
    expect(csvCell("Kaos, Hitam", { delimiter: "," })).toBe('"Kaos, Hitam"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("guards text a spreadsheet would run as a formula, and leaves numbers alone", () => {
    expect(csvCell('=HYPERLINK("http://contoh.test")')).toBe(`"'=HYPERLINK(""http://contoh.test"")"`);
    expect(csvCell("+62 812 0000")).toBe("'+62 812 0000");
    expect(csvCell("- Bahan katun")).toBe("'- Bahan katun");
    expect(csvCell("@pembeli")).toBe("'@pembeli");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("'=x")).toBe("''=x");
    expect(csvCell("'biasa")).toBe("'biasa");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(65000)).toBe("65000");
  });

  it("writes yes/no in Indonesian and times in the business's zone with the offset", () => {
    expect(csvCell(true)).toBe("ya");
    expect(csvCell(false)).toBe("tidak");
    const at = new Date("2026-10-03T07:15:00.000Z");
    expect(csvCell(at, { timeZone: "Asia/Jakarta" })).toBe("2026-10-03T14:15:00+07:00");
    expect(csvCell(at)).toBe("2026-10-03T07:15:00.000Z");
  });

  it("writes a BOM, then lines ending in CRLF", () => {
    expect(
      toCsv([
        ["a", "b"],
        [1, null],
      ]),
    ).toBe(`${CSV_BOM}a;b\r\n1;\r\n`);
    expect(csvLine(["x", 2], { delimiter: "," })).toBe("x,2\r\n");
  });

  it("reads back what it wrote: the product import drops the guard again", () => {
    const rows = [
      ["sku_produk", "deskripsi"],
      ["=SKU-1", "- Bahan katun\n- Ukuran L"],
      ["'biasa", "'=bukan rumus"],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
    expect(unguardCell("'=1+1")).toBe("=1+1");
    expect(unguardCell("''=1")).toBe("'=1");
    expect(unguardCell("'abc")).toBe("'abc");
    expect(unguardCell("=1")).toBe("=1");
  });
});

describe("CSV reader delimiter (catalog/csv.ts)", () => {
  it("finds the delimiter below a title row without any", () => {
    const text = "Ekspor Produk BigSeller - Toko Rina\r\nJudul;SKU;Berat\r\nKemeja;MIG-1-S;0,3\r\n";
    expect(detectDelimiter(text)).toBe(";");
    expect(parseCsv(text)).toEqual([
      ["Ekspor Produk BigSeller - Toko Rina"],
      ["Judul", "SKU", "Berat"],
      ["Kemeja", "MIG-1-S", "0,3"],
    ]);
  });

  it("does not count commas inside quoted values", () => {
    const text = 'name,weight\n"Kaos, Hitam","0,25"\n"Topi; Rajut","0,1"\n';
    expect(detectDelimiter(text)).toBe(",");
    expect(parseCsv(text)[1]).toEqual(["Kaos, Hitam", "0,25"]);
  });

  it("keeps a decimal comma in a semicolon file a value", () => {
    expect(detectDelimiter("SKU;Berat;Harga\nA;0,25;65.000\nB;1,5;70.000")).toBe(";");
  });
});
