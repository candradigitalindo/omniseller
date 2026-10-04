import type { CategoryRules } from "@omniseller/connector-core";
import { LISTING_COPY_STATUSES, LISTING_DRAFT_STATUSES, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { pageSchema, paginationQuery } from "../../common/http/pagination";
import type { CategoryRow, DraftRow } from "./listing-copy.repository";
import type { CopyView } from "./listing-copy.service";

/** Request and response DTOs of copying listings between stores (FR-PRD-13, backend doc 8.25). */

const iso = z.iso.datetime();
const categoryId = z
  .string()
  .trim()
  .regex(/^[0-9A-Za-z_-]{1,64}$/, "Id kategori marketplace.")
  .describe("id kategori di marketplace toko itu");
const draftIds = z.array(ulidSchema).min(1).max(500);
const rupiah = z.number().int().min(1).max(1_000_000_000_000);

// ---- stores' categories ----

export class StoreIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
export class StoreCategoryParamDto extends createZodDto(z.object({ id: ulidSchema, categoryId })) {}

export class CategoryQueryDto extends createZodDto(
  z.object({
    parentId: categoryId.optional().describe("anak kategori ini; tanpa parentId dan q: kategori teratas"),
    q: z.string().trim().min(1).max(100).optional().describe("cari di jalur lengkap kategori"),
    leafOnly: z.enum(["true", "false"]).optional().describe("hanya kategori paling akhir (tempat produk dibuat)"),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
) {}

const categorySchema = z.object({
  categoryId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  path: z.string().describe('"Pakaian Pria > Kaos"'),
  isLeaf: z.boolean(),
  permitted: z.boolean().describe("toko boleh berjualan di kategori ini (Tokopedia & Shop)"),
});

export const categoryView = (c: CategoryRow): z.infer<typeof categorySchema> => ({
  categoryId: c.externalId,
  parentId: c.externalParentId,
  name: c.name,
  path: c.path,
  isLeaf: c.isLeaf,
  permitted: c.permitted,
});

export class CategoryPageDto extends createZodDto(
  z.object({
    items: z.array(categorySchema),
    total: z.number().int().describe("kategori tersimpan untuk toko ini"),
    refreshedAt: iso.nullable().describe("kapan daftar kategori terakhir dibaca dari marketplace"),
  }),
) {}

const attributeRuleSchema = z.object({
  attributeId: z.string(),
  name: z.string(),
  required: z.boolean(),
  input: z.enum(["select", "multi_select", "text", "select_or_text", "multi_select_or_text"]),
  values: z.array(z.object({ valueId: z.string(), name: z.string() })),
  units: z.array(z.string()),
  valueFormat: z.enum(["date", "integer", "decimal"]).nullable(),
  maxValues: z.number().int().nullable(),
  requiredWhen: z
    .array(z.object({ attributeId: z.string(), valueId: z.string() }))
    .describe("wajib bila atribut lain bernilai ini (Tokopedia & Shop)"),
});

const rulesSchema = z.object({
  attributes: z.array(attributeRuleSchema),
  brandRequired: z.boolean(),
  weightRequired: z.boolean(),
  dimensionsRequired: z.boolean(),
  sizeChart: z.object({ supported: z.boolean(), required: z.boolean() }),
  certifications: z.array(z.string()),
  daysToShip: z.number().int().nullable(),
  limits: z.object({
    titleMin: z.number().int(),
    titleMax: z.number().int(),
    descriptionMin: z.number().int(),
    descriptionMax: z.number().int(),
    imagesMin: z.number().int(),
    imagesMax: z.number().int(),
    priceMin: z.number().int().nullable(),
    priceMax: z.number().int().nullable(),
    variantsMax: z.number().int(),
    variationsMax: z.number().int(),
    variationNameMax: z.number().int(),
    optionNameMax: z.number().int(),
    skuMax: z.number().int(),
    skuNoSpaces: z.boolean(),
  }),
});

export const rulesView = (r: CategoryRules): z.infer<typeof rulesSchema> => ({
  attributes: r.attributes.map((a) => ({
    attributeId: a.externalId,
    name: a.name,
    required: a.required,
    input: a.input,
    values: a.values.map((v) => ({ valueId: v.externalId, name: v.name })),
    units: a.units,
    valueFormat: a.valueFormat,
    maxValues: a.maxValues,
    requiredWhen: a.requiredWhen,
  })),
  brandRequired: r.brandRequired,
  weightRequired: r.weightRequired,
  dimensionsRequired: r.dimensionsRequired,
  sizeChart: r.sizeChart,
  certifications: r.certifications,
  daysToShip: r.daysToShip,
  limits: r.limits,
});

export class CategoryDetailDto extends createZodDto(
  categorySchema.extend({
    rules: rulesSchema.nullable().describe("atribut dan batas kategori; null bila belum terbaca"),
    rulesPending: z.boolean().describe("aturan sedang dibaca dari marketplace; minta lagi sebentar lagi"),
    rulesReadAt: iso.nullable(),
  }),
) {}

export class CategoryRefreshDto extends createZodDto(
  z.object({
    requested: z.boolean().describe("false: daftar baru saja dibaca (kurang dari 10 menit)"),
    refreshedAt: iso.nullable(),
  }),
) {}

// ---- copies ----

export class CreateCopyDto extends createZodDto(
  z.object({
    sourceStoreId: ulidSchema,
    listingIds: z
      .array(ulidSchema)
      .min(1)
      .max(500)
      .optional()
      .describe("listing toko asal yang disalin (per produk); tanpa ini seluruh toko asal disalin"),
    targetStoreIds: z.array(ulidSchema).min(1).max(10).describe("satu salinan per toko tujuan"),
    priceChangePercent: z
      .number()
      .min(-90)
      .max(500)
      .default(0)
      .describe("ubah harga sekian persen (dibulatkan ke ratusan rupiah); 0: harga sama"),
    skipListed: z
      .boolean()
      .default(true)
      .describe("lewati produk yang semua variannya sudah punya listing di toko tujuan"),
  }),
) {}

export class CopyIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export class CopyQueryDto extends createZodDto(
  paginationQuery.extend({
    targetStoreId: ulidSchema.optional(),
    sourceStoreId: ulidSchema.optional(),
    status: z.enum(LISTING_COPY_STATUSES).optional(),
  }),
) {}

const storeRefSchema = z.object({ id: ulidSchema, name: z.string(), channel: z.string(), channelName: z.string() });
type StoreRef = z.infer<typeof storeRefSchema>;

const copySchema = z.object({
  id: ulidSchema,
  sourceStore: storeRefSchema,
  targetStore: storeRefSchema,
  scope: z.enum(["items", "store"]).describe("items: listing terpilih; store: seluruh toko asal"),
  status: z.enum(LISTING_COPY_STATUSES),
  priceChangePercent: z.number(),
  skipListed: z.boolean(),
  itemsTotal: z.number().int(),
  itemsDrafted: z.number().int(),
  itemsSkipped: z.number().int().describe("sudah ada drafnya, atau sudah ada listingnya di toko tujuan"),
  itemsFailed: z.number().int(),
  failures: z.array(z.object({ externalItemId: z.string(), title: z.string().nullable(), reason: z.string() })),
  drafts: z.record(z.enum(LISTING_DRAFT_STATUSES), z.number().int()).describe("jumlah draf per status"),
  error: z.string().nullable(),
  createdAt: iso,
  finishedAt: iso.nullable(),
});

export function copyView(v: CopyView, store: (id: string) => StoreRef): z.infer<typeof copySchema> {
  const c = v.copy;
  return {
    id: c.id,
    sourceStore: store(c.sourceStoreId),
    targetStore: store(c.targetStoreId),
    scope: c.scope,
    status: c.status,
    priceChangePercent: c.options.priceChangePercent,
    skipListed: c.options.skipListed,
    itemsTotal: c.itemsTotal,
    itemsDrafted: c.itemsDrafted,
    itemsSkipped: c.itemsSkipped,
    itemsFailed: c.itemsFailed,
    failures: c.failures,
    drafts: Object.fromEntries(LISTING_DRAFT_STATUSES.map((s) => [s, v.drafts[s] ?? 0])) as Record<
      (typeof LISTING_DRAFT_STATUSES)[number],
      number
    >,
    error: c.error,
    createdAt: c.createdAt.toISOString(),
    finishedAt: c.finishedAt?.toISOString() ?? null,
  };
}

export class CopyDto extends createZodDto(copySchema) {}
export class CopyListDto extends createZodDto(z.object({ items: z.array(copySchema) })) {}
export class CopyPageDto extends createZodDto(pageSchema(copySchema)) {}

// ---- drafts ----

export class DraftIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export class DraftQueryDto extends createZodDto(
  paginationQuery.extend({
    copyId: ulidSchema.optional(),
    targetStoreId: ulidSchema.optional(),
    status: z.enum(LISTING_DRAFT_STATUSES).optional(),
    q: z.string().trim().min(1).max(100).optional().describe("cari di nama produk"),
    blocking: z
      .enum(["true", "false"])
      .optional()
      .describe("true: hanya draf yang masih punya masalah penghalang; false: yang siap terbit"),
  }),
) {}

const problemSchema = z.object({
  code: z.string(),
  field: z.string().describe("bagian yang diperbaiki: title, attributes.<id>, variants.<key>.sku, ..."),
  message: z.string(),
  blocking: z.boolean().describe("true: harus diperbaiki sebelum terbit"),
});

const imageSchema = z.object({
  sourceUrl: z.string(),
  uploaded: z.boolean().describe("sudah diunggah ke marketplace tujuan"),
  url: z.string().nullable().describe("alamat di marketplace tujuan, setelah diunggah"),
});

const draftSummarySchema = z.object({
  id: ulidSchema,
  copyId: ulidSchema,
  sourceStoreId: ulidSchema,
  targetStoreId: ulidSchema,
  externalSourceItemId: z.string(),
  status: z.enum(LISTING_DRAFT_STATUSES),
  title: z.string(),
  categoryPath: z.string().nullable(),
  imageUrl: z.string().nullable().describe("foto pertama (dari toko asal)"),
  variantCount: z.number().int(),
  priceMin: z.number().int().nullable(),
  priceMax: z.number().int().nullable(),
  blockingProblems: z.number().int(),
  warnings: z.number().int(),
  externalTargetItemId: z.string().nullable().describe("id produk di toko tujuan setelah terbit"),
  error: z.string().nullable().describe("alasan gagal terbit terakhir"),
  rowVersion: z.number().int(),
  updatedAt: iso,
});

export function draftSummaryView(d: DraftRow): z.infer<typeof draftSummarySchema> {
  const prices = d.variants.map((v) => v.price);
  return {
    id: d.id,
    copyId: d.copyId,
    sourceStoreId: d.sourceStoreId,
    targetStoreId: d.targetStoreId,
    externalSourceItemId: d.externalSourceItemId,
    status: d.status,
    title: d.title,
    categoryPath: d.categoryPath,
    imageUrl: d.images[0]?.sourceUrl ?? null,
    variantCount: d.variants.length,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    blockingProblems: d.problems.filter((p) => p.blocking).length,
    warnings: d.problems.filter((p) => !p.blocking).length,
    externalTargetItemId: d.status === "published" ? d.externalTargetItemId : null,
    error: d.error,
    rowVersion: d.rowVersion,
    updatedAt: d.updatedAt.toISOString(),
  };
}

const draftSchema = draftSummarySchema.extend({
  description: z.string(),
  descriptionHtml: z.string().nullable().describe("deskripsi HTML asal (Tokopedia & Shop), dipakai apa adanya"),
  externalCategoryId: z.string().nullable(),
  brand: z.object({ brandId: z.string().nullable(), name: z.string().nullable() }).nullable(),
  attributes: z.array(
    z.object({
      attributeId: z.string(),
      name: z.string().nullable(),
      values: z.array(
        z.object({ valueId: z.string().nullable(), name: z.string().nullable(), unit: z.string().nullable() }),
      ),
    }),
  ),
  images: z.array(imageSchema),
  sizeChart: imageSchema.nullable(),
  weightG: z.number().int().nullable(),
  dimensionsMm: z.object({ length: z.number().int(), width: z.number().int(), height: z.number().int() }).nullable(),
  condition: z.enum(["new", "used"]),
  preOrderDays: z.number().int().nullable(),
  itemSku: z.string().nullable(),
  variationNames: z.array(z.string()),
  variants: z.array(
    z.object({
      key: z.string(),
      externalSourceVariantId: z.string(),
      variantId: ulidSchema.nullable().describe("varian OmniSeller; listing baru dipetakan ke sini"),
      sku: z.string().nullable(),
      options: z.array(z.string()),
      price: z.number().int(),
      image: imageSchema.nullable(),
      gtin: z.string().nullable(),
    }),
  ),
  problems: z.array(problemSchema),
  source: z.object({
    channel: z.string(),
    categoryId: z.string(),
    categoryPath: z.string().nullable(),
    brand: z.string().nullable(),
  }),
  publishAttempt: z.number().int(),
  publishedAt: iso.nullable(),
  createdAt: iso,
});

const imageView = (i: { sourceUrl: string; ref: string | null; url: string | null }) => ({
  sourceUrl: i.sourceUrl,
  uploaded: i.ref !== null,
  url: i.url,
});

export function draftView(d: DraftRow): z.infer<typeof draftSchema> {
  return {
    ...draftSummaryView(d),
    description: d.description,
    descriptionHtml: d.descriptionHtml,
    externalCategoryId: d.externalCategoryId,
    brand: d.brand ? { brandId: d.brand.externalId, name: d.brand.name } : null,
    attributes: d.attributes.map((a) => ({
      attributeId: a.attributeId,
      name: a.name,
      values: a.values.map((v) => ({ valueId: v.externalId, name: v.name, unit: v.unit ?? null })),
    })),
    images: d.images.map(imageView),
    sizeChart: d.sizeChart ? imageView(d.sizeChart) : null,
    weightG: d.weightG,
    dimensionsMm: d.dimensionsMm,
    condition: d.condition,
    preOrderDays: d.preOrderDays,
    itemSku: d.itemSku,
    variationNames: d.variationNames,
    variants: d.variants.map((v) => ({
      key: v.key,
      externalSourceVariantId: v.externalSourceVariantId,
      variantId: v.variantId,
      sku: v.sku,
      options: v.options,
      price: v.price,
      image: v.image ? imageView(v.image) : null,
      gtin: v.gtin,
    })),
    problems: d.problems,
    source: {
      channel: d.source.channel,
      categoryId: d.source.category.externalId,
      categoryPath: d.source.category.path,
      brand: d.source.brand?.name ?? null,
    },
    publishAttempt: d.publishAttempt,
    publishedAt: d.publishedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

export class DraftDto extends createZodDto(draftSchema) {}
export class DraftPageDto extends createZodDto(pageSchema(draftSummarySchema)) {}

const attributeValueInput = z.object({
  valueId: z.string().trim().min(1).max(64).nullable().optional().describe("nilai dari daftar kategori"),
  name: z.string().trim().min(1).max(200).nullable().optional().describe("nilai ketik, bila atributnya menerima teks"),
  unit: z.string().trim().min(1).max(20).nullable().optional(),
});

export class UpdateDraftDto extends createZodDto(
  z
    .object({
      title: z.string().trim().min(1).max(300),
      description: z.string().max(30_000).describe("teks biasa; menggantikan deskripsi HTML asal"),
      brand: z
        .object({ name: z.string().trim().max(100) })
        .nullable()
        .describe("null: tanpa merek"),
      attributes: z
        .array(
          z.object({ attributeId: z.string().trim().min(1).max(64), values: z.array(attributeValueInput).max(30) }),
        )
        .max(100)
        .describe("menggantikan semua atribut draf"),
      images: z
        .array(z.string().max(2000))
        .max(20)
        .describe("sourceUrl foto draf dalam urutan baru; foto yang tidak disebut dihapus"),
      weightG: z.number().int().min(1).max(1_000_000),
      dimensionsMm: z
        .object({
          length: z.number().int().min(1).max(100_000),
          width: z.number().int().min(1).max(100_000),
          height: z.number().int().min(1).max(100_000),
        })
        .nullable(),
      condition: z.enum(["new", "used"]),
      preOrderDays: z.number().int().min(1).max(90).nullable(),
      itemSku: z.string().trim().max(100).nullable(),
      variationNames: z.array(z.string().trim().min(1).max(50)).max(3).describe("ganti nama; jumlahnya tetap"),
      variants: z
        .array(
          z.object({
            key: z.string().min(1).max(10),
            sku: z.string().trim().max(100).nullable().optional(),
            price: rupiah.optional(),
            options: z.array(z.string().trim().min(1).max(100)).max(3).optional(),
          }),
        )
        .min(1)
        .max(200)
        .describe("varian yang tetap ada (varian yang tidak disebut dihapus) dan perubahannya"),
    })
    .partial(),
) {}

export class DraftCategoryDto extends createZodDto(z.object({ draftIds, categoryId })) {}
export class DraftCategoryResultDto extends createZodDto(z.object({ updated: z.number().int() })) {}

export class DraftAttributeDto extends createZodDto(
  z.object({
    draftIds,
    attributeId: z.string().trim().min(1).max(64),
    values: z.array(attributeValueInput).max(30).describe("kosong: hapus atribut ini dari draf"),
  }),
) {}
export class DraftAttributeResultDto extends createZodDto(
  z.object({
    updated: z.array(ulidSchema),
    skipped: z.array(z.object({ draftId: ulidSchema, reason: z.string() })),
  }),
) {}

export class PublishDraftsDto extends createZodDto(z.object({ draftIds })) {}
export class PublishResultDto extends createZodDto(
  z.object({
    queued: z.array(ulidSchema),
    refused: z.array(z.object({ draftId: ulidSchema, code: z.string(), message: z.string() })),
  }),
) {}
