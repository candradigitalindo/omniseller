-- 0015_listing_copy: copying listings between the seller's own stores, a whole store at once, through
-- drafts reviewed before publishing (PRD FR-PRD-13; backend doc 8.25).

------------------------------------------------------------------------------------------------
-- Categories as each store sees them, and what each category asks of a new product
------------------------------------------------------------------------------------------------

-- The marketplace's category tree per store (TikTok Shop permits categories per shop), refreshed by the
-- worker. `rules` holds the attributes, limits, and brand and size chart rules of a leaf once read.
CREATE TABLE channel_category (
  id                 ulid PRIMARY KEY,
  tenant_id          ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  row_version        integer NOT NULL DEFAULT 1,
  store_id           ulid NOT NULL,
  external_id        text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 64),
  external_parent_id text,
  name               text NOT NULL,
  -- "Pakaian Pria > Kaos", for search and display
  path               text NOT NULL,
  is_leaf            boolean NOT NULL,
  permitted          boolean NOT NULL DEFAULT true,
  rules              jsonb,
  rules_read_at      timestamptz,
  -- the refresh that last listed it; categories not listed by a later refresh are removed
  seen_at            timestamptz NOT NULL,
  CONSTRAINT channel_category_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT channel_category_store_external_uq UNIQUE (tenant_id, store_id, external_id),
  CONSTRAINT channel_category_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_category_rules_ck CHECK ((rules IS NULL) = (rules_read_at IS NULL))
);
CREATE INDEX channel_category_parent_idx ON channel_category (tenant_id, store_id, external_parent_id);
CREATE INDEX channel_category_path_trgm_idx ON channel_category USING gin (path gin_trgm_ops);

-- The seller's choice of category on one marketplace for a category of another, learned from drafts
-- (a category picked by hand, a product published): the next copy uses it without asking again.
CREATE TABLE category_mapping (
  id                          ulid PRIMARY KEY,
  tenant_id                   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  row_version                 integer NOT NULL DEFAULT 1,
  source_channel              text NOT NULL,
  external_source_category_id text NOT NULL,
  target_channel              text NOT NULL,
  external_target_category_id text NOT NULL,
  -- shown with the choice
  target_category_path        text,
  uses                        integer NOT NULL DEFAULT 1 CHECK (uses >= 1),
  last_used_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_mapping_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT category_mapping_uq UNIQUE (tenant_id, source_channel, external_source_category_id, target_channel)
);

------------------------------------------------------------------------------------------------
-- A copy: listings of one store (or all of them) into drafts for one target store
------------------------------------------------------------------------------------------------

CREATE TABLE listing_copy_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE listing_copy (
  id                ulid PRIMARY KEY,
  tenant_id         ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  source_store_id   ulid NOT NULL,
  target_store_id   ulid NOT NULL,
  -- items: the marketplace items picked; store: every item of the source store
  scope             text NOT NULL CHECK (scope IN ('items', 'store')),
  external_item_ids text[] NOT NULL DEFAULT '{}',
  -- {priceChangePercent, skipListed}
  options           jsonb NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing', 'ready', 'failed', 'cancelled')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  -- the last item prepared: the next batch starts after it
  cursor            text,
  items_total       integer NOT NULL DEFAULT 0 CHECK (items_total >= 0),
  items_drafted     integer NOT NULL DEFAULT 0 CHECK (items_drafted >= 0),
  items_skipped     integer NOT NULL DEFAULT 0 CHECK (items_skipped >= 0),
  items_failed      integer NOT NULL DEFAULT 0 CHECK (items_failed >= 0),
  -- per item that could not be drafted: [{externalItemId, title, reason}], at most 200
  failures          jsonb NOT NULL DEFAULT '[]',
  error             text,
  created_by        ulid,
  finished_at       timestamptz,
  CONSTRAINT listing_copy_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT listing_copy_source_store_fk FOREIGN KEY (tenant_id, source_store_id)
    REFERENCES store (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT listing_copy_target_store_fk FOREIGN KEY (tenant_id, target_store_id)
    REFERENCES store (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT listing_copy_created_by_fk FOREIGN KEY (tenant_id, created_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (created_by),
  CONSTRAINT listing_copy_stores_ck CHECK (source_store_id <> target_store_id),
  CONSTRAINT listing_copy_items_ck CHECK ((scope = 'items') = (cardinality(external_item_ids) > 0)),
  CONSTRAINT listing_copy_finished_ck CHECK ((status = 'preparing') = (finished_at IS NULL))
);
CREATE INDEX listing_copy_tenant_id_idx ON listing_copy (tenant_id, id DESC);

------------------------------------------------------------------------------------------------
-- A draft: one source item as it will be created in the target store, reviewed and edited first
------------------------------------------------------------------------------------------------

CREATE TABLE listing_draft_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE listing_draft (
  id                      ulid PRIMARY KEY,
  tenant_id               ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  row_version             integer NOT NULL DEFAULT 1,
  copy_id                 ulid NOT NULL,
  source_store_id         ulid NOT NULL,
  target_store_id         ulid NOT NULL,
  external_source_item_id text NOT NULL,
  -- preparing: the worker reads the category's rules and maps the content again (category changed)
  status                  text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('preparing', 'draft', 'publishing', 'published', 'failed')),
  status_changed_at       timestamptz NOT NULL DEFAULT now(),
  title                   text NOT NULL,
  description             text NOT NULL DEFAULT '',
  -- the source's own HTML description (TikTok Shop), used as is on TikTok Shop
  description_html        text,
  external_category_id    text,
  category_path           text,
  -- {externalId, name}; null: no brand
  brand                   jsonb,
  -- [{attributeId, name, values: [{externalId, name, unit}]}] for the target category
  attributes              jsonb NOT NULL DEFAULT '[]',
  -- [{sourceUrl, ref, url}]: ref once uploaded to the target marketplace
  images                  jsonb NOT NULL DEFAULT '[]',
  size_chart              jsonb,
  weight_g                integer CHECK (weight_g > 0),
  dimensions_mm           jsonb,
  condition               text NOT NULL DEFAULT 'new' CHECK (condition IN ('new', 'used')),
  pre_order_days          smallint CHECK (pre_order_days BETWEEN 1 AND 90),
  item_sku                text,
  variation_names         text[] NOT NULL DEFAULT '{}',
  -- [{key, externalSourceVariantId, variantId, sku, options, price, image, gtin}]
  variants                jsonb NOT NULL DEFAULT '[]',
  -- the source as read: channel, category, brand, attributes, marketplace settings (Shopee logistics)
  source                  jsonb NOT NULL DEFAULT '{}',
  -- [{code, field, message, blocking}], computed again after every change
  problems                jsonb NOT NULL DEFAULT '[]',
  -- each publish after a failure is a new request (TikTok Shop idempotency key `<id>-<attempt>`)
  publish_attempt         integer NOT NULL DEFAULT 0 CHECK (publish_attempt >= 0),
  -- the item created on the target marketplace; set alone when Shopee created the item but not its
  -- variants, so publishing again continues it
  external_target_item_id text,
  publishing_started_at   timestamptz,
  published_at            timestamptz,
  published_by            ulid,
  error                   text,
  CONSTRAINT listing_draft_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT listing_draft_copy_fk FOREIGN KEY (tenant_id, copy_id) REFERENCES listing_copy (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT listing_draft_source_store_fk FOREIGN KEY (tenant_id, source_store_id)
    REFERENCES store (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT listing_draft_target_store_fk FOREIGN KEY (tenant_id, target_store_id)
    REFERENCES store (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT listing_draft_published_by_fk FOREIGN KEY (tenant_id, published_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (published_by),
  CONSTRAINT listing_draft_published_ck CHECK (
    (status = 'published') = (published_at IS NOT NULL)
    AND (status <> 'published' OR external_target_item_id IS NOT NULL))
);
CREATE INDEX listing_draft_tenant_copy_idx ON listing_draft (tenant_id, copy_id, id);
CREATE INDEX listing_draft_tenant_target_idx ON listing_draft (tenant_id, target_store_id, id DESC);
CREATE INDEX listing_draft_tenant_id_idx ON listing_draft (tenant_id, id DESC);
-- Copying again skips items whose draft still waits; a published item may be copied again on purpose.
CREATE UNIQUE INDEX listing_draft_open_uq ON listing_draft (tenant_id, target_store_id, source_store_id, external_source_item_id)
  WHERE status <> 'published';

------------------------------------------------------------------------------------------------
-- Listings created by a copy are mapped to the source's variants as `copied`
------------------------------------------------------------------------------------------------

ALTER TABLE channel_listing DROP CONSTRAINT channel_listing_mapping_source_check;
ALTER TABLE channel_listing ADD CONSTRAINT channel_listing_mapping_source_check
  CHECK (mapping_source IN ('auto_sku', 'manual', 'created', 'copied'));
