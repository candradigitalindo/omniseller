import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { readSheet, sniffSheetType } from "./sheet";
import { columnIndex, readXlsx, SheetError, xmlText } from "./xlsx";

const WORKBOOK = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Petunjuk" sheetId="1" state="hidden" r:id="rId9"/><sheet name="Produk" sheetId="2" r:id="rId1"/></sheets></workbook>`;
const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="x" Target="/xl/worksheets/sheet9.xml"/></Relationships>`;
const SST = `<sst><si><t>SKU Gudang</t></si><si><r><t>Nama </t></r><r><t xml:space="preserve">SKU</t></r><rPh><t>nama</t></rPh></si><si><t>Kaos &amp; Topi_x000D_</t></si></sst>`;
const SHEET = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Berat (kg)</t></is></c></row><row r="3"><c r="A3" t="str"><f>A1</f><v>KAOS-1</v></c><c r="B3" t="s"><v>2</v></c><c r="C3"><v>65000</v></c><c r="D3"><v>0.2</v></c><c r="E3" t="b"><v>1</v></c><c r="F3" t="e"><v>#N/A</v></c></row></sheetData></worksheet>`;
const HIDDEN = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>jangan dibaca</t></is></c></row></sheetData></worksheet>`;

const parts = (sheet = SHEET) => ({
  "[Content_Types].xml": strToU8("<Types/>"),
  "xl/workbook.xml": strToU8(WORKBOOK),
  "xl/_rels/workbook.xml.rels": strToU8(RELS),
  "xl/sharedStrings.xml": strToU8(SST),
  "xl/worksheets/sheet1.xml": strToU8(sheet),
  "xl/worksheets/sheet9.xml": strToU8(HIDDEN),
});

const EXPECTED = [
  ["SKU Gudang", "Nama SKU", "", "Berat (kg)"],
  [],
  ["KAOS-1", "Kaos & Topi\r", "65000", "0.2", "TRUE", ""],
];

function yazlZip(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  const zip = new ZipFile();
  for (const [name, bytes] of Object.entries(files)) zip.addBuffer(Buffer.from(bytes), name);
  zip.end();
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (c: Buffer) => chunks.push(c));
    zip.outputStream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
  });
}

describe("XLSX reader", () => {
  it("reads the first visible sheet: shared, rich, inline, formula, number, boolean, and error cells", () => {
    expect(readXlsx(zipSync(parts()), 100)).toEqual({ rows: EXPECTED, truncated: false });
  });

  it("reads ZIPs whose sizes come after the data (streaming writers)", async () => {
    expect(readXlsx(await yazlZip(parts()), 100).rows).toEqual(EXPECTED);
  });

  it("stops at the row limit and says there was more", () => {
    expect(readXlsx(zipSync(parts()), 2)).toEqual({ rows: [EXPECTED[0]], truncated: true });
  });

  it("refuses a small file that would expand beyond the limit (ZIP bomb)", () => {
    const bomb = zipSync({ ...parts(), "xl/worksheets/sheet1.xml": new Uint8Array(120 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => readXlsx(bomb, 100)).toThrow(/terlalu besar/);
  });

  it("refuses files that are not workbooks", () => {
    expect(() => readXlsx(zipSync({ "a.txt": strToU8("x") }), 100)).toThrow(SheetError);
    expect(() => readXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 100)).toThrow(SheetError);
  });

  it("decodes XML references and OOXML escapes, and column letters", () => {
    expect(xmlText("&lt;b&gt; &#65;&#x42; _x0041_")).toBe("<b> AB A");
    expect([columnIndex("A1"), columnIndex("Z9"), columnIndex("AA10"), columnIndex("AZ")]).toEqual([0, 25, 26, 51]);
  });
});

describe("file type and CSV", () => {
  it("knows files by their content, not their name", () => {
    expect(sniffSheetType(zipSync(parts()))).toBe("xlsx");
    expect(sniffSheetType(strToU8("sku;nama\n"))).toBe("csv");
    expect(() => sniffSheetType(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]))).toThrow(/\.xls lama/);
    expect(() => sniffSheetType(new Uint8Array([1, 0, 2, 3]))).toThrow(/Excel/);
  });

  it("keeps blank rows so row numbers match the spreadsheet, and reads Windows-1252", () => {
    const text = Buffer.concat([Buffer.from("SKU;Nama\r\n\r\nK-1;Caf"), Buffer.from([0xe9]), Buffer.from("\r\n")]);
    expect(readSheet(new Uint8Array(text), 100)).toEqual({
      type: "csv",
      rows: [["SKU", "Nama"], [""], ["K-1", "Café"]],
      truncated: false,
    });
    expect(readSheet(strToU8("﻿a;b\r\n1;2\r\n3;4\r\n"), 2)).toMatchObject({
      rows: [
        ["a", "b"],
        ["1", "2"],
      ],
      truncated: true,
    });
  });
});
