import type {
  CategoryAttribute,
  CategoryRules,
  ProductAttributeValue,
  ProductToCreate,
  SourceProduct,
} from "@omniseller/connector-core";
import type { DraftAttribute, DraftImage, DraftProblem, DraftSource, DraftVariant } from "../../db/schema";

/**
 * What a copied listing becomes in the target store (PRD FR-PRD-13, backend doc 8.25). Pure functions:
 * the worker reads the marketplaces and the database, these decide, and the services store the result.
 *
 * - content: title, description, images, package, variations, and prices as the source has them, with
 *   the chosen price change
 * - attributes: same marketplace, by id; another marketplace, by name (and a few known synonyms), each
 *   value matched to the target's list by name, or typed where the target takes text
 * - problems: everything the target's category and limits would refuse, before anything is sent
 */

export interface DraftContent {
  title: string;
  description: string;
  descriptionHtml: string | null;
  externalCategoryId: string | null;
  categoryPath: string | null;
  brand: { externalId: string | null; name: string | null } | null;
  attributes: DraftAttribute[];
  images: DraftImage[];
  sizeChart: DraftImage | null;
  weightG: number | null;
  dimensionsMm: { length: number; width: number; height: number } | null;
  condition: "new" | "used";
  preOrderDays: number | null;
  itemSku: string | null;
  variationNames: string[];
  variants: DraftVariant[];
}

/** Lower case, accents and punctuation removed, spaces collapsed: names that differ only in form match. */
export function normalizeName(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Attribute names the two marketplaces use for the same thing in Indonesian listings. */
const ATTRIBUTE_SYNONYMS: string[][] = [
  ["negara asal", "asal negara", "negara produksi", "asal produk", "country of origin"],
  ["bahan", "material", "bahan utama", "bahan produk"],
  ["masa garansi", "garansi", "periode garansi", "warranty period", "durasi garansi"],
  ["jenis garansi", "tipe garansi", "warranty type"],
  ["berat bersih", "berat produk", "net weight"],
  ["barang impor", "produk impor", "imported goods"],
];

const VALUE_SYNONYMS: string[][] = [
  ["tiongkok", "china", "cina"],
  ["poliester", "polyester"],
  ["ya", "yes", "iya"],
  ["tidak", "no", "bukan"],
];

function synonymKey(name: string, table: string[][]): string {
  const n = normalizeName(name);
  const group = table.find((g) => g.includes(n));
  return group ? group[0]! : n;
}

/** A price after the copy's price change: whole rupiah, rounded to hundreds from Rp 1,000. */
export function adjustPrice(price: number, percent: number): number {
  if (!percent) return price;
  const raw = Math.max(1, Math.round((price * (100 + percent)) / 100));
  return raw >= 1000 ? Math.round(raw / 100) * 100 : raw;
}

const NUMBER_WITH_UNIT = /^\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)\s*$/;

function valueFor(
  target: CategoryAttribute,
  value: { externalId: string | null; name: string | null; unit?: string | null },
): DraftAttribute["values"][number] | null {
  const name = value.name?.trim() ?? "";
  if (!name) return null;
  const key = synonymKey(name, VALUE_SYNONYMS);
  const listed = target.values.find((v) => synonymKey(v.name, VALUE_SYNONYMS) === key);
  if (listed) return { externalId: listed.externalId, name: listed.name };
  if (target.input === "select" || target.input === "multi_select") return null;
  if (target.units.length > 0) {
    const unit = value.unit && target.units.includes(value.unit) ? value.unit : null;
    if (unit) return { externalId: null, name, unit };
    const m = NUMBER_WITH_UNIT.exec(name);
    if (m && target.units.includes(m[2]!.toLowerCase())) {
      return { externalId: null, name: m[1]!.replace(",", "."), unit: m[2]!.toLowerCase() };
    }
    return null;
  }
  return { externalId: null, name: value.unit ? `${name} ${value.unit}` : name };
}

/**
 * The source's attributes for the target category. Same marketplace: by id, as they are. Another
 * marketplace: by name, values matched by name; values the target cannot take are left out (a required
 * attribute left empty becomes a problem).
 */
export function mapAttributes(source: DraftAttribute[], rules: CategoryRules, sameChannel: boolean): DraftAttribute[] {
  const out: DraftAttribute[] = [];
  for (const target of rules.attributes) {
    let values: DraftAttribute["values"] = [];
    if (sameChannel) {
      const src = source.find((a) => a.attributeId === target.externalId);
      values = (src?.values ?? []).filter((v) => v.externalId || v.name);
    } else {
      const key = synonymKey(target.name, ATTRIBUTE_SYNONYMS);
      const src = source.find((a) => synonymKey(a.name ?? "", ATTRIBUTE_SYNONYMS) === key);
      for (const v of src?.values ?? []) {
        const mapped = valueFor(target, v);
        if (mapped && !values.some((x) => x.externalId === mapped.externalId && x.name === mapped.name)) {
          values.push(mapped);
        }
      }
    }
    if (target.maxValues !== null) values = values.slice(0, target.maxValues);
    if (values.length > 0) out.push({ attributeId: target.externalId, name: target.name, values });
  }
  return out;
}

const image = (sourceUrl: string): DraftImage => ({ sourceUrl, ref: null, url: null });

export interface DraftInput {
  source: SourceProduct;
  sourceChannel: string;
  targetChannel: string;
  category: { externalId: string; path: string | null } | null;
  rules: CategoryRules | null;
  /** OmniSeller variant of each source variant (by external variant id), from the source listings. */
  variantIds: Map<string, string | null>;
  priceChangePercent: number;
}

/** A draft's content from the source product. */
export function draftFromSource(input: DraftInput): DraftContent {
  const { source, rules } = input;
  const same = input.sourceChannel === input.targetChannel;
  const imagesMax = rules?.limits.imagesMax ?? 9;
  const attributes: DraftAttribute[] = source.attributes.map((a) => ({
    attributeId: a.attributeId,
    name: a.name,
    values: a.values,
  }));
  return {
    title: source.title.trim(),
    description: source.description,
    // TikTok Shop keeps its own HTML; Shopee takes plain text
    descriptionHtml: input.targetChannel === "tiktokshop" ? source.descriptionHtml : null,
    externalCategoryId: input.category?.externalId ?? null,
    categoryPath: input.category?.path ?? null,
    brand: same ? source.brand : source.brand?.name ? { externalId: null, name: source.brand.name } : null,
    attributes: rules ? mapAttributes(attributes, rules, same) : [],
    images: [...new Set(source.images)].slice(0, imagesMax).map(image),
    sizeChart:
      source.sizeChartImageUrl && (rules?.sizeChart.supported ?? true) ? image(source.sizeChartImageUrl) : null,
    weightG: source.weightG,
    dimensionsMm: source.dimensionsMm,
    condition: source.condition,
    preOrderDays: source.preOrderDays,
    itemSku: source.itemSku,
    variationNames: source.variationNames,
    variants: source.variants.map((v, i) => ({
      key: `v${i + 1}`,
      externalSourceVariantId: v.externalVariantId,
      variantId: input.variantIds.get(v.externalVariantId) ?? null,
      sku: v.sku,
      options: v.options,
      price: v.price === null ? 0 : adjustPrice(v.price, input.priceChangePercent),
      image: v.imageUrl ? image(v.imageUrl) : null,
      gtin: v.gtin,
    })),
  };
}

/** The source as kept on the draft, to prepare it again for another category. */
export function sourceSnapshot(source: SourceProduct, channel: string, notes: DraftProblem[] = []): DraftSource {
  return {
    channel,
    category: source.category,
    brand: source.brand,
    attributes: source.attributes.map((a) => ({ attributeId: a.attributeId, name: a.name, values: a.values })),
    extras: source.extras,
    notes,
  };
}

export interface ProblemContext {
  targetChannel: string;
  /** The draft's category in the target store's tree; null when none is chosen or it is gone. */
  category: { isLeaf: boolean; permitted: boolean } | null;
  rules: CategoryRules | null;
  /** The target store is in parallel mode: OmniSeller does not send stock there. */
  readOnly: boolean;
  /** Facts the worker found while preparing (already copied, brand not found). */
  notes: DraftProblem[];
}

const CHANNEL_NAME: Record<string, string> = { shopee: "Shopee", tiktokshop: "Tokopedia & Shop" };

function blocking(code: string, field: string, message: string): DraftProblem {
  return { code, field, message, blocking: true };
}

function warning(code: string, field: string, message: string): DraftProblem {
  return { code, field, message, blocking: false };
}

/** Whether a required-when condition of a TikTok Shop attribute holds for the draft's values. */
function requiredNow(attr: CategoryAttribute, chosen: Map<string, DraftAttribute>): boolean {
  if (attr.required) return true;
  return attr.requiredWhen.some((c) => chosen.get(c.attributeId)?.values.some((v) => v.externalId === c.valueId));
}

/** Everything the target would refuse (blocking) or the seller should know (not blocking). */
export function problemsOf(d: DraftContent, ctx: ProblemContext): DraftProblem[] {
  const out: DraftProblem[] = [];
  const channel = CHANNEL_NAME[ctx.targetChannel] ?? ctx.targetChannel;
  const r = ctx.rules;
  const lim = r?.limits;

  if (!d.externalCategoryId) out.push(blocking("category_missing", "category", "Pilih kategori di toko tujuan."));
  else if (!ctx.category) {
    out.push(blocking("category_unknown", "category", `Kategori ini tidak ada di ${channel}. Pilih kategori lain.`));
  } else if (!ctx.category.isLeaf) {
    out.push(blocking("category_not_leaf", "category", "Pilih kategori paling akhir (tanpa subkategori)."));
  } else if (!ctx.category.permitted) {
    out.push(
      blocking(
        "category_not_permitted",
        "category",
        `Toko tujuan belum diizinkan berjualan di kategori ini di ${channel}.`,
      ),
    );
  } else if (!r) {
    out.push(blocking("rules_missing", "category", "Aturan kategori belum terbaca. Pilih ulang kategorinya."));
  }

  const title = d.title.trim();
  if (lim && (title.length < lim.titleMin || title.length > lim.titleMax)) {
    out.push(
      blocking(
        "title_length",
        "title",
        `Nama produk harus ${lim.titleMin}–${lim.titleMax} karakter di ${channel} (sekarang ${title.length}).`,
      ),
    );
  } else if (!title) out.push(blocking("title_length", "title", "Nama produk wajib diisi."));

  const description = d.descriptionHtml ?? d.description;
  if (lim && (description.trim().length < lim.descriptionMin || description.length > lim.descriptionMax)) {
    out.push(
      blocking(
        "description_length",
        "description",
        `Deskripsi harus ${lim.descriptionMin}–${lim.descriptionMax} karakter di ${channel} (sekarang ${description.trim().length}).`,
      ),
    );
  }

  if (d.images.length === 0) out.push(blocking("images_missing", "images", "Produk perlu minimal satu foto."));
  else if (lim && d.images.length > lim.imagesMax) {
    out.push(blocking("images_count", "images", `Maksimal ${lim.imagesMax} foto di ${channel}.`));
  }

  if (!d.weightG || d.weightG <= 0) out.push(blocking("weight_missing", "weightG", "Isi berat paket (gram)."));
  if (r?.dimensionsRequired && !d.dimensionsMm) {
    out.push(
      blocking("dimensions_missing", "dimensionsMm", "Kategori ini mewajibkan ukuran paket (panjang, lebar, tinggi)."),
    );
  }
  if (r?.brandRequired && !d.brand?.name?.trim() && !d.brand?.externalId) {
    out.push(blocking("brand_required", "brand", "Kategori ini mewajibkan merek."));
  }
  if (r?.sizeChart.required && !d.sizeChart) {
    out.push(blocking("size_chart_required", "sizeChart", "Kategori ini mewajibkan tabel ukuran."));
  }
  if (r && r.certifications.length > 0) {
    out.push(
      blocking(
        "certification_required",
        "category",
        `Kategori ini mewajibkan sertifikat (${r.certifications.join(", ")}). Pilih kategori lain atau unggah produk ini lewat Seller Center.`,
      ),
    );
  }

  if (r) {
    const chosen = new Map(d.attributes.map((a) => [a.attributeId, a]));
    for (const attr of r.attributes) {
      const values = chosen.get(attr.externalId)?.values ?? [];
      const field = `attributes.${attr.externalId}`;
      if (values.length === 0) {
        if (requiredNow(attr, chosen))
          out.push(blocking("attribute_required", field, `Isi atribut wajib "${attr.name}".`));
        continue;
      }
      if (attr.maxValues !== null && values.length > attr.maxValues) {
        out.push(blocking("attribute_values_count", field, `"${attr.name}" hanya boleh ${attr.maxValues} nilai.`));
      }
      for (const v of values) {
        const listed = v.externalId && attr.values.some((x) => x.externalId === v.externalId);
        if (v.externalId && !listed) {
          out.push(
            blocking(
              "attribute_value",
              field,
              `Nilai "${v.name ?? v.externalId}" tidak tersedia untuk "${attr.name}".`,
            ),
          );
        } else if (!v.externalId && (attr.input === "select" || attr.input === "multi_select")) {
          out.push(blocking("attribute_value", field, `Pilih nilai "${attr.name}" dari daftar ${channel}.`));
        } else if (!v.externalId && attr.valueFormat && attr.valueFormat !== "date") {
          const ok =
            attr.valueFormat === "integer" ? /^\d+$/.test(v.name ?? "") : /^\d+(?:[.,]\d+)?$/.test(v.name ?? "");
          if (!ok) out.push(blocking("attribute_value", field, `"${attr.name}" harus berupa angka.`));
        }
        if (!v.externalId && attr.units.length > 0 && !(v.unit && attr.units.includes(v.unit))) {
          out.push(blocking("attribute_unit", field, `Pilih satuan "${attr.name}" (${attr.units.join(", ")}).`));
        }
      }
    }
  }

  // variations and variants
  if (lim && d.variationNames.length > lim.variationsMax) {
    out.push(
      blocking("variations_count", "variationNames", `${channel} hanya mendukung ${lim.variationsMax} jenis variasi.`),
    );
  }
  if (lim && d.variants.length > lim.variantsMax) {
    out.push(
      blocking("variants_count", "variants", `${channel} hanya mendukung ${lim.variantsMax} varian per produk.`),
    );
  }
  if (d.variants.length === 0) out.push(blocking("variants_missing", "variants", "Produk perlu minimal satu varian."));
  if (d.variationNames.length === 0 && d.variants.length > 1) {
    out.push(
      blocking("variations_missing", "variationNames", "Beri nama variasi untuk produk dengan beberapa varian."),
    );
  }
  d.variationNames.forEach((name, i) => {
    if (!name.trim()) out.push(blocking("variation_name", `variationNames.${i}`, "Nama variasi wajib diisi."));
    else if (lim && name.length > lim.variationNameMax) {
      out.push(
        blocking(
          "variation_name",
          `variationNames.${i}`,
          `Nama variasi "${name}" maksimal ${lim.variationNameMax} karakter.`,
        ),
      );
    }
  });
  const combos = new Set<string>();
  const skus = new Map<string, number>();
  for (const v of d.variants) {
    const base = `variants.${v.key}`;
    if (v.options.length !== d.variationNames.length || v.options.some((o) => !o.trim())) {
      out.push(blocking("option_missing", `${base}.options`, "Isi nilai setiap variasi."));
    }
    v.options.forEach((o, i) => {
      if (lim && o.length > lim.optionNameMax) {
        out.push(
          blocking(
            "option_length",
            `${base}.options.${i}`,
            `Nilai variasi "${o}" maksimal ${lim.optionNameMax} karakter.`,
          ),
        );
      }
    });
    const combo = v.options.map((o) => normalizeName(o)).join("|");
    if (combos.has(combo))
      out.push(blocking("variant_duplicate", `${base}.options`, "Kombinasi variasi ini dipakai dua kali."));
    combos.add(combo);
    if (!(v.price > 0)) out.push(blocking("price_invalid", `${base}.price`, "Harga harus lebih dari 0."));
    else if (lim?.priceMin !== null && lim?.priceMin !== undefined && v.price < lim.priceMin) {
      out.push(blocking("price_range", `${base}.price`, `Harga minimal Rp${lim.priceMin} di ${channel}.`));
    } else if (lim?.priceMax !== null && lim?.priceMax !== undefined && v.price > lim.priceMax) {
      out.push(blocking("price_range", `${base}.price`, `Harga maksimal Rp${lim.priceMax} di ${channel}.`));
    }
    if (v.sku) {
      if (lim?.skuNoSpaces && /\s/.test(v.sku)) {
        out.push(blocking("sku_invalid", `${base}.sku`, `SKU di ${channel} tidak boleh berisi spasi.`));
      }
      if (lim && v.sku.length > lim.skuMax) {
        out.push(blocking("sku_invalid", `${base}.sku`, `SKU maksimal ${lim.skuMax} karakter di ${channel}.`));
      }
      const norm = v.sku.trim().toLowerCase();
      skus.set(norm, (skus.get(norm) ?? 0) + 1);
    }
  }
  for (const [sku, n] of skus) {
    if (n > 1) out.push(blocking("sku_duplicate", "variants", `SKU "${sku}" dipakai lebih dari satu varian.`));
  }

  // for review only
  const unmapped = d.variants.filter((v) => !v.variantId).length;
  if (unmapped > 0) {
    out.push(
      warning(
        "variant_unmapped",
        "variants",
        `${unmapped} varian belum terhubung ke produk OmniSeller: stoknya dibuat 0 dan tidak disinkronkan.`,
      ),
    );
  }
  if (ctx.targetChannel === "tiktokshop" && d.preOrderDays) {
    out.push(
      warning(
        "pre_order_dropped",
        "preOrderDays",
        "Pre-order tidak disalin ke Tokopedia & Shop; produk dibuat sebagai stok siap kirim.",
      ),
    );
  }
  if (ctx.readOnly) {
    out.push(
      warning(
        "store_read_only",
        "store",
        "Toko tujuan masih mode paralel: produk dibuat dengan stok 0 dan stok tidak dikirim OmniSeller.",
      ),
    );
  }
  out.push(...ctx.notes);
  return out;
}

export const hasBlocking = (problems: DraftProblem[]) => problems.some((p) => p.blocking);

/** Stock to create each variant with, at the target's warehouse. */
export interface InitialStock {
  /** The marketplace warehouse the stock goes to (TikTok Shop warehouse, Shopee location). */
  externalWarehouseId: string | null;
  /** By variant key; missing: 0. */
  quantities: Map<string, number>;
}

/**
 * The product to create from a draft whose images are uploaded. Option images go with the first
 * variation's values (the marketplaces show one image per value).
 */
export function toProductToCreate(
  d: DraftContent & { id: string; publishAttempt: number; source: DraftSource },
  targetChannel: string,
  stock: InitialStock,
): ProductToCreate {
  const refs = d.images.map((i) => i.ref).filter((r): r is string => !!r);
  const attributes: ProductAttributeValue[] = d.attributes.map((a) => ({
    attributeId: a.attributeId,
    name: a.name,
    values: a.values,
  }));
  return {
    idempotencyKey: `${d.id}-${d.publishAttempt}`,
    title: d.title.trim(),
    description: d.description,
    descriptionHtml: d.descriptionHtml,
    categoryId: d.externalCategoryId ?? "",
    brand: d.brand,
    attributes,
    images: refs,
    weightG: d.weightG ?? 0,
    dimensionsMm: d.dimensionsMm,
    condition: d.condition,
    preOrderDays: targetChannel === "shopee" ? d.preOrderDays : null,
    itemSku: d.itemSku,
    sizeChartImage: d.sizeChart?.ref ?? null,
    variationNames: d.variationNames,
    variants: d.variants.map((v) => ({
      key: v.key,
      sku: v.sku,
      options: v.options,
      price: v.price,
      stock: stock.quantities.get(v.key) ?? 0,
      image: v.image?.ref ?? null,
      gtin: v.gtin,
    })),
    warehouseId: stock.externalWarehouseId,
    // marketplace settings only make sense on the same marketplace
    extras: d.source.channel === targetChannel ? d.source.extras : {},
  };
}
