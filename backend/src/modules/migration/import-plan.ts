import type { MigrationSourceApp } from "@omniseller/shared";
import type { FieldIssue } from "../../common/errors/domain-errors";
import type { ColumnMapping, PresetMapping } from "../../db/schema";
import type { ProductCells } from "../catalog/product-transfer.service";

/**
 * Import from another app as pure functions (backend doc 8.19, PRD FR-MIG-01, UI L46 step 2): the
 * OmniSeller fields a file can fill, the header names each app uses for them, guessing the mapping,
 * and turning one row into a row of the product template plus initial stock. The services read the
 * file and the database; everything here is tested without either.
 */

export interface ImportFieldDef {
  key: string;
  label: string;
  required: boolean;
  /** weight takes a unit (g or kg), dimensions cm or mm */
  unit?: "weight" | "dimension";
}

const field = (key: string, label: string, required = false, unit?: ImportFieldDef["unit"]): ImportFieldDef =>
  unit ? { key, label, required, unit } : { key, label, required };

/** OmniSeller fields in the order of the template (PRD 18.2). */
export const IMPORT_FIELDS: readonly ImportFieldDef[] = [
  field("sku_induk", "SKU induk (produk)"),
  field("nama_produk", "Nama produk", true),
  field("kategori", "Kategori"),
  field("merek", "Merek"),
  field("deskripsi", "Deskripsi"),
  field("sku_varian", "SKU varian", true),
  field("nama_varian", "Nama varian"),
  field("atribut", "Atribut dalam satu kolom (Warna=Hitam; Ukuran=L)"),
  ...[1, 2, 3].flatMap((n) => [
    field(`atribut_${n}_nama`, `Atribut ${n}: nama (Warna)`),
    field(`atribut_${n}_nilai`, `Atribut ${n}: nilai (Hitam)`),
  ]),
  field("barcode", "Barcode"),
  field("hpp", "HPP (harga modal)"),
  field("harga_dasar", "Harga jual", true),
  field("berat", "Berat", true, "weight"),
  field("panjang", "Panjang", false, "dimension"),
  field("lebar", "Lebar", false, "dimension"),
  field("tinggi", "Tinggi", false, "dimension"),
  field("status", "Status (aktif atau arsip)"),
  field("gambar", "Gambar (beberapa URL dalam satu kolom)"),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => field(`url_gambar_${n}`, `Gambar ${n} (URL)`)),
  field("stok_awal", "Stok awal"),
  field("gudang", "Gudang (kode atau nama)"),
];

export const FIELD_KEYS = new Set(IMPORT_FIELDS.map((f) => f.key));
export const REQUIRED_FIELDS = IMPORT_FIELDS.filter((f) => f.required).map((f) => f.key);

/** "*Berat (gram)" -> "beratgram": letters and digits only, lower case. */
export function normHeader(s: string): string {
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** The same without bracketed notes: "Harga Jual (Rp)" -> "hargajual". */
export function looseHeader(s: string): string {
  return normHeader(s.replace(/\([^)]*\)|\[[^\]]*\]/g, ""));
}

const numbered = (stems: string[], n: number) => stems.map((s) => `${s}${n}`);

/** Header names, normalized, that usually mean each field; per app ones are tried first. */
const COMMON: Record<string, string[]> = {
  sku_induk: [
    "skuinduk",
    "skuproduk",
    "parentsku",
    "skuparent",
    "skuutama",
    "kodeinduk",
    "productsku",
    "spu",
    "nomorprodukutamasku",
  ],
  nama_produk: ["namaproduk", "productname", "judulproduk", "judul", "namabarang", "itemname", "title", "nama", "name"],
  kategori: ["kategori", "category", "kategoriproduk", "categoryname", "namakategori"],
  merek: ["merek", "merk", "brand", "namamerek"],
  deskripsi: ["deskripsi", "description", "deskripsiproduk", "productdescription", "keterangan"],
  sku_varian: [
    "skuvarian",
    "skuvariasi",
    "variantsku",
    "sku",
    "skugudang",
    "nomorsku",
    "merchantsku",
    "mastersku",
    "msku",
    "sellersku",
    "itemcode",
    "kodebarang",
    "kodesku",
    "kodeitem",
  ],
  nama_varian: [
    "namavarian",
    "namavariasi",
    "variantname",
    "variationname",
    "varian",
    "variasi",
    "variant",
    "variation",
  ],
  atribut: ["atribut", "attributes", "atributvarian"],
  barcode: ["barcode", "gtin", "ean", "upc", "kodebarcode"],
  hpp: [
    "hpp",
    "hargamodal",
    "modal",
    "hargabeli",
    "hargapokok",
    "hargapembelian",
    "costprice",
    "cost",
    "buyprice",
    "purchaseprice",
  ],
  harga_dasar: [
    "hargadasar",
    "hargajual",
    "hargajualnormal",
    "harga",
    "price",
    "sellingprice",
    "sellprice",
    "hargareferensi",
    "referenceprice",
    "hargaeceran",
    "retailprice",
  ],
  berat: [
    "berat",
    "beratgram",
    "beratg",
    "beratgr",
    "beratkg",
    "beratpaket",
    "beratpaketgram",
    "beratproduk",
    "weight",
    "weightg",
    "weightgram",
    "weightkg",
  ],
  panjang: ["panjang", "panjangcm", "panjangmm", "panjangpaket", "length", "lengthcm", "lengthmm"],
  lebar: ["lebar", "lebarcm", "lebarmm", "lebarpaket", "width", "widthcm", "widthmm"],
  tinggi: ["tinggi", "tinggicm", "tinggimm", "tinggipaket", "height", "heightcm", "heightmm"],
  status: ["status", "statusproduk", "statuspenjualan", "statusbarang"],
  gambar: ["gambar", "gambarproduk", "urlgambar", "image", "images", "imageurl", "imageurls", "foto", "fotoproduk"],
  stok_awal: [
    "stokawal",
    "stok",
    "stock",
    "jumlahstok",
    "stoktersedia",
    "stokgudang",
    "availablestock",
    "onhand",
    "qty",
    "kuantitas",
    "jumlah",
  ],
  gudang: ["gudang", "warehouse", "namagudang", "kodegudang", "warehousename", "lokasigudang"],
};
for (const n of [1, 2, 3]) {
  COMMON[`atribut_${n}_nama`] = [
    `atribut${n}nama`,
    `namaatribut${n}`,
    `variasi${n}nama`,
    `namavariasi${n}`,
    `tipevariasi${n}`,
    `variation${n}name`,
    `option${n}name`,
  ];
  COMMON[`atribut_${n}_nilai`] = [
    `atribut${n}nilai`,
    `nilaiatribut${n}`,
    `variasi${n}nilai`,
    `nilaivariasi${n}`,
    `variasi${n}`,
    `variation${n}value`,
    `variation${n}`,
    `option${n}value`,
    `option${n}`,
  ];
}
for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
  COMMON[`url_gambar_${n}`] = [
    ...numbered(["urlgambar", "gambar", "gambarproduk", "image", "imageurl", "foto", "fotoproduk"], n),
    ...(n === 1 ? ["gambarutama", "fotoutama", "mainimage", "coverimage"] : []),
  ];
}

/**
 * Column names each app's product export is known to use (from their help centers as of October
 * 2026), tried before the common ones. They are a first guess: the seller confirms the mapping on
 * the screen and can save their own (FR-MIG-01).
 */
const BY_APP: Partial<Record<MigrationSourceApp, Record<string, string[]>>> = {
  omniseller: {
    sku_induk: ["skuinduk", "skuproduk"],
    harga_dasar: ["hargadasar", "hargajual"],
    berat: ["beratgram"],
  },
  bigseller: {
    sku_varian: ["skugudang", "nomorsku", "sku"],
    nama_produk: ["judul", "namasku", "namaprodukutamasku"],
    sku_induk: ["nomorprodukutamasku", "skuinduk", "parentsku"],
    hpp: ["modal", "hargamodal"],
    harga_dasar: ["hargareferensi", "hargajual"],
    barcode: ["gtin", "barcode"],
  },
  ginee: {
    sku_induk: ["spu", "skuinduk"],
    sku_varian: ["mastersku", "msku", "sku"],
    nama_varian: ["namavariasi", "variasi"],
    hpp: ["hargapembelian", "hargabeli", "hargamodal"],
    harga_dasar: ["hargajual", "price"],
  },
  jubelio: {
    sku_varian: ["itemcode", "kodebarang", "sku"],
    nama_produk: ["itemname", "namabarang"],
    sku_induk: ["itemgroupcode", "kodeinduk"],
    hpp: ["buyprice", "hargabeli"],
    harga_dasar: ["sellprice", "hargajual"],
    berat: ["weight", "beratpaket", "berat"],
  },
};

export const SOURCE_APP_NAMES: Record<MigrationSourceApp, string> = {
  omniseller: "Templat OmniSeller",
  bigseller: "BigSeller",
  ginee: "Ginee",
  jubelio: "Jubelio",
  spreadsheet: "Spreadsheet",
  other: "Aplikasi lain",
};

function synonyms(app: MigrationSourceApp, key: string): string[] {
  return [...(BY_APP[app]?.[key] ?? []), ...(COMMON[key] ?? [])];
}

/** Field -> column for one header row: exact names first, then names without bracketed notes. */
function matchFields(header: readonly string[], app: MigrationSourceApp): Record<string, number> {
  const exact = header.map(normHeader);
  const loose = header.map(looseHeader);
  const used = new Set<number>();
  const fields: Record<string, number> = {};
  for (const names of [exact, loose]) {
    for (const f of IMPORT_FIELDS) {
      if (fields[f.key] !== undefined) continue;
      for (const s of synonyms(app, f.key)) {
        const at = names.findIndex((h, i) => h === s && !used.has(i));
        if (at >= 0) {
          fields[f.key] = at;
          used.add(at);
          break;
        }
      }
    }
  }
  return fields;
}

const unitsOf = (header: readonly string[], fields: Record<string, number>) => {
  const raw = (key: string) => (fields[key] !== undefined ? header[fields[key]!]!.toLowerCase() : "");
  const weightUnit: "g" | "kg" = /\bkg\b|kilo/.test(raw("berat")) ? "kg" : "g";
  const dims = ["panjang", "lebar", "tinggi"].map(raw).join(" ");
  const dimensionUnit: "cm" | "mm" = /\bmm\b|_mm\b|milimeter/.test(dims) ? "mm" : "cm";
  return { weightUnit, dimensionUnit };
};

/** The header is the row among the first ten that names the most fields (at least two). */
export function detectHeaderRow(rows: readonly string[][], app: MigrationSourceApp): number {
  let best = { index: 0, score: 1 };
  rows.slice(0, 10).forEach((row, index) => {
    const score = Object.keys(matchFields(row, app)).length;
    if (score > best.score) best = { index, score };
  });
  return best.index + 1;
}

/** A first mapping for a file (UI L46 step 2: "saran otomatis"). */
export function suggestMapping(rows: readonly string[][], app: MigrationSourceApp): ColumnMapping {
  const headerRow = detectHeaderRow(rows, app);
  const header = rows[headerRow - 1] ?? [];
  const fields = matchFields(header, app);
  return { headerRow, fields, ...unitsOf(header, fields) };
}

/** A saved mapping applied to a new file: columns found by header name. */
export function mappingFromPreset(rows: readonly string[][], preset: PresetMapping): ColumnMapping {
  let best: ColumnMapping = {
    headerRow: 1,
    fields: {},
    weightUnit: preset.weightUnit,
    dimensionUnit: preset.dimensionUnit,
  };
  rows.slice(0, 10).forEach((row, index) => {
    const exact = row.map(normHeader);
    const fields: Record<string, number> = {};
    for (const [key, name] of Object.entries(preset.fields)) {
      if (!FIELD_KEYS.has(key)) continue;
      const at = exact.indexOf(normHeader(name));
      if (at >= 0) fields[key] = at;
    }
    if (Object.keys(fields).length > Object.keys(best.fields).length) best = { ...best, headerRow: index + 1, fields };
  });
  return best;
}

/** The mapping of a job, kept by header name so it fits the next file of the same app. */
export function presetFromMapping(header: readonly string[], mapping: ColumnMapping): PresetMapping {
  const fields: Record<string, string> = {};
  for (const [key, at] of Object.entries(mapping.fields)) {
    const name = header[at];
    if (name?.trim()) fields[key] = name;
  }
  return { fields, weightUnit: mapping.weightUnit, dimensionUnit: mapping.dimensionUnit };
}

/** What makes a mapping unusable: unknown fields, columns outside the file, required fields missing. */
export function mappingProblems(mapping: ColumnMapping, columns: number): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const [key, at] of Object.entries(mapping.fields)) {
    if (!FIELD_KEYS.has(key)) issues.push({ path: `fields.${key}`, message: "Kolom OmniSeller tidak dikenal." });
    else if (!Number.isInteger(at) || at < 0 || at >= columns) {
      issues.push({ path: `fields.${key}`, message: "Kolom berkas tidak ada." });
    }
  }
  for (const key of REQUIRED_FIELDS) {
    if (mapping.fields[key] === undefined) issues.push({ path: `fields.${key}`, message: "Wajib dipetakan." });
  }
  return issues;
}

// ---- values ---------------------------------------------------------------------------------

const clean = (s: string) =>
  s
    .replace(/ /g, " ")
    .trim()
    .replace(/^(rp\.?|idr)\s*/i, "")
    .replace(/\s+/g, "");

/**
 * Whole rupiah from what spreadsheets hold: "65000", "65.000", "65,000", "Rp 65.000,00",
 * "65000.0". Decimals other than zero are refused: prices are whole rupiah.
 */
export function parseMoney(text: string): number | null {
  const v = clean(text);
  if (/^\d+$/.test(v)) return Number(v);
  if (/^\d{1,3}([.,]\d{3})+$/.test(v)) return Number(v.replace(/[.,]/g, ""));
  const zeroCents = /^(\d+|\d{1,3}(?:[.,]\d{3})+)[.,]0{1,2}$/.exec(v);
  if (zeroCents) return Number(zeroCents[1]!.replace(/[.,]/g, ""));
  // Excel keeps 65000 as "65000"; computed cells can carry float noise ("64999.99999999999")
  if (/^\d+\.\d+$/.test(v)) {
    const n = Number(v);
    if (Math.abs(n - Math.round(n)) < 1e-6) return Math.round(n);
  }
  return null;
}

/**
 * A measurement as a number: "1200", "1.200" (thousands in grams), "0,2" or "0.2" (decimal),
 * "1.234,5", "1,234.5". With one separator and three digits after it, grams and millimetres read it
 * as thousands; kilograms and centimetres as a decimal.
 */
export function parseMeasure(text: string, integerUnit: boolean): number | null {
  const v = clean(text).replace(/(gram|gr|kg|g|cm|mm)$/i, "");
  if (/^\d+$/.test(v)) return Number(v);
  const both = /^(\d{1,3}(?:([.,])\d{3})*)([.,])(\d+)$/.exec(v);
  if (both?.[2] && both[2] !== both[3]) return Number(`${both[1]!.replace(/[.,]/g, "")}.${both[4]}`);
  const one = /^(\d+)([.,])(\d+)$/.exec(v);
  if (one) {
    if (integerUnit && one[3]!.length === 3) return Number(one[1]! + one[3]!);
    return Number(`${one[1]}.${one[3]}`);
  }
  if (/^\d{1,3}([.,])\d{3}(\1\d{3})+$/.test(v)) return Number(v.replace(/[.,]/g, ""));
  return null;
}

const ACTIVE = new Set(["aktif", "active", "ya", "yes", "1", "true", "normal", "dijual", "onsale", "tersedia", "live"]);
const ARCHIVED = new Set([
  "arsip",
  "archived",
  "nonaktif",
  "inactive",
  "tidakaktif",
  "tidak",
  "no",
  "0",
  "false",
  "offsale",
  "tidakdijual",
  "delisted",
  "unlisted",
]);

/** Status words of other apps to the template's `aktif` or `arsip`; empty means active. */
export function parseStatus(text: string): "aktif" | "arsip" | "" | null {
  const v = normHeader(text);
  if (!v) return "";
  if (ACTIVE.has(v)) return "aktif";
  if (ARCHIVED.has(v)) return "arsip";
  return null;
}

/** Image URLs from one cell: separated by `|`, `;`, new lines, or commas between URLs. */
export function splitImages(text: string): string[] {
  return text
    .split(/\s*\|\s*|\s*;\s*|\s*[\r\n]+\s*|\s*,\s*(?=https?:)/)
    .map((u) => u.trim())
    .filter(Boolean);
}

// ---- rows -----------------------------------------------------------------------------------

/** Images a product takes (catalog, backend doc 8.12). */
const MAX_IMAGES = 9;

/** Template columns of the product import to the import field they come from, for error paths. */
export const FIELD_OF_COLUMN: Record<keyof ProductCells, string> = {
  sku_produk: "sku_induk",
  nama_produk: "nama_produk",
  deskripsi: "deskripsi",
  merek: "merek",
  kategori: "kategori",
  sku_varian: "sku_varian",
  nama_varian: "nama_varian",
  atribut: "atribut",
  barcode: "barcode",
  harga_jual: "harga_dasar",
  hpp: "hpp",
  berat_gram: "berat",
  panjang_mm: "panjang",
  lebar_mm: "lebar",
  tinggi_mm: "tinggi",
  status: "status",
  gambar: "gambar",
};

export interface RowConversion {
  cells: ProductCells;
  /** Initial stock asked for by the row: quantity and warehouse as written (empty: default warehouse). */
  stock: { quantity: number; warehouse: string } | null;
  /** Problems found while converting, by import field. */
  issues: { field: string; message: string }[];
}

/** The cell of a field, trimmed; empty when the field is not mapped. */
export function cellOf(row: readonly string[], mapping: ColumnMapping, key: string): string {
  const at = mapping.fields[key];
  return at === undefined ? "" : (row[at] ?? "").trim();
}

/**
 * One row of the file as a row of the product template (FR-PRD-04 columns) plus initial stock.
 * `variantsInProduct` is how many rows share the product: several variants without attribute
 * columns get one attribute "Varian" from the variant name, so they stay apart (attribute rules,
 * backend doc 7.8.3).
 */
export function convertRow(row: readonly string[], mapping: ColumnMapping, variantsInProduct: number): RowConversion {
  const issues: RowConversion["issues"] = [];
  const get = (key: string) => cellOf(row, mapping, key);
  const variantSku = get("sku_varian");

  const money = (key: string): string => {
    const raw = get(key);
    if (!raw) return "";
    const n = parseMoney(raw);
    if (n === null) {
      issues.push({ field: key, message: "Harus angka rupiah tanpa desimal, misalnya 65000 atau 65.000." });
      return "";
    }
    return String(n);
  };
  const measure = (key: string, factor: number, integerUnit: boolean): string => {
    const raw = get(key);
    if (!raw) return "";
    const n = parseMeasure(raw, integerUnit);
    if (n === null || n <= 0) {
      issues.push({ field: key, message: "Harus angka lebih dari 0." });
      return "";
    }
    return String(Math.max(1, Math.round(n * factor)));
  };

  let atribut = get("atribut");
  if (!atribut) {
    const pairs: string[] = [];
    for (const n of [1, 2, 3]) {
      const name = get(`atribut_${n}_nama`);
      const value = get(`atribut_${n}_nilai`);
      if (name && value) pairs.push(`${name}=${value}`);
      else if (name || value) {
        issues.push({ field: `atribut_${n}_${name ? "nilai" : "nama"}`, message: "Isi nama dan nilai atribut." });
      }
    }
    atribut = pairs.join("; ");
  }
  if (!atribut && variantsInProduct > 1) atribut = `Varian=${get("nama_varian") || variantSku}`;

  const status = parseStatus(get("status"));
  if (status === null) issues.push({ field: "status", message: 'Isi "aktif" atau "arsip".' });

  const images = [
    ...new Set([
      ...splitImages(get("gambar")),
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => splitImages(get(`url_gambar_${n}`))),
    ]),
  ];
  if (images.length > MAX_IMAGES) {
    issues.push({ field: "gambar", message: `Maksimal ${MAX_IMAGES} gambar per produk.` });
  }

  let stock: RowConversion["stock"] = null;
  const quantity = get("stok_awal");
  if (quantity) {
    const n = parseMoney(quantity);
    if (n === null) issues.push({ field: "stok_awal", message: "Harus bilangan bulat 0 atau lebih." });
    else stock = { quantity: n, warehouse: get("gudang") };
  } else if (get("gudang")) {
    issues.push({ field: "stok_awal", message: "Isi stok awal untuk gudang ini, atau kosongkan gudangnya." });
  }

  const weightFactor = mapping.weightUnit === "kg" ? 1000 : 1;
  const dimFactor = mapping.dimensionUnit === "cm" ? 10 : 1;
  const cells: ProductCells = {
    sku_produk: get("sku_induk") || variantSku,
    nama_produk: get("nama_produk"),
    deskripsi: get("deskripsi"),
    merek: get("merek"),
    kategori: get("kategori"),
    sku_varian: variantSku,
    nama_varian: get("nama_varian"),
    atribut,
    barcode: get("barcode"),
    harga_jual: money("harga_dasar"),
    hpp: money("hpp"),
    berat_gram: measure("berat", weightFactor, mapping.weightUnit === "g"),
    panjang_mm: measure("panjang", dimFactor, mapping.dimensionUnit === "mm"),
    lebar_mm: measure("lebar", dimFactor, mapping.dimensionUnit === "mm"),
    tinggi_mm: measure("tinggi", dimFactor, mapping.dimensionUnit === "mm"),
    status: status || "",
    gambar: images.slice(0, MAX_IMAGES).join(" | "),
  };
  // problems in the order of the template's columns, left to right
  issues.sort((a, b) => FIELD_ORDER.get(a.field)! - FIELD_ORDER.get(b.field)!);
  return { cells, stock, issues };
}

const FIELD_ORDER = new Map(IMPORT_FIELDS.map((f, i) => [f.key, i]));

/** Rows below the header that hold anything. */
export function dataRows(rows: readonly string[][], headerRow: number): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  rows.forEach((cells, i) => {
    if (i + 1 > headerRow && cells.some((c) => c.trim() !== "")) out.push({ line: i + 1, cells });
  });
  return out;
}
