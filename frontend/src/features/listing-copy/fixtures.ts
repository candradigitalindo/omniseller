import type { CategoryDetail, Copy, Draft, DraftItem } from "./copy-meta";

export const SHOPEE_STORE = "01JSTORE000000000000000001";
export const TIKTOK_STORE = "01JSTORE000000000000000002";
export const COPY_ID = "01JCOPY0000000000000000001";
export const DRAFT_ID = "01JDRAFT000000000000000001";

export const stores = {
  items: [
    { id: SHOPEE_STORE, name: "Toko Rina Shopee", channel: "shopee", status: "active", syncMode: "live" },
    { id: TIKTOK_STORE, name: "Toko Rina TTS", channel: "tiktokshop", status: "active", syncMode: "read_only" },
    { id: "01JSTORE000000000000000003", name: "WhatsApp", channel: "manual", status: "active", syncMode: "live" },
  ],
};

export function copyFixture(over: Partial<Copy> = {}): Copy {
  return {
    id: COPY_ID,
    sourceStore: { id: SHOPEE_STORE, name: "Toko Rina Shopee", channel: "shopee", channelName: "Shopee" },
    targetStore: { id: TIKTOK_STORE, name: "Toko Rina TTS", channel: "tiktokshop", channelName: "Tokopedia & Shop" },
    scope: "store",
    status: "ready",
    priceChangePercent: 10,
    skipListed: true,
    itemsTotal: 12,
    itemsDrafted: 10,
    itemsSkipped: 1,
    itemsFailed: 1,
    failures: [{ externalItemId: "5103", title: "Topi Rajut", reason: "Produk tidak ditemukan di Shopee." }],
    drafts: { draft: 8, published: 2 },
    error: null,
    createdAt: "2026-10-06T01:00:00.000Z",
    finishedAt: "2026-10-06T01:00:21.000Z",
    ...over,
  };
}

export function draftItem(over: Partial<DraftItem> = {}): DraftItem {
  return {
    id: DRAFT_ID,
    copyId: COPY_ID,
    sourceStoreId: SHOPEE_STORE,
    targetStoreId: TIKTOK_STORE,
    externalSourceItemId: "5101",
    status: "draft",
    title: "Kaos Polos Katun Combed 30s Unisex",
    categoryPath: "Pakaian Pria > Kaos",
    imageUrl: null,
    variantCount: 3,
    priceMin: 60_500,
    priceMax: 62_700,
    blockingProblems: 1,
    warnings: 1,
    externalTargetItemId: null,
    error: null,
    rowVersion: 3,
    updatedAt: "2026-10-06T01:00:00.000Z",
    ...over,
  };
}

export function draftFixture(over: Partial<Draft> = {}): Draft {
  return {
    ...draftItem(),
    description: "Kaos polos bahan katun combed 30s.",
    descriptionHtml: null,
    externalCategoryId: "601226",
    brand: { brandId: null, name: "Rajutku" },
    attributes: [{ attributeId: "100134", name: "Bahan", values: [{ valueId: "1234", name: "Katun", unit: null }] }],
    images: [
      { sourceUrl: "https://cf.shopee.co.id/file/kaos-1", uploaded: false, url: null },
      { sourceUrl: "https://cf.shopee.co.id/file/kaos-2", uploaded: false, url: null },
    ],
    sizeChart: null,
    weightG: 250,
    dimensionsMm: { length: 300, width: 200, height: 30 },
    condition: "new",
    preOrderDays: null,
    itemSku: "KAOS",
    variationNames: ["Warna", "Ukuran"],
    variants: [
      {
        key: "9101",
        externalSourceVariantId: "9101",
        variantId: "01JVARIANT0000000000000001",
        sku: "KAOS-HTM-M",
        options: ["Hitam", "M"],
        price: 60_500,
        image: null,
        gtin: null,
      },
      {
        key: "9102",
        externalSourceVariantId: "9102",
        variantId: null,
        sku: "KAOS HTM L",
        options: ["Hitam", "L"],
        price: 62_700,
        image: null,
        gtin: null,
      },
    ],
    problems: [
      {
        code: "attribute.required",
        field: "attributes.102254",
        message: "Isi atribut wajib Barang Impor.",
        blocking: true,
      },
      {
        code: "variant.unmapped",
        field: "variants.9102",
        message: "Varian Hitam L belum terhubung ke produk OmniSeller.",
        blocking: false,
      },
    ],
    source: { channel: "shopee", categoryId: "100017", categoryPath: "Pakaian Pria > Atasan > Kaos", brand: "Rajutku" },
    publishAttempt: 0,
    publishedAt: null,
    createdAt: "2026-10-06T01:00:00.000Z",
    ...over,
  };
}

export function categoryFixture(over: Partial<CategoryDetail> = {}): CategoryDetail {
  return {
    categoryId: "601226",
    parentId: "601152",
    name: "Kaos",
    path: "Pakaian Pria > Kaos",
    isLeaf: true,
    permitted: true,
    rules: {
      attributes: [
        {
          attributeId: "102254",
          name: "Barang Impor",
          required: true,
          input: "select",
          values: [
            { valueId: "1000059", name: "Ya" },
            { valueId: "1000060", name: "Tidak" },
          ],
          units: [],
          valueFormat: null,
          maxValues: null,
          requiredWhen: [],
        },
        {
          attributeId: "100134",
          name: "Bahan",
          required: false,
          input: "select_or_text",
          values: [
            { valueId: "1234", name: "Katun" },
            { valueId: "1235", name: "Polyester" },
          ],
          units: [],
          valueFormat: null,
          maxValues: null,
          requiredWhen: [],
        },
        {
          attributeId: "100200",
          name: "Berat Kain",
          required: false,
          input: "text",
          values: [],
          units: ["g", "kg"],
          valueFormat: "integer",
          maxValues: null,
          requiredWhen: [{ attributeId: "102254", valueId: "1000059" }],
        },
      ],
      brandRequired: false,
      weightRequired: true,
      dimensionsRequired: false,
      sizeChart: { supported: false, required: false },
      certifications: [],
      daysToShip: null,
      limits: {
        titleMin: 25,
        titleMax: 255,
        descriptionMin: 60,
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
      },
    },
    rulesPending: false,
    rulesReadAt: "2026-10-06T01:00:00.000Z",
    ...over,
  };
}
