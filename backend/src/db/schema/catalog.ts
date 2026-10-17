import { boolean, integer, jsonb, pgTable, smallint, text } from "drizzle-orm/pg-core";
import { baseColumns, money, qty, tstz, ulid } from "../columns";

export const product = pgTable("product", {
  ...baseColumns(),
  name: text("name").notNull(),
  sku: text("sku").notNull(),
  description: text("description"),
  brand: text("brand"),
  categoryPath: text("category_path"),
  status: text("status").$type<"active" | "archived">().notNull().default("active"),
  attributeNames: text("attribute_names").array().notNull().default([]),
  deletedAt: tstz("deleted_at"),
});

export const variant = pgTable("variant", {
  ...baseColumns(),
  productId: ulid("product_id").notNull(),
  sku: text("sku").notNull(),
  barcode: text("barcode"),
  name: text("name").notNull(),
  attributes: jsonb("attributes").$type<Record<string, string>>().notNull().default({}),
  costPrice: money("cost_price").notNull().default(0),
  basePrice: money("base_price").notNull(),
  weightG: integer("weight_g").notNull(),
  lengthMm: integer("length_mm"),
  widthMm: integer("width_mm"),
  heightMm: integer("height_mm"),
  isBundle: boolean("is_bundle").notNull().default(false),
  status: text("status").$type<"active" | "archived">().notNull().default("active"),
  deletedAt: tstz("deleted_at"),
});

export const productImage = pgTable("product_image", {
  ...baseColumns(),
  productId: ulid("product_id").notNull(),
  variantId: ulid("variant_id"),
  /** Stored copy; null while the image is only referenced by its marketplace URL. */
  fileObjectId: ulid("file_object_id"),
  sourceUrl: text("source_url"),
  position: smallint("position").notNull(),
});

export const bundleComponent = pgTable("bundle_component", {
  ...baseColumns(),
  bundleVariantId: ulid("bundle_variant_id").notNull(),
  componentVariantId: ulid("component_variant_id").notNull(),
  qty: integer("qty").notNull(),
});

export type ListingStatus = "active" | "inactive" | "banned" | "reviewing" | "deleted" | "unknown";
/**
 * auto_sku: same SKU as a variant; manual: chosen by a person; created: the variant was created from it;
 * copied: the listing was created by copying a listing of that variant from another store (FR-PRD-13).
 */
export type MappingSource = "auto_sku" | "manual" | "created" | "copied";

export interface LinkFields {
  title: boolean;
  description: boolean;
  price: boolean;
  images: boolean;
  weight: boolean;
}

export const channelListing = pgTable("channel_listing", {
  ...baseColumns(),
  storeId: ulid("store_id").notNull(),
  externalItemId: text("external_item_id").notNull(),
  externalVariantId: text("external_variant_id").notNull().default(""),
  externalSku: text("external_sku"),
  variantId: ulid("variant_id"),
  title: text("title").notNull(),
  price: money("price"),
  originalPrice: money("original_price"),
  status: text("status").$type<ListingStatus>().notNull().default("unknown"),
  stockAtChannel: qty("stock_at_channel"),
  linkFields: jsonb("link_fields")
    .$type<LinkFields>()
    .notNull()
    .default({ title: false, description: false, price: true, images: false, weight: true }),
  overrides: jsonb("overrides").$type<Record<string, unknown>>().notNull().default({}),
  channelData: jsonb("channel_data").$type<Record<string, unknown>>().notNull().default({}),
  lastPulledAt: tstz("last_pulled_at"),
  mappingSource: text("mapping_source").$type<MappingSource>(),
  mappedAt: tstz("mapped_at"),
});

export type ListingPriceChangeStatus = "queued" | "processing" | "succeeded" | "failed" | "cancelled";
export const listingPriceChange = pgTable("listing_price_change", {
  ...baseColumns(),
  listingId: ulid("listing_id").notNull(),
  storeId: ulid("store_id").notNull(),
  requestedBy: ulid("requested_by"),
  expectedPrice: money("expected_price").notNull(),
  requestedPrice: money("requested_price").notNull(),
  observedPrice: money("observed_price"),
  sentAt: tstz("sent_at"),
  status: text("status").$type<ListingPriceChangeStatus>().notNull().default("queued"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  claimedAt: tstz("claimed_at"),
  claimId: ulid("claim_id"),
});
