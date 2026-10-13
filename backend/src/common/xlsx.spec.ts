import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readXlsx } from "../modules/migration/xlsx";
import { columnLetters, MAX_CELL_CHARS, sheetName, toXlsx, XLSX_MIME, xmlEscape } from "./xlsx";

const parts = (bytes: Uint8Array) => {
  const files = unzipSync(bytes);
  return { names: Object.keys(files), text: (name: string) => strFromU8(files[name]!) };
};

describe("xlsx writer", () => {
  it("writes a workbook the in-house reader and Excel's package rules accept", () => {
    const at = new Date("2026-10-03T07:15:00Z");
    const bytes = toXlsx(
      [
        {
          name: "Per produk",
          columns: ["sku", "produk", "unit", "omzet", "aktif", "diubah", "kosong"],
          rows: [
            ["KAOS-M", "Kaos & <Polos>", 3, 195_000, true, at, null],
            ["=SUM(A1)", 'Tali "kuat"', 0, 0.5, false, undefined, undefined],
          ],
        },
      ],
      { timeZone: "Asia/Jakarta" },
    );
    expect(XLSX_MIME).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // the ZIP starts like every .xlsx
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]);
    const zip = parts(bytes);
    expect(zip.names).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(zip.text("[Content_Types].xml")).toContain('PartName="/xl/worksheets/sheet1.xml"');
    expect(zip.text("[Content_Types].xml")).toContain('PartName="/xl/styles.xml"');
    expect(zip.text("_rels/.rels")).toContain('Target="xl/workbook.xml"');
    expect(zip.text("xl/_rels/workbook.xml.rels")).toContain('Target="worksheets/sheet1.xml"');
    expect(zip.text("xl/_rels/workbook.xml.rels")).toContain('Target="styles.xml"');
    expect(zip.text("xl/workbook.xml")).toContain('<sheet name="Per produk" sheetId="1" r:id="rId1"/>');

    // the reader used for migration uploads reads the same values back; numbers stay numbers, the rest is text
    const read = readXlsx(bytes, 100);
    expect(read).toEqual({
      rows: [
        ["sku", "produk", "unit", "omzet", "aktif", "diubah", "kosong"],
        ["KAOS-M", "Kaos & <Polos>", "3", "195000", "ya", "2026-10-03T14:15:00+07:00"],
        ["=SUM(A1)", 'Tali "kuat"', "0", "0.5", "tidak"],
      ],
      truncated: false,
    });
    const sheet = zip.text("xl/worksheets/sheet1.xml");
    // the header is bold (style 1) and frozen; data cells carry no style
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">');
    expect(sheet).toContain('<c r="A2" t="inlineStr">');
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    // the schema's order of a worksheet's children, and the style parts Excel insists on
    expect(sheet).toMatch(/<sheetViews>[\s\S]*<\/sheetViews><cols>[\s\S]*<\/cols><sheetData>/);
    const styles = zip.text("xl/styles.xml");
    for (const part of ["<fonts ", "<fills ", "<borders ", "<cellStyleXfs ", "<cellXfs ", "<cellStyles "]) {
      expect(styles).toContain(part);
    }
    expect(styles.indexOf("<fonts ")).toBeLessThan(styles.indexOf("<fills "));
    expect(styles.indexOf("<cellStyleXfs ")).toBeLessThan(styles.indexOf("<cellXfs "));
    // text is escaped, never a formula: an inline string starting with = is just text
    expect(sheet).toContain("Kaos &amp; &lt;Polos&gt;");
    expect(sheet).toContain('<t xml:space="preserve">=SUM(A1)</t>');
    expect(sheet).not.toContain("<f>");
    // numbers are numbers
    expect(sheet).toContain('<c r="D2"><v>195000</v></c>');
    // columns get a width from their longest text, within bounds
    expect(sheet).toContain('<col min="1" max="1" width="10" customWidth="1"/>');
    expect(sheet).toContain('<col min="6" max="6" width="27" customWidth="1"/>');
    expect(sheet).toContain('<col min="7" max="7" width="8" customWidth="1"/>');
    // a column of short text stays readable, a column of long text stops growing
    expect(sheet).toContain('<col min="3" max="3" width="8" customWidth="1"/>');
    const wide = strFromU8(
      unzipSync(toXlsx([{ name: "W", columns: ["c"], rows: [["x".repeat(200)]] }]))["xl/worksheets/sheet1.xml"]!,
    );
    expect(wide).toContain('<col min="1" max="1" width="60" customWidth="1"/>');
  });

  it("keeps several sheets in order, each with its own name, and drops what a cell cannot hold", () => {
    const bytes = toXlsx([
      { name: "Per anggota", columns: ["nama"], rows: [["Rina"]] },
      { name: "Per anggota", columns: ["tanggal"], rows: [["2026-10-01"]] },
      { name: "Laporan: penjualan/retur [2026]*?\\", columns: ["x"], rows: [[Number.NaN], [Number.POSITIVE_INFINITY]] },
    ]);
    const zip = parts(bytes);
    expect(zip.text("xl/workbook.xml")).toContain(
      '<sheet name="Per anggota" sheetId="1" r:id="rId1"/><sheet name="Per anggota 2" sheetId="2" r:id="rId2"/><sheet name="Laporan penjualan retur 2026" sheetId="3" r:id="rId3"/>',
    );
    expect(zip.names.filter((n) => n.startsWith("xl/worksheets/"))).toEqual([
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
      "xl/worksheets/sheet3.xml",
    ]);
    expect(zip.text("xl/worksheets/sheet2.xml")).toContain("2026-10-01");
    // a NaN or an infinite number is no cell at all: the row stays, empty
    expect(zip.text("xl/worksheets/sheet3.xml")).toContain('<row r="2"></row><row r="3"></row>');
    expect(() => toXlsx([])).toThrow("at least one sheet");
  });

  it("escapes XML, strips control characters, and caps a cell's text", () => {
    expect(xmlEscape(`a<b>&"c'\u0000\u0007d\te`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;d\te");
    const long = "x".repeat(MAX_CELL_CHARS + 10);
    const bytes = toXlsx([{ name: "L", columns: ["c"], rows: [[long], ["\u0001bersih"], ["Model_x0041_ _x000D_"]] }]);
    const rows = readXlsx(bytes, 10).rows;
    expect(rows[1]![0]!.length).toBe(MAX_CELL_CHARS);
    expect(rows[2]![0]).toBe("bersih");
    // text that looks like Excel's own escape stays text
    expect(rows[3]![0]).toBe("Model_x0041_ _x000D_");
  });

  it("writes times in the business's zone when given, else UTC, like the CSV", () => {
    const at = new Date("2026-10-03T07:15:00Z");
    const inZone = readXlsx(toXlsx([{ name: "W", columns: ["t"], rows: [[at]] }], { timeZone: "Asia/Makassar" }), 5);
    const utc = readXlsx(toXlsx([{ name: "W", columns: ["t"], rows: [[at]] }]), 5);
    expect(inZone.rows[1]).toEqual(["2026-10-03T15:15:00+08:00"]);
    expect(utc.rows[1]).toEqual(["2026-10-03T07:15:00.000Z"]);
  });

  it("names columns and sheets the way Excel does", () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnLetters)).toEqual([
      "A",
      "Z",
      "AA",
      "AB",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
    ]);
    const taken = new Set(["per anggota", "per anggota 2"]);
    expect(sheetName("Per anggota", taken)).toBe("Per anggota 3");
    expect(sheetName("   ", new Set())).toBe("Lembar");
    expect(sheetName("a".repeat(40), new Set())).toHaveLength(31);
    expect(sheetName("a".repeat(40), new Set(["a".repeat(31)]))).toBe(`${"a".repeat(29)} 2`);
  });
});
