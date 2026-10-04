import { describe, expect, it } from "vitest";
import type { ColumnMapping } from "../../db/schema";
import {
  convertRow,
  dataRows,
  detectHeaderRow,
  looseHeader,
  mappingFromPreset,
  mappingProblems,
  normHeader,
  parseMeasure,
  parseMoney,
  parseStatus,
  presetFromMapping,
  splitImages,
  suggestMapping,
} from "./import-plan";

/** The OmniSeller template (PRD 18.2). */
const TEMPLATE = [
  "sku_induk",
  "nama_produk",
  "kategori",
  "merek",
  "deskripsi",
  "sku_varian",
  "nama_varian",
  "atribut_1_nama",
  "atribut_1_nilai",
  "atribut_2_nama",
  "atribut_2_nilai",
  "barcode",
  "hpp",
  "harga_dasar",
  "berat_gram",
  "panjang_cm",
  "lebar_cm",
  "tinggi_cm",
  "stok_awal",
  "gudang",
  "url_gambar_1",
  "url_gambar_2",
];

describe("headers", () => {
  it("compares header names by letters and digits only", () => {
    expect(normHeader("*Berat (gram)")).toBe("beratgram");
    expect(looseHeader("Harga Jual (Rp)")).toBe("hargajual");
    expect(looseHeader("SKU [wajib]")).toBe("sku");
  });

  it("maps every column of the OmniSeller template", () => {
    const m = suggestMapping([TEMPLATE], "omniseller");
    expect(m).toMatchObject({ headerRow: 1, weightUnit: "g", dimensionUnit: "cm" });
    expect(m.fields).toEqual({
      sku_induk: 0,
      nama_produk: 1,
      kategori: 2,
      merek: 3,
      deskripsi: 4,
      sku_varian: 5,
      nama_varian: 6,
      atribut_1_nama: 7,
      atribut_1_nilai: 8,
      atribut_2_nama: 9,
      atribut_2_nilai: 10,
      barcode: 11,
      hpp: 12,
      harga_dasar: 13,
      berat: 14,
      panjang: 15,
      lebar: 16,
      tinggi: 17,
      stok_awal: 18,
      gudang: 19,
      url_gambar_1: 20,
      url_gambar_2: 21,
    });
  });

  it("maps the product CSV of OmniSeller itself, in millimetres", () => {
    const m = suggestMapping(
      [["sku_produk", "nama_produk", "sku_varian", "harga_jual", "berat_gram", "panjang_mm", "gambar"]],
      "omniseller",
    );
    expect(m.fields).toMatchObject({
      sku_induk: 0,
      nama_produk: 1,
      sku_varian: 2,
      harga_dasar: 3,
      berat: 4,
      panjang: 5,
      gambar: 6,
    });
    expect(m.dimensionUnit).toBe("mm");
  });

  it("finds the header below instruction rows and reads units from it (BigSeller style)", () => {
    const rows = [
      ["Petunjuk: isi mulai baris 3. Kolom bertanda * wajib."],
      ["*SKU Gudang", "*Judul", "Modal (Rp)", "Harga Referensi", "Berat (kg)", "GTIN", "Panjang (cm)"],
      ["K-1", "Kaos", "20.000", "50.000", "0,25", "899", "30"],
    ];
    expect(detectHeaderRow(rows, "bigseller")).toBe(2);
    const m = suggestMapping(rows, "bigseller");
    expect(m).toMatchObject({ headerRow: 2, weightUnit: "kg", dimensionUnit: "cm" });
    expect(m.fields).toMatchObject({
      sku_varian: 0,
      nama_produk: 1,
      hpp: 2,
      harga_dasar: 3,
      berat: 4,
      barcode: 5,
      panjang: 6,
    });
  });

  it("uses each app's own names first (Jubelio, Ginee)", () => {
    expect(suggestMapping([["item_code", "item_name", "buy_price", "sell_price", "weight"]], "jubelio").fields).toEqual(
      {
        sku_varian: 0,
        nama_produk: 1,
        hpp: 2,
        harga_dasar: 3,
        berat: 4,
      },
    );
    expect(
      suggestMapping([["SPU", "Master SKU", "Nama Produk", "Nama Variasi", "Harga Jual", "Berat(g)"]], "ginee").fields,
    ).toEqual({
      sku_induk: 0,
      sku_varian: 1,
      nama_produk: 2,
      nama_varian: 3,
      harga_dasar: 4,
      berat: 5,
    });
  });

  it("keeps a mapping by header name and finds the columns again in another order", () => {
    const first = suggestMapping([["SKU", "Nama Produk", "Harga Jual", "Berat"]], "spreadsheet");
    const preset = presetFromMapping(["SKU", "Nama Produk", "Harga Jual", "Berat"], { ...first, weightUnit: "kg" });
    expect(preset).toEqual({
      fields: { sku_varian: "SKU", nama_produk: "Nama Produk", harga_dasar: "Harga Jual", berat: "Berat" },
      weightUnit: "kg",
      dimensionUnit: "cm",
    });
    const again = mappingFromPreset([["catatan"], ["Berat", "Harga Jual", "Nama Produk", "SKU"]], preset);
    expect(again).toEqual({
      headerRow: 2,
      fields: { sku_varian: 3, nama_produk: 2, harga_dasar: 1, berat: 0 },
      weightUnit: "kg",
      dimensionUnit: "cm",
    });
  });

  it("says what is wrong with a mapping", () => {
    const m: ColumnMapping = {
      headerRow: 1,
      fields: { nama_produk: 0, sku_varian: 9, warna: 1 },
      weightUnit: "g",
      dimensionUnit: "cm",
    };
    expect(mappingProblems(m, 3)).toEqual([
      { path: "fields.sku_varian", message: "Kolom berkas tidak ada." },
      { path: "fields.warna", message: "Kolom OmniSeller tidak dikenal." },
      { path: "fields.harga_dasar", message: "Wajib dipetakan." },
      { path: "fields.berat", message: "Wajib dipetakan." },
    ]);
  });
});

describe("values", () => {
  it("reads whole rupiah written the ways spreadsheets do", () => {
    expect(
      ["65000", "65.000", "65,000", "Rp 65.000", "Rp65.000,00", "65000.00", "1.250.000", "64999.99999999999"].map(
        parseMoney,
      ),
    ).toEqual([65000, 65000, 65000, 65000, 65000, 65000, 1250000, 65000]);
    expect(["65000.5", "1,5", "-5", "abc", ""].map(parseMoney)).toEqual([null, null, null, null, null]);
  });

  it("reads measurements with either decimal mark", () => {
    expect(parseMeasure("0,25", false)).toBe(0.25);
    expect(parseMeasure("1.5", false)).toBe(1.5);
    expect(parseMeasure("1.200", true)).toBe(1200);
    expect(parseMeasure("1.200", false)).toBe(1.2);
    expect(parseMeasure("1.234,5", false)).toBe(1234.5);
    expect(parseMeasure("1,234.5", false)).toBe(1234.5);
    expect(parseMeasure("200 gram", true)).toBe(200);
    expect(parseMeasure("berat", true)).toBeNull();
  });

  it("turns other apps' status words into active or archived", () => {
    expect(["Aktif", "On Sale", "", "Nonaktif", "Off Sale", "dihapus"].map(parseStatus)).toEqual([
      "aktif",
      "aktif",
      "",
      "arsip",
      "arsip",
      null,
    ]);
  });

  it("splits image cells", () => {
    expect(splitImages("https://a/1.jpg | https://a/2.jpg;https://a/3.jpg\nhttps://a/4.jpg,https://a/5.jpg")).toEqual([
      "https://a/1.jpg",
      "https://a/2.jpg",
      "https://a/3.jpg",
      "https://a/4.jpg",
      "https://a/5.jpg",
    ]);
  });
});

describe("rows", () => {
  const mapping = suggestMapping([TEMPLATE], "omniseller");
  const row = (over: Record<string, string>) => TEMPLATE.map((h) => over[h] ?? "");

  it("becomes a row of the product template with units converted and initial stock", () => {
    const r = convertRow(
      row({
        sku_induk: "KAOS",
        nama_produk: "Kaos Polos",
        sku_varian: "KAOS-HTM-L",
        nama_varian: "Hitam, L",
        atribut_1_nama: "Warna",
        atribut_1_nilai: "Hitam",
        atribut_2_nama: "Ukuran",
        atribut_2_nilai: "L",
        hpp: "35.000",
        harga_dasar: "Rp 65.000",
        berat_gram: "200",
        panjang_cm: "25",
        lebar_cm: "20,5",
        stok_awal: "120",
        gudang: "Gudang Jakarta",
        url_gambar_1: "https://cdn/1.jpg",
        url_gambar_2: "https://cdn/1.jpg",
      }),
      mapping,
      2,
    );
    expect(r.issues).toEqual([]);
    expect(r.cells).toMatchObject({
      sku_produk: "KAOS",
      sku_varian: "KAOS-HTM-L",
      atribut: "Warna=Hitam; Ukuran=L",
      harga_jual: "65000",
      hpp: "35000",
      berat_gram: "200",
      panjang_mm: "250",
      lebar_mm: "205",
      tinggi_mm: "",
      gambar: "https://cdn/1.jpg",
      status: "",
    });
    expect(r.stock).toEqual({ quantity: 120, warehouse: "Gudang Jakarta" });
  });

  it("gives variants without attribute columns one attribute from their name", () => {
    const m: ColumnMapping = {
      headerRow: 1,
      fields: { nama_produk: 0, sku_varian: 1, nama_varian: 2, harga_dasar: 3, berat: 4 },
      weightUnit: "kg",
      dimensionUnit: "cm",
    };
    expect(convertRow(["Kaos", "K-M", "M", "50000", "0.2"], m, 2).cells).toMatchObject({
      sku_produk: "K-M",
      atribut: "Varian=M",
      berat_gram: "200",
    });
    expect(convertRow(["Kaos", "K-M", "M", "50000", "0.2"], m, 1).cells.atribut).toBe("");
  });

  it("reports what it cannot read, by field", () => {
    const r = convertRow(
      row({
        nama_produk: "Kaos",
        sku_varian: "K-1",
        atribut_1_nama: "Warna",
        harga_dasar: "65.000,50",
        berat_gram: "berat",
        gudang: "UTAMA",
      }),
      mapping,
      1,
    );
    expect(r.issues).toEqual([
      { field: "atribut_1_nilai", message: "Isi nama dan nilai atribut." },
      { field: "harga_dasar", message: "Harus angka rupiah tanpa desimal, misalnya 65000 atau 65.000." },
      { field: "berat", message: "Harus angka lebih dari 0." },
      { field: "stok_awal", message: "Isi stok awal untuk gudang ini, atau kosongkan gudangnya." },
    ]);
  });

  it("counts data rows below the header with their spreadsheet numbers", () => {
    expect(dataRows([["catatan"], ["a", "b"], [], ["1", "2"], ["", " "], ["3"]], 2)).toEqual([
      { line: 4, cells: ["1", "2"] },
      { line: 6, cells: ["3"] },
    ]);
  });
});
