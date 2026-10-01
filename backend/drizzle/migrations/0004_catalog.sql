-- 0004_catalog: master products, marketplace listings, SKU mapping (backend doc 7.8.3; PRD 6.2).

-- Trigram similarity for "belum terpetakan" suggestions (FR-PRD-03). Trusted extension, created by
-- the database owner (omniseller_migrator), like citext.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Shopee REVIEWING and TikTok Shop PENDING are neither live nor rejected.
ALTER TABLE channel_listing DROP CONSTRAINT channel_listing_status_check;
ALTER TABLE channel_listing ADD CONSTRAINT channel_listing_status_check
  CHECK (status IN ('active', 'inactive', 'banned', 'reviewing', 'deleted', 'unknown'));

-- How a listing got its variant: matched by SKU, chosen by a person, or created from the listing.
ALTER TABLE channel_listing ADD COLUMN mapping_source text
  CHECK (mapping_source IN ('auto_sku', 'manual', 'created'));
ALTER TABLE channel_listing ADD COLUMN mapped_at timestamptz;
UPDATE channel_listing SET mapping_source = 'manual', mapped_at = updated_at WHERE variant_id IS NOT NULL;
ALTER TABLE channel_listing ADD CONSTRAINT channel_listing_mapping_ck
  CHECK ((variant_id IS NULL) = (mapping_source IS NULL) AND (variant_id IS NULL) = (mapped_at IS NULL));

-- A product image is either a stored file or, until the file pipeline copies it, the marketplace's URL.
ALTER TABLE product_image ALTER COLUMN file_object_id DROP NOT NULL;
ALTER TABLE product_image ADD COLUMN source_url text;
ALTER TABLE product_image ADD CONSTRAINT product_image_source_ck
  CHECK (file_object_id IS NOT NULL OR source_url IS NOT NULL);

-- SKU matching ignores case and surrounding spaces (FR-PRD-02), so SKUs are unique that way too: two
-- variants "ABC" and "abc" would make every listing with that SKU ambiguous.
CREATE UNIQUE INDEX product_tenant_sku_norm_uq ON product (tenant_id, lower(btrim(sku))) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX variant_tenant_sku_norm_uq ON variant (tenant_id, lower(btrim(sku))) WHERE deleted_at IS NULL;
CREATE INDEX channel_listing_tenant_sku_norm_idx ON channel_listing (tenant_id, lower(btrim(external_sku)))
  WHERE external_sku IS NOT NULL;
CREATE INDEX product_name_trgm_idx ON product USING gin (name gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX channel_listing_title_trgm_idx ON channel_listing USING gin (title gin_trgm_ops);
CREATE INDEX channel_listing_tenant_store_item_idx ON channel_listing (tenant_id, store_id, external_item_id);
