import { ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { pageSchema, paginationQuery } from "../../common/http/pagination";
import type { ListingChannelData, ListingView, SuggestionView } from "./listings.service";
import { dataOf } from "./listings.service";
import { MAX_ATTRIBUTES, type ProductView } from "./products.service";

/** Request and response DTOs of the catalog endpoints (backend doc 10.6). */

const iso = z.iso.datetime();
const sku = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\r\n\t]+$/, "SKU tanpa baris baru.");
const rupiah = z.number().int().min(0).max(1_000_000_000_000);
const httpsUrl = z
  .url()
  .max(2000)
  .regex(/^https:\/\//, "Gunakan URL https.");
const mm = z.number().int().min(1).max(100_000).nullable().optional();

const variantInput = z.object({
  sku,
  name: z.string().trim().min(1).max(255).optional(),
  attributes: z.record(z.string().trim().min(1).max(30), z.string().trim().min(1).max(60)).optional(),
  barcode: z.string().trim().max(64).nullable().optional(),
  basePrice: rupiah,
  costPrice: rupiah.optional(),
  weightG: z.number().int().min(1).max(1_000_000),
  lengthMm: mm,
  widthMm: mm,
  heightMm: mm,
  imageUrl: httpsUrl.nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const productFields = {
  sku,
  name: z.string().trim().min(1).max(255),
  description: z.string().max(20_000).nullable().optional(),
  brand: z.string().trim().max(100).nullable().optional(),
  categoryPath: z.string().trim().max(255).nullable().optional(),
  attributeNames: z.array(z.string().trim().min(1).max(30)).max(MAX_ATTRIBUTES).optional(),
  imageUrls: z.array(httpsUrl).max(9).optional(),
};

export class ProductIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
export class VariantParamDto extends createZodDto(z.object({ id: ulidSchema, variantId: ulidSchema })) {}
export class ListingIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export class ProductQueryDto extends createZodDto(
  paginationQuery.extend({
    q: z.string().trim().max(100).optional(),
    status: z.enum(["active", "archived"]).optional(),
  }),
) {}

export class CreateProductDto extends createZodDto(
  z.object({ ...productFields, variants: z.array(variantInput).min(1).max(200) }),
) {}

export class UpdateProductDto extends createZodDto(
  z
    .object({
      ...productFields,
      status: z.enum(["active", "archived"]),
    })
    .partial()
    .refine((v) => Object.keys(v).length > 0, { message: "Tidak ada yang diubah." }),
) {}

export class CreateVariantDto extends createZodDto(variantInput) {}
export class UpdateVariantDto extends createZodDto(
  variantInput.partial().refine((v) => Object.keys(v).length > 0, { message: "Tidak ada yang diubah." }),
) {}

export class ImportProductsDto extends createZodDto(
  z.object({
    content: z.string().min(1).max(10_000_000).describe("isi file CSV (UTF-8), pemisah ; atau ,"),
    dryRun: z.boolean().default(false).describe("validasi dan hitung tanpa menyimpan"),
  }),
) {}

export class ImportSummaryDto extends createZodDto(
  z.object({
    rows: z.number().int(),
    products: z.object({ created: z.number().int(), updated: z.number().int() }),
    variants: z.object({ created: z.number().int(), updated: z.number().int() }),
    dryRun: z.boolean(),
  }),
) {}

const variantSchema = z.object({
  id: ulidSchema,
  sku: z.string(),
  name: z.string(),
  attributes: z.record(z.string(), z.string()),
  barcode: z.string().nullable(),
  basePrice: z.number().int(),
  costPrice: z.number().int(),
  weightG: z.number().int(),
  lengthMm: z.number().int().nullable(),
  widthMm: z.number().int().nullable(),
  heightMm: z.number().int().nullable(),
  status: z.enum(["active", "archived"]),
  imageUrl: z.string().nullable(),
  listingCount: z.number().int().describe("listing marketplace yang terpetakan ke varian ini"),
});

const productSchema = z.object({
  id: ulidSchema,
  sku: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  brand: z.string().nullable(),
  categoryPath: z.string().nullable(),
  status: z.enum(["active", "archived"]),
  attributeNames: z.array(z.string()),
  imageUrls: z.array(z.string()),
  variants: z.array(variantSchema),
  createdAt: iso,
  updatedAt: iso,
});
export class ProductDto extends createZodDto(productSchema) {}
export class ProductPageDto extends createZodDto(pageSchema(productSchema)) {}

export function productView(v: ProductView): z.infer<typeof productSchema> {
  const p = v.product;
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    brand: p.brand,
    categoryPath: p.categoryPath,
    status: p.status,
    attributeNames: p.attributeNames,
    imageUrls: v.imageUrls,
    variants: v.variants.map((x) => ({
      id: x.id,
      sku: x.sku,
      name: x.name,
      attributes: x.attributes,
      barcode: x.barcode,
      basePrice: x.basePrice,
      costPrice: x.costPrice,
      weightG: x.weightG,
      lengthMm: x.lengthMm,
      widthMm: x.widthMm,
      heightMm: x.heightMm,
      status: x.status,
      imageUrl: x.imageUrl,
      listingCount: x.listingCount,
    })),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

// ---- listings ----

const listingStatus = z.enum(["active", "inactive", "banned", "reviewing", "deleted", "unknown"]);

export class ListingQueryDto extends createZodDto(
  paginationQuery.extend({
    storeId: ulidSchema.optional(),
    status: listingStatus.optional(),
    mapped: z.enum(["true", "false"]).optional(),
    variantId: ulidSchema.optional(),
    q: z.string().trim().max(100).optional(),
  }),
) {}

export class UnmappedQueryDto extends createZodDto(
  paginationQuery.extend({ storeId: ulidSchema.optional(), q: z.string().trim().max(100).optional() }),
) {}

export class MapListingDto extends createZodDto(
  z.object({ variantId: ulidSchema.nullable().describe("null melepas pemetaan") }),
) {}

export class AutoMapDto extends createZodDto(z.object({ storeId: ulidSchema.optional() })) {}
export class AutoMapResultDto extends createZodDto(z.object({ mapped: z.number().int() })) {}

const listingIds = z.array(ulidSchema).min(1).max(500);
export class CreateFromListingsDto extends createZodDto(z.object({ listingIds })) {}
export class CreateFromListingsResultDto extends createZodDto(
  z.object({
    created: z.array(z.object({ productId: ulidSchema, sku: z.string(), listingIds: z.array(ulidSchema) })),
    mappedToExisting: z.array(z.object({ listingId: ulidSchema, variantId: ulidSchema })),
    failed: z.array(z.object({ listingIds: z.array(ulidSchema), message: z.string() })),
  }),
) {}

export class ListingStatusDto extends createZodDto(z.object({ listingIds, active: z.boolean() })) {}
export class ListingStatusAcceptedDto extends createZodDto(
  z.object({ stores: z.number().int(), items: z.number().int().describe("item marketplace yang diproses") }),
) {}

export class ListingSyncDto extends createZodDto(
  z.object({
    storeId: ulidSchema,
    full: z.boolean().default(false).describe("tarik semua item dan tutup yang sudah dihapus"),
  }),
) {}

const listingSchema = z.object({
  id: ulidSchema,
  storeId: ulidSchema,
  store: z.object({ name: z.string(), channel: z.string(), channelName: z.string() }).nullable(),
  externalItemId: z.string(),
  externalVariantId: z.string(),
  sku: z.string().nullable(),
  title: z.string(),
  variantName: z.string().nullable(),
  attributes: z.record(z.string(), z.string()),
  imageUrl: z.string().nullable(),
  price: z.number().int().nullable(),
  originalPrice: z.number().int().nullable(),
  status: listingStatus,
  statusDetail: z.record(z.string(), z.unknown()),
  stock: z.number().int().nullable(),
  stockByWarehouse: z.record(z.string(), z.number()),
  mapping: z
    .object({
      variantId: ulidSchema,
      sku: z.string(),
      variantName: z.string(),
      productId: ulidSchema,
      productName: z.string(),
      source: z.enum(["auto_sku", "manual", "created"]),
      mappedAt: iso,
    })
    .nullable(),
  lastPulledAt: iso.nullable(),
});
export class ListingDto extends createZodDto(listingSchema) {}
export class ListingPageDto extends createZodDto(pageSchema(listingSchema)) {}

const suggestionSchema = z.object({
  variantId: ulidSchema,
  sku: z.string(),
  variantName: z.string(),
  productId: ulidSchema,
  productName: z.string(),
  score: z.number().describe("1 untuk SKU sama; kemiripan nama 0 sampai 1"),
  reason: z.enum(["sku", "name"]),
});
const unmappedSchema = listingSchema.extend({ suggestions: z.array(suggestionSchema) });
export class UnmappedPageDto extends createZodDto(pageSchema(unmappedSchema)) {}

export function listingView(v: ListingView): z.infer<typeof listingSchema> {
  const l = v.listing;
  const d: ListingChannelData = dataOf(l);
  return {
    id: l.id,
    storeId: l.storeId,
    store: v.store,
    externalItemId: l.externalItemId,
    externalVariantId: l.externalVariantId,
    sku: l.externalSku,
    title: l.title,
    variantName: d.variantName ?? null,
    attributes: d.attributes ?? {},
    imageUrl: d.imageUrl ?? null,
    price: l.price,
    originalPrice: l.originalPrice,
    status: l.status,
    statusDetail: d.statusDetail ?? {},
    stock: l.stockAtChannel,
    stockByWarehouse: d.stockByWarehouse ?? {},
    mapping:
      l.variant && l.mappingSource && l.mappedAt
        ? {
            variantId: l.variant.id,
            sku: l.variant.sku,
            variantName: l.variant.name,
            productId: l.variant.productId,
            productName: l.variant.productName,
            source: l.mappingSource,
            mappedAt: l.mappedAt.toISOString(),
          }
        : null,
    lastPulledAt: l.lastPulledAt?.toISOString() ?? null,
  };
}

export function unmappedView(v: ListingView & { suggestions: SuggestionView[] }) {
  return { ...listingView(v), suggestions: v.suggestions };
}
