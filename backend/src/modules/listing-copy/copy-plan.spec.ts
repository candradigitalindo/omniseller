import type { CategoryAttribute, CategoryRules, SourceProduct } from "@omniseller/connector-core";
import { describe, expect, it } from "vitest";
import {
  adjustPrice,
  type DraftContent,
  draftFromSource,
  hasBlocking,
  mapAttributes,
  normalizeName,
  type ProblemContext,
  problemsOf,
  sourceSnapshot,
  toProductToCreate,
} from "./copy-plan";

const attr = (over: Partial<CategoryAttribute> & { externalId: string; name: string }): CategoryAttribute => ({
  required: false,
  input: "select",
  values: [],
  units: [],
  valueFormat: null,
  maxValues: 1,
  requiredWhen: [],
  ...over,
});

const LIMITS = {
  titleMin: 25,
  titleMax: 255,
  descriptionMin: 1,
  descriptionMax: 10_000,
  imagesMin: 1,
  imagesMax: 9,
  priceMin: null,
  priceMax: null,
  variantsMax: 100,
  variationsMax: 3,
  variationNameMax: 20,
  optionNameMax: 50,
  skuMax: 50,
  skuNoSpaces: true,
};

/** TikTok Shop's rules for "Kaos" (Indonesia): Barang Impor required since 27 October 2026. */
const tiktokRules: CategoryRules = {
  categoryId: "601226",
  attributes: [
    attr({
      externalId: "102254",
      name: "Barang Impor",
      required: true,
      values: [
        { externalId: "1000058", name: "Ya" },
        { externalId: "1000059", name: "Tidak" },
      ],
    }),
    attr({
      externalId: "100392",
      name: "Bahan",
      input: "multi_select_or_text",
      maxValues: null,
      values: [{ externalId: "1000040", name: "Katun" }],
    }),
    attr({
      externalId: "100393",
      name: "Negara Asal",
      values: [
        { externalId: "1000100", name: "Indonesia" },
        { externalId: "1000101", name: "Tiongkok" },
      ],
    }),
    attr({
      externalId: "100500",
      name: "Garansi Pabrik",
      requiredWhen: [{ attributeId: "102254", valueId: "1000058" }],
      input: "text",
    }),
  ],
  brandRequired: false,
  weightRequired: true,
  dimensionsRequired: false,
  sizeChart: { supported: true, required: false },
  certifications: [],
  daysToShip: null,
  limits: LIMITS,
};

const shopeeRules: CategoryRules = {
  categoryId: "100017",
  attributes: [
    attr({
      externalId: "100134",
      name: "Bahan",
      required: true,
      input: "select_or_text",
      values: [{ externalId: "1234", name: "Katun" }],
    }),
    attr({
      externalId: "100037",
      name: "Negara Asal",
      required: true,
      values: [{ externalId: "1402", name: "China" }],
    }),
    attr({ externalId: "100010", name: "Berat Bersih", input: "text", units: ["g", "kg"], valueFormat: "decimal" }),
  ],
  brandRequired: false,
  weightRequired: true,
  dimensionsRequired: true,
  sizeChart: { supported: true, required: false },
  certifications: [],
  daysToShip: 2,
  limits: {
    ...LIMITS,
    titleMin: 10,
    descriptionMin: 10,
    descriptionMax: 3000,
    priceMin: 99,
    priceMax: 150_000_000,
    variantsMax: 50,
    variationsMax: 2,
    variationNameMax: 14,
    optionNameMax: 20,
    skuMax: 100,
    skuNoSpaces: false,
  },
};

const tiktokSource: SourceProduct = {
  externalItemId: "1729592969712207013",
  title: "Kaos Polos Katun Combed 30s Unisex",
  description: "Bahan adem.\nUkuran pas.",
  descriptionHtml: "<p>Bahan adem.</p><p>Ukuran pas.</p>",
  category: { externalId: "601226", name: "Kaos", path: "Pakaian Pria > Kaos" },
  brand: { externalId: "7082427311584347905", name: "Rajutku" },
  attributes: [
    { attributeId: "100392", name: "Bahan", values: [{ externalId: "1000040", name: "Katun" }] },
    { attributeId: "100393", name: "Negara Asal", values: [{ externalId: "1000101", name: "Tiongkok" }] },
    { attributeId: "100600", name: "Berat Bersih", values: [{ externalId: null, name: "180 g" }] },
  ],
  images: ["https://p16.tiktokcdn.com/a.jpg", "https://p16.tiktokcdn.com/b.jpg", "https://p16.tiktokcdn.com/a.jpg"],
  weightG: 250,
  dimensionsMm: { length: 300, width: 200, height: 30 },
  condition: "new",
  preOrderDays: null,
  sizeChartImageUrl: null,
  itemSku: null,
  variationNames: ["Warna", "Ukuran"],
  variants: [
    {
      externalVariantId: "11",
      sku: "KAOS-HTM-M",
      options: ["Hitam", "M"],
      price: 55_000,
      stock: 3,
      imageUrl: "https://p16.tiktokcdn.com/h.jpg",
      gtin: null,
    },
    {
      externalVariantId: "12",
      sku: "KAOS-HTM-L",
      options: ["Hitam", "L"],
      price: 57_000,
      stock: 0,
      imageUrl: null,
      gtin: null,
    },
  ],
  extras: {},
};

const ctx = (over: Partial<ProblemContext> = {}): ProblemContext => ({
  targetChannel: "tiktokshop",
  category: { isLeaf: true, permitted: true },
  rules: tiktokRules,
  readOnly: false,
  notes: [],
  ...over,
});

function content(over: Partial<DraftContent> = {}): DraftContent {
  return {
    title: "Kaos Polos Katun Combed 30s Unisex",
    description: "Bahan adem.",
    descriptionHtml: null,
    externalCategoryId: "601226",
    categoryPath: "Pakaian Pria > Kaos",
    brand: null,
    attributes: [{ attributeId: "102254", name: "Barang Impor", values: [{ externalId: "1000059", name: "Tidak" }] }],
    images: [{ sourceUrl: "https://x/a.jpg", ref: null, url: null }],
    sizeChart: null,
    weightG: 250,
    dimensionsMm: null,
    condition: "new",
    preOrderDays: null,
    itemSku: null,
    variationNames: ["Warna"],
    variants: [
      {
        key: "v1",
        externalSourceVariantId: "1",
        variantId: "01JVARIANT00000000000000A1",
        sku: "KAOS-HTM",
        options: ["Hitam"],
        price: 55_000,
        image: null,
        gtin: null,
      },
    ],
    ...over,
  };
}

describe("copy plan: names and prices", () => {
  it("normalizes names for matching", () => {
    expect(normalizeName("  Négara-Asal ")).toBe("negara asal");
    expect(normalizeName(null)).toBe("");
  });

  it("changes prices by a percentage, rounded to hundreds from Rp 1,000", () => {
    expect(adjustPrice(55_000, 0)).toBe(55_000);
    expect(adjustPrice(55_000, 10)).toBe(60_500);
    expect(adjustPrice(57_330, 7)).toBe(61_300);
    expect(adjustPrice(999, -50)).toBe(500);
    expect(adjustPrice(1, -90)).toBe(1);
  });
});

describe("copy plan: attributes", () => {
  it("keeps attributes by id on the same marketplace, only those of the target category", () => {
    const mapped = mapAttributes(
      [
        { attributeId: "102254", name: "Barang Impor", values: [{ externalId: "1000059", name: "Tidak" }] },
        { attributeId: "999", name: "Lain", values: [{ externalId: "1", name: "x" }] },
      ],
      tiktokRules,
      true,
    );
    expect(mapped).toEqual([
      { attributeId: "102254", name: "Barang Impor", values: [{ externalId: "1000059", name: "Tidak" }] },
    ]);
  });

  it("maps by name across marketplaces: listed values by name and synonym, text where the target takes it, units", () => {
    const mapped = mapAttributes(
      [
        { attributeId: "100392", name: "Material", values: [{ externalId: "1000040", name: "Katun" }] },
        { attributeId: "100393", name: "Asal Produk", values: [{ externalId: "1000101", name: "Tiongkok" }] },
        { attributeId: "100600", name: "Net Weight", values: [{ externalId: null, name: "180 g" }] },
      ],
      shopeeRules,
      false,
    );
    expect(mapped).toEqual([
      { attributeId: "100134", name: "Bahan", values: [{ externalId: "1234", name: "Katun" }] },
      { attributeId: "100037", name: "Negara Asal", values: [{ externalId: "1402", name: "China" }] },
      { attributeId: "100010", name: "Berat Bersih", values: [{ externalId: null, name: "180", unit: "g" }] },
    ]);
  });

  it("types a value the list lacks only where the target takes text, and respects the value limit", () => {
    const mapped = mapAttributes(
      [
        {
          attributeId: "1",
          name: "Bahan",
          values: [
            { externalId: "9", name: "Linen" },
            { externalId: "8", name: "Katun" },
          ],
        },
        { attributeId: "2", name: "Negara Asal", values: [{ externalId: "7", name: "Vietnam" }] },
      ],
      shopeeRules,
      false,
    );
    expect(mapped).toEqual([{ attributeId: "100134", name: "Bahan", values: [{ externalId: null, name: "Linen" }] }]);
  });
});

describe("copy plan: a draft from the source", () => {
  it("copies TikTok Shop to Shopee: text description, brand by name, unique images, keys, price change, mapping", () => {
    const d = draftFromSource({
      source: tiktokSource,
      sourceChannel: "tiktokshop",
      targetChannel: "shopee",
      category: { externalId: "100017", path: "Pakaian Pria > Kaos" },
      rules: shopeeRules,
      variantIds: new Map([["11", "01JVARIANT00000000000000A1"]]),
      priceChangePercent: 10,
    });
    expect(d).toMatchObject({
      title: "Kaos Polos Katun Combed 30s Unisex",
      description: "Bahan adem.\nUkuran pas.",
      descriptionHtml: null,
      externalCategoryId: "100017",
      brand: { externalId: null, name: "Rajutku" },
      images: [
        { sourceUrl: "https://p16.tiktokcdn.com/a.jpg", ref: null, url: null },
        { sourceUrl: "https://p16.tiktokcdn.com/b.jpg", ref: null, url: null },
      ],
      variationNames: ["Warna", "Ukuran"],
    });
    expect(d.variants).toEqual([
      {
        key: "v1",
        externalSourceVariantId: "11",
        variantId: "01JVARIANT00000000000000A1",
        sku: "KAOS-HTM-M",
        options: ["Hitam", "M"],
        price: 60_500,
        image: { sourceUrl: "https://p16.tiktokcdn.com/h.jpg", ref: null, url: null },
        gtin: null,
      },
      {
        key: "v2",
        externalSourceVariantId: "12",
        variantId: null,
        sku: "KAOS-HTM-L",
        options: ["Hitam", "L"],
        price: 62_700,
        image: null,
        gtin: null,
      },
    ]);
    expect(d.attributes.map((a) => a.attributeId)).toEqual(["100134", "100037", "100010"]);
    expect(sourceSnapshot(tiktokSource, "tiktokshop").category).toEqual(tiktokSource.category);
  });

  it("keeps the HTML description and the brand id within TikTok Shop", () => {
    const d = draftFromSource({
      source: tiktokSource,
      sourceChannel: "tiktokshop",
      targetChannel: "tiktokshop",
      category: { externalId: "601226", path: null },
      rules: tiktokRules,
      variantIds: new Map(),
      priceChangePercent: 0,
    });
    expect(d.descriptionHtml).toBe("<p>Bahan adem.</p><p>Ukuran pas.</p>");
    expect(d.brand).toEqual({ externalId: "7082427311584347905", name: "Rajutku" });
    expect(d.variants.map((v) => v.price)).toEqual([55_000, 57_000]);
  });
});

describe("copy plan: problems", () => {
  it("a complete draft has no blocking problem", () => {
    expect(problemsOf(content(), ctx())).toEqual([]);
  });

  it("asks for a usable category and its rules", () => {
    expect(problemsOf(content({ externalCategoryId: null }), ctx({ category: null }))[0]?.code).toBe(
      "category_missing",
    );
    expect(problemsOf(content(), ctx({ category: null }))[0]?.code).toBe("category_unknown");
    expect(problemsOf(content(), ctx({ category: { isLeaf: false, permitted: true } }))[0]?.code).toBe(
      "category_not_leaf",
    );
    expect(problemsOf(content(), ctx({ category: { isLeaf: true, permitted: false } }))[0]?.code).toBe(
      "category_not_permitted",
    );
    expect(problemsOf(content(), ctx({ rules: null }))[0]?.code).toBe("rules_missing");
  });

  it("checks the target's limits: title, images, weight, dimensions, brand, size chart, certifications", () => {
    const codes = problemsOf(
      content({ title: "Kaos", images: [], weightG: null }),
      ctx({
        rules: {
          ...tiktokRules,
          dimensionsRequired: true,
          brandRequired: true,
          sizeChart: { supported: true, required: true },
          certifications: ["SNI"],
        },
      }),
    ).map((p) => p.code);
    expect(codes).toEqual([
      "title_length",
      "images_missing",
      "weight_missing",
      "dimensions_missing",
      "brand_required",
      "size_chart_required",
      "certification_required",
    ]);
  });

  it("checks required attributes, also when another value makes one required, and listed values", () => {
    const missing = problemsOf(content({ attributes: [] }), ctx());
    expect(missing).toEqual([
      {
        code: "attribute_required",
        field: "attributes.102254",
        message: 'Isi atribut wajib "Barang Impor".',
        blocking: true,
      },
    ]);
    const imported = problemsOf(
      content({
        attributes: [{ attributeId: "102254", name: "Barang Impor", values: [{ externalId: "1000058", name: "Ya" }] }],
      }),
      ctx(),
    );
    expect(imported.map((p) => p.field)).toEqual(["attributes.100500"]);
    const wrong = problemsOf(
      content({
        attributes: [
          { attributeId: "102254", name: "Barang Impor", values: [{ externalId: "5", name: "Mungkin" }] },
          { attributeId: "100393", name: "Negara Asal", values: [{ externalId: null, name: "Vietnam" }] },
        ],
      }),
      ctx(),
    );
    expect(wrong.map((p) => p.code)).toEqual(["attribute_value", "attribute_value"]);
  });

  it("checks typed numbers and units", () => {
    const shopee = ctx({ targetChannel: "shopee", rules: shopeeRules });
    const base = content({
      title: "Kaos Polos Katun",
      description: "Bahan adem dan nyaman.",
      dimensionsMm: { length: 300, width: 200, height: 30 },
      attributes: [
        { attributeId: "100134", name: "Bahan", values: [{ externalId: "1234", name: "Katun" }] },
        { attributeId: "100037", name: "Negara Asal", values: [{ externalId: "1402", name: "China" }] },
        { attributeId: "100010", name: "Berat Bersih", values: [{ externalId: null, name: "seratus", unit: "ons" }] },
      ],
    });
    expect(problemsOf(base, shopee).map((p) => p.code)).toEqual(["attribute_value", "attribute_unit"]);
  });

  it("checks variations, options, prices, and SKUs against the target", () => {
    const shopee = ctx({ targetChannel: "shopee", rules: shopeeRules });
    const problems = problemsOf(
      content({
        title: "Kaos Polos Katun",
        description: "Bahan adem dan nyaman.",
        dimensionsMm: { length: 300, width: 200, height: 30 },
        attributes: [
          { attributeId: "100134", name: "Bahan", values: [{ externalId: "1234", name: "Katun" }] },
          { attributeId: "100037", name: "Negara Asal", values: [{ externalId: "1402", name: "China" }] },
        ],
        variationNames: ["Warna", "Ukuran", "Panjang Lengan Baju"],
        variants: [
          {
            key: "v1",
            externalSourceVariantId: "1",
            variantId: null,
            sku: "KAOS 1",
            options: ["Hitam", "M", "Pendek"],
            price: 50,
            image: null,
            gtin: null,
          },
          {
            key: "v2",
            externalSourceVariantId: "2",
            variantId: null,
            sku: "kaos 1",
            options: ["Hitam", "M", "Pendek"],
            price: 0,
            image: null,
            gtin: null,
          },
        ],
      }),
      shopee,
    );
    expect(problems.filter((p) => p.blocking).map((p) => [p.code, p.field])).toEqual([
      ["variations_count", "variationNames"],
      ["variation_name", "variationNames.2"],
      ["price_range", "variants.v1.price"],
      ["variant_duplicate", "variants.v2.options"],
      ["price_invalid", "variants.v2.price"],
      ["sku_duplicate", "variants"],
    ]);
    expect(problems.filter((p) => !p.blocking).map((p) => p.code)).toEqual(["variant_unmapped"]);
    // TikTok Shop SKUs take no spaces
    const tiktok = problemsOf(content({ variants: [{ ...content().variants[0]!, sku: "KAOS 1" }] }), ctx());
    expect(tiktok.map((p) => p.code)).toEqual(["sku_invalid"]);
  });

  it("adds what the seller should know without blocking", () => {
    const note = { code: "already_published", field: "draft", message: "Sudah pernah disalin.", blocking: false };
    const problems = problemsOf(content({ preOrderDays: 7 }), ctx({ readOnly: true, notes: [note] }));
    expect(problems.map((p) => p.code)).toEqual(["pre_order_dropped", "store_read_only", "already_published"]);
    expect(hasBlocking(problems)).toBe(false);
  });
});

describe("copy plan: the product to create", () => {
  it("uses uploaded refs, the stock per variant, and same-marketplace settings only", () => {
    const d = {
      ...content({
        images: [
          { sourceUrl: "https://x/a.jpg", ref: "img-a", url: null },
          { sourceUrl: "https://x/b.jpg", ref: "img-b", url: null },
        ],
        preOrderDays: 7,
        variants: [
          { ...content().variants[0]!, image: { sourceUrl: "https://x/h.jpg", ref: "img-h", url: null } },
          { ...content().variants[0]!, key: "v2", sku: "KAOS-PTH", options: ["Putih"], image: null },
        ],
      }),
      id: "01JDRAFT000000000000000000",
      publishAttempt: 2,
      source: { ...sourceSnapshot(tiktokSource, "shopee"), extras: { logistics: [{ logistic_id: 8005 }] } },
    };
    const shopee = toProductToCreate(d, "shopee", { externalWarehouseId: "default", quantities: new Map([["v1", 7]]) });
    expect(shopee).toMatchObject({
      idempotencyKey: "01JDRAFT000000000000000000-2",
      images: ["img-a", "img-b"],
      preOrderDays: 7,
      warehouseId: "default",
      extras: { logistics: [{ logistic_id: 8005 }] },
    });
    expect(shopee.variants.map((v) => [v.key, v.stock, v.image])).toEqual([
      ["v1", 7, "img-h"],
      ["v2", 0, null],
    ]);
    const tiktok = toProductToCreate(d, "tiktokshop", { externalWarehouseId: "7300", quantities: new Map() });
    expect(tiktok.preOrderDays).toBeNull();
    // Shopee's logistics mean nothing on TikTok Shop
    expect(tiktok.extras).toEqual({});
  });
});
