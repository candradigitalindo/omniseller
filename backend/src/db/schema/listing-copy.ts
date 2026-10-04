import type { ListingCopyStatus, ListingDraftStatus } from "@omniseller/shared";
import { boolean, integer, jsonb, pgTable, smallint, text } from "drizzle-orm/pg-core";
import { baseColumns, tstz, ulid } from "../columns";

// ---- copying listings between the seller's stores (PRD FR-PRD-13, backend doc 8.25) ----

export const channelCategory = pgTable("channel_category", {
  ...baseColumns(),
  storeId: ulid("store_id").notNull(),
  externalId: text("external_id").notNull(),
  externalParentId: text("external_parent_id"),
  name: text("name").notNull(),
  path: text("path").notNull(),
  isLeaf: boolean("is_leaf").notNull(),
  permitted: boolean("permitted").notNull().default(true),
  /** `CategoryRules` of the connector, as read. */
  rules: jsonb("rules").$type<Record<string, unknown>>(),
  rulesReadAt: tstz("rules_read_at"),
  seenAt: tstz("seen_at").notNull(),
});

export const categoryMapping = pgTable("category_mapping", {
  ...baseColumns(),
  sourceChannel: text("source_channel").notNull(),
  externalSourceCategoryId: text("external_source_category_id").notNull(),
  targetChannel: text("target_channel").notNull(),
  externalTargetCategoryId: text("external_target_category_id").notNull(),
  targetCategoryPath: text("target_category_path"),
  uses: integer("uses").notNull().default(1),
  lastUsedAt: tstz("last_used_at").notNull().defaultNow(),
});

export interface ListingCopyOptions {
  /** Prices change by this percentage (-90 to 500); 0 keeps them. */
  priceChangePercent: number;
  /** Items whose every variant already has a listing in the target store are not drafted. */
  skipListed: boolean;
}

export interface ListingCopyFailure {
  externalItemId: string;
  title: string | null;
  reason: string;
}

export const listingCopy = pgTable("listing_copy", {
  ...baseColumns(),
  sourceStoreId: ulid("source_store_id").notNull(),
  targetStoreId: ulid("target_store_id").notNull(),
  scope: text("scope").$type<"items" | "store">().notNull(),
  externalItemIds: text("external_item_ids").array().notNull().default([]),
  options: jsonb("options").$type<ListingCopyOptions>().notNull(),
  status: text("status").$type<ListingCopyStatus>().notNull().default("preparing"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  cursor: text("cursor"),
  itemsTotal: integer("items_total").notNull().default(0),
  itemsDrafted: integer("items_drafted").notNull().default(0),
  itemsSkipped: integer("items_skipped").notNull().default(0),
  itemsFailed: integer("items_failed").notNull().default(0),
  failures: jsonb("failures").$type<ListingCopyFailure[]>().notNull().default([]),
  error: text("error"),
  createdBy: ulid("created_by"),
  finishedAt: tstz("finished_at"),
});

/** An image of a draft: where it comes from and, once uploaded to the target marketplace, its reference. */
export interface DraftImage {
  sourceUrl: string;
  ref: string | null;
  url: string | null;
}

export interface DraftAttribute {
  attributeId: string;
  name: string | null;
  values: { externalId: string | null; name: string | null; unit?: string | null }[];
}

export interface DraftVariant {
  /** Stable within the draft: `v<n>`. */
  key: string;
  externalSourceVariantId: string;
  /** The OmniSeller variant the source listing is mapped to; the new listing is mapped to it too. */
  variantId: string | null;
  sku: string | null;
  /** One option per variation name, in order. */
  options: string[];
  price: number;
  /** Image of the variant's first option. */
  image: DraftImage | null;
  gtin: string | null;
}

export interface DraftProblem {
  code: string;
  /** Where to fix it: `title`, `attributes.<attributeId>`, `variants.<key>.sku`, ... */
  field: string;
  message: string;
  /** Publishing waits until every blocking problem is fixed; the others are for review. */
  blocking: boolean;
}

/** The source product as read when the draft was made, for preparing it again in another category. */
export interface DraftSource {
  channel: string;
  category: { externalId: string; name: string | null; path: string | null };
  brand: { externalId: string | null; name: string | null } | null;
  attributes: DraftAttribute[];
  /** Marketplace settings kept for a copy to the same marketplace (Shopee logistics). */
  extras: Record<string, unknown>;
  /** Facts found while preparing (already copied, brand not found), shown with the draft's problems. */
  notes: DraftProblem[];
}

export const listingDraft = pgTable("listing_draft", {
  ...baseColumns(),
  copyId: ulid("copy_id").notNull(),
  sourceStoreId: ulid("source_store_id").notNull(),
  targetStoreId: ulid("target_store_id").notNull(),
  externalSourceItemId: text("external_source_item_id").notNull(),
  status: text("status").$type<ListingDraftStatus>().notNull().default("draft"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  descriptionHtml: text("description_html"),
  externalCategoryId: text("external_category_id"),
  categoryPath: text("category_path"),
  brand: jsonb("brand").$type<{ externalId: string | null; name: string | null } | null>(),
  attributes: jsonb("attributes").$type<DraftAttribute[]>().notNull().default([]),
  images: jsonb("images").$type<DraftImage[]>().notNull().default([]),
  sizeChart: jsonb("size_chart").$type<DraftImage | null>(),
  weightG: integer("weight_g"),
  dimensionsMm: jsonb("dimensions_mm").$type<{ length: number; width: number; height: number } | null>(),
  condition: text("condition").$type<"new" | "used">().notNull().default("new"),
  preOrderDays: smallint("pre_order_days"),
  itemSku: text("item_sku"),
  variationNames: text("variation_names").array().notNull().default([]),
  variants: jsonb("variants").$type<DraftVariant[]>().notNull().default([]),
  source: jsonb("source").$type<DraftSource>().notNull(),
  problems: jsonb("problems").$type<DraftProblem[]>().notNull().default([]),
  publishAttempt: integer("publish_attempt").notNull().default(0),
  externalTargetItemId: text("external_target_item_id"),
  publishingStartedAt: tstz("publishing_started_at"),
  publishedAt: tstz("published_at"),
  publishedBy: ulid("published_by"),
  error: text("error"),
});
