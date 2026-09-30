-- 0001_core: MVP-1 core schema (backend doc section 7.8.1 to 7.8.8, 7.8.12 subset).
-- Conventions (backend doc 7.1 to 7.7):
--   * every tenant table: id ulid PK, tenant_id NOT NULL, created_at, updated_at, row_version
--   * every FK to a tenant table is composite (tenant_id, x_id) -> parent (tenant_id, id)
--   * ON DELETE SET NULL on a composite FK always names the column: SET NULL (x_id),
--     otherwise PostgreSQL would also null tenant_id (NOT NULL) and the delete fails
--   * functions, triggers, RLS policies, grants, and seeds live in drizzle/sql (repeatable, run after this)

CREATE EXTENSION IF NOT EXISTS citext;

-- ULID: 26 chars Crockford base32. text + COLLATE "C" so byte order equals time order and
-- comparisons against current_setting() (text) stay index-friendly.
CREATE DOMAIN ulid AS text COLLATE "C" CHECK (VALUE ~ '^[0-9A-HJKMNP-TV-Z]{26}$');

------------------------------------------------------------------------------------------------
-- Global tables (no tenant_id)
------------------------------------------------------------------------------------------------

CREATE TABLE plan (
  id            ulid PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  limits        jsonb NOT NULL DEFAULT '{}',
  features      text[] NOT NULL DEFAULT '{}',
  price_monthly bigint NOT NULL DEFAULT 0 CHECK (price_monthly >= 0),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 1
);

CREATE TABLE tenant (
  id          ulid PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,40}$'),
  timezone    text NOT NULL DEFAULT 'Asia/Jakarta',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closing', 'closed')),
  plan_id     ulid NOT NULL REFERENCES plan (id) ON DELETE RESTRICT,
  legal       jsonb NOT NULL DEFAULT '{}',
  settings    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1
);

CREATE TABLE permission (
  id          ulid PRIMARY KEY,
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z_]+:[a-z_]+$'),
  module      text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feature_flag (
  id              ulid PRIMARY KEY,
  key             text NOT NULL UNIQUE,
  description     text,
  enabled_default boolean NOT NULL DEFAULT false,
  rollout_pct     smallint NOT NULL DEFAULT 0 CHECK (rollout_pct BETWEEN 0 AND 100),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1
);

-- Status transition tables (backend doc 7.9). via = 'marketplace' rows are only allowed when the
-- transaction declares app.status_source = 'marketplace' (a fact reported by the marketplace).
CREATE TABLE order_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE shipment_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE sync_job_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

-- Webhook inbox: global, written before the tenant is known (backend doc 7.8.8).
CREATE TABLE webhook_inbox (
  id               ulid PRIMARY KEY,
  source           text NOT NULL CHECK (source IN ('shopee', 'tiktokshop', 'lazada', 'blibli', 'shopify', 'woocommerce', 'xendit')),
  event_id         text NOT NULL,
  event_type       text,
  external_shop_id text,
  tenant_id        ulid,
  store_id         ulid,
  received_at      timestamptz NOT NULL DEFAULT now(),
  signature_valid  boolean NOT NULL,
  headers          jsonb NOT NULL,
  payload          jsonb NOT NULL,
  processed_at     timestamptz,
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  CONSTRAINT webhook_inbox_source_event_uq UNIQUE (source, event_id)
);
CREATE INDEX webhook_inbox_unprocessed_idx ON webhook_inbox (id) WHERE processed_at IS NULL;
CREATE INDEX webhook_inbox_received_idx ON webhook_inbox (received_at);

------------------------------------------------------------------------------------------------
-- Files
------------------------------------------------------------------------------------------------

CREATE TABLE file_object (
  id          ulid PRIMARY KEY,
  tenant_id   ulid REFERENCES tenant (id) ON DELETE RESTRICT, -- NULL for system files
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  bucket      text NOT NULL,
  object_key  text NOT NULL,
  mime        text NOT NULL,
  size_bytes  bigint NOT NULL CHECK (size_bytes > 0),
  sha256      text,
  purpose     text NOT NULL CHECK (purpose IN ('product_image', 'label', 'pick_list', 'export', 'import', 'settlement', 'tax_document', 'evidence', 'other')),
  expires_at  timestamptz,
  created_by  ulid,
  CONSTRAINT file_object_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT file_object_bucket_key_uq UNIQUE (bucket, object_key)
);
CREATE INDEX file_object_expires_idx ON file_object (expires_at) WHERE expires_at IS NOT NULL;

------------------------------------------------------------------------------------------------
-- Identity and access (7.8.1)
------------------------------------------------------------------------------------------------

CREATE TABLE "user" (
  id                 ulid PRIMARY KEY,
  tenant_id          ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  row_version        integer NOT NULL DEFAULT 1,
  email              citext NOT NULL,
  password_hash      text NOT NULL,
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  totp_secret_enc    bytea,
  totp_enabled       boolean NOT NULL DEFAULT false,
  locale             text NOT NULL DEFAULT 'id' CHECK (locale IN ('id', 'en')),
  last_login_at      timestamptz,
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until       timestamptz,
  CONSTRAINT user_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT user_tenant_email_uq UNIQUE (tenant_id, email)
);
CREATE INDEX user_email_idx ON "user" (email);

CREATE TABLE role (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  description text,
  CONSTRAINT role_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT role_tenant_name_uq UNIQUE (tenant_id, name)
);

CREATE TABLE role_permission (
  id            ulid PRIMARY KEY,
  tenant_id     ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 1,
  role_id       ulid NOT NULL,
  permission_id ulid NOT NULL REFERENCES permission (id) ON DELETE RESTRICT,
  CONSTRAINT role_permission_role_fk FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT role_permission_uq UNIQUE (role_id, permission_id)
);
CREATE INDEX role_permission_tenant_role_idx ON role_permission (tenant_id, role_id);

-- warehouse is created before tables that reference it
CREATE TABLE warehouse (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,20}$'),
  name        text NOT NULL,
  address     jsonb NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  deleted_at  timestamptz,
  CONSTRAINT warehouse_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT warehouse_tenant_code_uq UNIQUE (tenant_id, code)
);
CREATE UNIQUE INDEX warehouse_one_default_uq ON warehouse (tenant_id) WHERE is_default AND deleted_at IS NULL;

CREATE TABLE user_role (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  user_id     ulid NOT NULL,
  role_id     ulid NOT NULL,
  CONSTRAINT user_role_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES "user" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT user_role_role_fk FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT user_role_uq UNIQUE (user_id, role_id)
);
CREATE INDEX user_role_tenant_user_idx ON user_role (tenant_id, user_id);
CREATE INDEX user_role_tenant_role_idx ON user_role (tenant_id, role_id);

CREATE TABLE user_warehouse_scope (
  id           ulid PRIMARY KEY,
  tenant_id    ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  integer NOT NULL DEFAULT 1,
  user_id      ulid NOT NULL,
  warehouse_id ulid NOT NULL,
  CONSTRAINT user_warehouse_scope_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES "user" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT user_warehouse_scope_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT user_warehouse_scope_uq UNIQUE (user_id, warehouse_id)
);
CREATE INDEX user_warehouse_scope_tenant_user_idx ON user_warehouse_scope (tenant_id, user_id);

CREATE TABLE device (
  id           ulid PRIMARY KEY,
  tenant_id    ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  integer NOT NULL DEFAULT 1,
  kind         text NOT NULL CHECK (kind IN ('print_agent', 'mobile')),
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  warehouse_id ulid,
  app_version  text,
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  CONSTRAINT device_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT device_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE SET NULL (warehouse_id)
);
CREATE INDEX device_tenant_kind_idx ON device (tenant_id, kind);

CREATE TABLE refresh_token (
  id              ulid PRIMARY KEY,
  tenant_id       ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  user_id         ulid NOT NULL,
  device_id       ulid,
  token_hash      text NOT NULL UNIQUE,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  rotated_from_id ulid,
  user_agent      text,
  ip              inet,
  CONSTRAINT refresh_token_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT refresh_token_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES "user" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT refresh_token_device_fk FOREIGN KEY (tenant_id, device_id) REFERENCES device (tenant_id, id) ON DELETE SET NULL (device_id),
  CONSTRAINT refresh_token_rotated_from_fk FOREIGN KEY (tenant_id, rotated_from_id) REFERENCES refresh_token (tenant_id, id) ON DELETE SET NULL (rotated_from_id)
);
CREATE INDEX refresh_token_tenant_user_idx ON refresh_token (tenant_id, user_id);

CREATE TABLE invitation (
  id               ulid PRIMARY KEY,
  tenant_id        ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  row_version      integer NOT NULL DEFAULT 1,
  email            citext NOT NULL,
  role_id          ulid NOT NULL,
  invited_by       ulid,
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  accepted_user_id ulid,
  CONSTRAINT invitation_role_fk FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT invitation_invited_by_fk FOREIGN KEY (tenant_id, invited_by) REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (invited_by),
  CONSTRAINT invitation_accepted_user_fk FOREIGN KEY (tenant_id, accepted_user_id) REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (accepted_user_id)
);
CREATE INDEX invitation_tenant_email_idx ON invitation (tenant_id, email);

CREATE TABLE api_key (
  id           ulid PRIMARY KEY,
  tenant_id    ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  integer NOT NULL DEFAULT 1,
  name         text NOT NULL,
  prefix       text NOT NULL CHECK (length(prefix) = 8),
  key_hash     text NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_by   ulid,
  CONSTRAINT api_key_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX api_key_tenant_idx ON api_key (tenant_id);

------------------------------------------------------------------------------------------------
-- Channel and store (7.8.2)
------------------------------------------------------------------------------------------------

CREATE TABLE store (
  id                   ulid PRIMARY KEY,
  tenant_id            ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  row_version          integer NOT NULL DEFAULT 1,
  channel              text NOT NULL CHECK (channel IN ('shopee', 'tiktokshop', 'lazada', 'blibli', 'shopify', 'woocommerce', 'manual')),
  external_shop_id     text NOT NULL,
  name                 text NOT NULL,
  region               text NOT NULL DEFAULT 'ID',
  status               text NOT NULL DEFAULT 'connecting' CHECK (status IN ('connecting', 'active', 'token_expiring', 'reauth_required', 'disconnected')),
  sync_mode            text NOT NULL DEFAULT 'read_only' CHECK (sync_mode IN ('read_only', 'live')),
  default_warehouse_id ulid,
  connected_at         timestamptz,
  disconnected_at      timestamptz,
  last_order_sync_at   timestamptz,
  last_product_sync_at timestamptz,
  settings             jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT store_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- global across tenants: one marketplace shop can never be connected to two tenants
  CONSTRAINT store_channel_external_shop_uq UNIQUE (channel, external_shop_id),
  CONSTRAINT store_default_warehouse_fk FOREIGN KEY (tenant_id, default_warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE SET NULL (default_warehouse_id)
);
CREATE INDEX store_tenant_status_idx ON store (tenant_id, status);

CREATE TABLE user_store_scope (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  user_id     ulid NOT NULL,
  store_id    ulid NOT NULL,
  CONSTRAINT user_store_scope_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES "user" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT user_store_scope_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT user_store_scope_uq UNIQUE (user_id, store_id)
);
CREATE INDEX user_store_scope_tenant_user_idx ON user_store_scope (tenant_id, user_id);

CREATE TABLE store_credential (
  id                 ulid PRIMARY KEY,
  tenant_id          ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  row_version        integer NOT NULL DEFAULT 1,
  store_id           ulid NOT NULL UNIQUE,
  -- AES-256-GCM with the tenant DEK: version(1) + nonce(12) + ciphertext + tag(16)
  access_token_enc   bytea NOT NULL,
  refresh_token_enc  bytea,
  dek_version        integer NOT NULL,
  access_expires_at  timestamptz,
  refresh_expires_at timestamptz,
  scopes             text[] NOT NULL DEFAULT '{}',
  last_refreshed_at  timestamptz,
  refresh_fail_count integer NOT NULL DEFAULT 0 CHECK (refresh_fail_count >= 0),
  CONSTRAINT store_credential_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX store_credential_access_expiry_idx ON store_credential (access_expires_at);

CREATE TABLE channel_warehouse (
  id                    ulid PRIMARY KEY,
  tenant_id             ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  row_version           integer NOT NULL DEFAULT 1,
  store_id              ulid NOT NULL,
  external_warehouse_id text NOT NULL,
  name                  text NOT NULL,
  address               jsonb,
  kind                  text NOT NULL CHECK (kind IN ('seller', 'fulfillment')),
  warehouse_id          ulid,
  mapping_status        text NOT NULL DEFAULT 'unmapped' CHECK (mapping_status IN ('unmapped', 'mapped', 'marketplace_managed')),
  is_default            boolean NOT NULL DEFAULT false,
  active                boolean NOT NULL DEFAULT true,
  last_seen_at          timestamptz NOT NULL,
  CONSTRAINT channel_warehouse_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT channel_warehouse_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id) ON DELETE CASCADE,
  -- RESTRICT, not SET NULL: a mapped warehouse must be unmapped explicitly first (mapping_status and
  -- warehouse_id change together under the CHECK below), so stock sync never silently loses its target.
  CONSTRAINT channel_warehouse_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT channel_warehouse_external_uq UNIQUE (store_id, external_warehouse_id),
  CONSTRAINT channel_warehouse_mapping_ck CHECK (
    (kind = 'fulfillment' AND warehouse_id IS NULL AND mapping_status = 'marketplace_managed')
    OR (kind = 'seller' AND mapping_status <> 'marketplace_managed' AND (mapping_status = 'unmapped') = (warehouse_id IS NULL))
  )
);
CREATE INDEX channel_warehouse_tenant_warehouse_idx ON channel_warehouse (tenant_id, warehouse_id);
CREATE INDEX channel_warehouse_tenant_store_idx ON channel_warehouse (tenant_id, store_id);

CREATE TABLE sync_cursor (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  store_id    ulid NOT NULL,
  resource    text NOT NULL,
  cursor      text NOT NULL,
  advanced_at timestamptz NOT NULL,
  CONSTRAINT sync_cursor_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT sync_cursor_uq UNIQUE (store_id, resource)
);

------------------------------------------------------------------------------------------------
-- Catalog (7.8.3)
------------------------------------------------------------------------------------------------

CREATE TABLE product (
  id              ulid PRIMARY KEY,
  tenant_id       ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  name            text NOT NULL,
  sku             text NOT NULL,
  description     text,
  brand           text,
  category_path   text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  attribute_names text[] NOT NULL DEFAULT '{}',
  deleted_at      timestamptz,
  CONSTRAINT product_tenant_id_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX product_tenant_sku_uq ON product (tenant_id, sku) WHERE deleted_at IS NULL;

CREATE TABLE variant (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  product_id  ulid NOT NULL,
  sku         text NOT NULL,
  barcode     text,
  name        text NOT NULL,
  attributes  jsonb NOT NULL DEFAULT '{}',
  cost_price  bigint NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  base_price  bigint NOT NULL CHECK (base_price >= 0),
  weight_g    integer NOT NULL CHECK (weight_g > 0),
  length_mm   integer CHECK (length_mm > 0),
  width_mm    integer CHECK (width_mm > 0),
  height_mm   integer CHECK (height_mm > 0),
  is_bundle   boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  deleted_at  timestamptz,
  CONSTRAINT variant_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT variant_product_fk FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX variant_tenant_sku_uq ON variant (tenant_id, sku) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX variant_tenant_barcode_uq ON variant (tenant_id, barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX variant_tenant_product_idx ON variant (tenant_id, product_id);

CREATE TABLE product_image (
  id             ulid PRIMARY KEY,
  tenant_id      ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  row_version    integer NOT NULL DEFAULT 1,
  product_id     ulid NOT NULL,
  variant_id     ulid, -- NULL: image of the product itself
  file_object_id ulid NOT NULL,
  position       smallint NOT NULL CHECK (position >= 0),
  CONSTRAINT product_image_product_fk FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT product_image_variant_fk FOREIGN KEY (tenant_id, variant_id) REFERENCES variant (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT product_image_file_fk FOREIGN KEY (tenant_id, file_object_id) REFERENCES file_object (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT product_image_position_uq UNIQUE NULLS NOT DISTINCT (product_id, variant_id, position)
);
CREATE INDEX product_image_tenant_product_idx ON product_image (tenant_id, product_id);

CREATE TABLE bundle_component (
  id                   ulid PRIMARY KEY,
  tenant_id            ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  row_version          integer NOT NULL DEFAULT 1,
  bundle_variant_id    ulid NOT NULL,
  component_variant_id ulid NOT NULL,
  qty                  integer NOT NULL CHECK (qty > 0),
  CONSTRAINT bundle_component_bundle_fk FOREIGN KEY (tenant_id, bundle_variant_id) REFERENCES variant (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT bundle_component_component_fk FOREIGN KEY (tenant_id, component_variant_id) REFERENCES variant (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT bundle_component_uq UNIQUE (bundle_variant_id, component_variant_id),
  CONSTRAINT bundle_component_not_self_ck CHECK (bundle_variant_id <> component_variant_id)
);
CREATE INDEX bundle_component_tenant_component_idx ON bundle_component (tenant_id, component_variant_id);

CREATE TABLE channel_listing (
  id                  ulid PRIMARY KEY,
  tenant_id           ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  row_version         integer NOT NULL DEFAULT 1,
  store_id            ulid NOT NULL,
  external_item_id    text NOT NULL,
  external_variant_id text NOT NULL DEFAULT '',
  external_sku        text,
  variant_id          ulid, -- NULL: not mapped yet
  title               text NOT NULL,
  price               bigint CHECK (price >= 0),
  original_price      bigint CHECK (original_price >= 0),
  status              text NOT NULL DEFAULT 'unknown' CHECK (status IN ('active', 'inactive', 'banned', 'deleted', 'unknown')),
  stock_at_channel    bigint,
  link_fields         jsonb NOT NULL DEFAULT '{"title":false,"description":false,"price":true,"images":false,"weight":true}',
  overrides           jsonb NOT NULL DEFAULT '{}',
  channel_data        jsonb NOT NULL DEFAULT '{}',
  last_pulled_at      timestamptz,
  CONSTRAINT channel_listing_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT channel_listing_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT channel_listing_variant_fk FOREIGN KEY (tenant_id, variant_id) REFERENCES variant (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT channel_listing_external_uq UNIQUE (store_id, external_item_id, external_variant_id)
);
CREATE INDEX channel_listing_tenant_variant_idx ON channel_listing (tenant_id, variant_id);
CREATE INDEX channel_listing_tenant_store_status_idx ON channel_listing (tenant_id, store_id, status);
CREATE INDEX channel_listing_unmapped_idx ON channel_listing (tenant_id, store_id) WHERE variant_id IS NULL;

CREATE TABLE listing_stock_state (
  id                   ulid PRIMARY KEY,
  tenant_id            ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  row_version          integer NOT NULL DEFAULT 1,
  listing_id           ulid NOT NULL,
  channel_warehouse_id ulid NOT NULL,
  last_pushed_qty      bigint,
  last_pushed_at       timestamptz,
  last_error           text,
  push_fail_count      integer NOT NULL DEFAULT 0 CHECK (push_fail_count >= 0),
  CONSTRAINT listing_stock_state_listing_fk FOREIGN KEY (tenant_id, listing_id) REFERENCES channel_listing (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT listing_stock_state_channel_warehouse_fk FOREIGN KEY (tenant_id, channel_warehouse_id) REFERENCES channel_warehouse (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT listing_stock_state_uq UNIQUE (listing_id, channel_warehouse_id)
);
CREATE INDEX listing_stock_state_tenant_cw_idx ON listing_stock_state (tenant_id, channel_warehouse_id);

------------------------------------------------------------------------------------------------
-- Inventory (7.8.4)
------------------------------------------------------------------------------------------------

CREATE TABLE inventory (
  id           ulid PRIMARY KEY,
  tenant_id    ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  integer NOT NULL DEFAULT 1,
  variant_id   ulid NOT NULL,
  warehouse_id ulid NOT NULL,
  on_hand      bigint NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved     bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  buffer       bigint NOT NULL DEFAULT 0 CHECK (buffer >= 0),
  damaged      bigint NOT NULL DEFAULT 0 CHECK (damaged >= 0),
  -- may go negative: that is the overselling signal; stock push always sends GREATEST(available, 0)
  available    bigint GENERATED ALWAYS AS (on_hand - reserved - buffer) STORED,
  bin_location text,
  min_stock    bigint CHECK (min_stock >= 0),
  CONSTRAINT inventory_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT inventory_variant_fk FOREIGN KEY (tenant_id, variant_id) REFERENCES variant (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_variant_warehouse_uq UNIQUE (tenant_id, variant_id, warehouse_id)
);
CREATE INDEX inventory_tenant_warehouse_idx ON inventory (tenant_id, warehouse_id);

-- Ledger: append only, partitioned monthly on id (7.6). No updated_at / row_version.
CREATE TABLE stock_movement (
  id             ulid NOT NULL,
  tenant_id      ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  variant_id     ulid NOT NULL,
  warehouse_id   ulid NOT NULL,
  type           text NOT NULL CHECK (type IN ('order_reserve', 'order_release', 'order_ship', 'return_restock', 'return_quarantine', 'adjustment', 'count_apply', 'transfer_out', 'transfer_in', 'purchase_receipt', 'quarantine_in', 'quarantine_out', 'campaign_hold', 'campaign_release', 'migration_initial')),
  on_hand_delta  bigint NOT NULL DEFAULT 0,
  reserved_delta bigint NOT NULL DEFAULT 0,
  damaged_delta  bigint NOT NULL DEFAULT 0,
  buffer_delta   bigint NOT NULL DEFAULT 0,
  on_hand_after  bigint NOT NULL,
  reserved_after bigint NOT NULL,
  damaged_after  bigint NOT NULL,
  buffer_after   bigint NOT NULL,
  reference_type text CHECK (reference_type IN ('order_item', 'return_item', 'stock_count_line', 'stock_transfer_line', 'goods_receipt_line', 'campaign_stock_hold', 'migration_job', 'manual')),
  reference_id   ulid,
  reason         text,
  note           text,
  actor_user_id  ulid,
  CONSTRAINT stock_movement_pk PRIMARY KEY (id),
  CONSTRAINT stock_movement_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT stock_movement_variant_fk FOREIGN KEY (tenant_id, variant_id) REFERENCES variant (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_movement_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_movement_nonzero_ck CHECK (on_hand_delta <> 0 OR reserved_delta <> 0 OR damaged_delta <> 0 OR buffer_delta <> 0),
  CONSTRAINT stock_movement_reference_ck CHECK ((reference_type IS NULL) = (reference_id IS NULL) OR reference_type = 'manual')
) PARTITION BY RANGE (id);
CREATE TABLE stock_movement_pdefault PARTITION OF stock_movement DEFAULT;
CREATE INDEX stock_movement_card_idx ON stock_movement (tenant_id, variant_id, warehouse_id, id DESC);
CREATE INDEX stock_movement_reference_idx ON stock_movement (tenant_id, reference_type, reference_id);

CREATE TABLE stock_allocation_rule (
  id                   ulid PRIMARY KEY,
  tenant_id            ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  row_version          integer NOT NULL DEFAULT 1,
  store_id             ulid NOT NULL,
  channel_warehouse_id ulid, -- NULL: every marketplace warehouse of the store
  variant_id           ulid, -- NULL: every variant
  mode                 text NOT NULL CHECK (mode IN ('all', 'percent', 'fixed')),
  value                bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  buffer               bigint NOT NULL DEFAULT 0 CHECK (buffer >= 0),
  priority             integer NOT NULL DEFAULT 100,
  active               boolean NOT NULL DEFAULT true,
  CONSTRAINT stock_allocation_rule_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT stock_allocation_rule_cw_fk FOREIGN KEY (tenant_id, channel_warehouse_id) REFERENCES channel_warehouse (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT stock_allocation_rule_variant_fk FOREIGN KEY (tenant_id, variant_id) REFERENCES variant (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT stock_allocation_rule_uq UNIQUE NULLS NOT DISTINCT (store_id, channel_warehouse_id, variant_id),
  CONSTRAINT stock_allocation_rule_percent_ck CHECK (mode <> 'percent' OR value <= 100)
);
CREATE INDEX stock_allocation_rule_tenant_store_idx ON stock_allocation_rule (tenant_id, store_id);

------------------------------------------------------------------------------------------------
-- Customers (7.8.10 subset; order.customer_id refers to it)
------------------------------------------------------------------------------------------------

CREATE TABLE customer (
  id                ulid PRIMARY KEY,
  tenant_id         ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  channel           text NOT NULL,
  external_buyer_id text NOT NULL,
  display_name      text,
  phone_masked      text,
  total_orders      integer NOT NULL DEFAULT 0 CHECK (total_orders >= 0),
  total_spent       bigint NOT NULL DEFAULT 0 CHECK (total_spent >= 0),
  first_order_at    timestamptz,
  last_order_at     timestamptz,
  watchlist         boolean NOT NULL DEFAULT false,
  watchlist_reason  text,
  watchlist_until   timestamptz,
  deleted_at        timestamptz,
  CONSTRAINT customer_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT customer_external_uq UNIQUE (tenant_id, channel, external_buyer_id),
  CONSTRAINT customer_watchlist_until_ck CHECK (watchlist = false OR watchlist_until IS NOT NULL)
);

------------------------------------------------------------------------------------------------
-- Orders (7.8.6)
------------------------------------------------------------------------------------------------

CREATE TABLE tag (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  name        text NOT NULL,
  color       text,
  deleted_at  timestamptz,
  CONSTRAINT tag_tenant_id_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX tag_tenant_name_uq ON tag (tenant_id, name) WHERE deleted_at IS NULL;

CREATE TABLE pick_wave (
  id           ulid PRIMARY KEY,
  tenant_id    ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  integer NOT NULL DEFAULT 1,
  warehouse_id ulid NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'picking', 'done', 'cancelled')),
  created_by   ulid,
  order_count  integer NOT NULL DEFAULT 0 CHECK (order_count >= 0),
  note         text,
  CONSTRAINT pick_wave_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT pick_wave_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT pick_wave_created_by_fk FOREIGN KEY (tenant_id, created_by) REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX pick_wave_tenant_warehouse_status_idx ON pick_wave (tenant_id, warehouse_id, status);

-- Partitioned monthly on id. The business key (store, external order id) is enforced by
-- order_external_ref, because a partitioned table's unique constraints must include id.
CREATE TABLE "order" (
  id                    ulid NOT NULL,
  tenant_id             ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  row_version           integer NOT NULL DEFAULT 1,
  store_id              ulid NOT NULL,
  channel               text NOT NULL,
  external_order_id     text NOT NULL,
  external_status       text,
  status                text NOT NULL CHECK (status IN ('unpaid', 'new', 'problem', 'ready_to_pack', 'packed', 'ready_to_ship', 'shipped', 'delivered', 'completed', 'return_in_progress', 'returned', 'marketplace_fulfilled', 'cancelled')),
  status_changed_at     timestamptz NOT NULL DEFAULT now(),
  fulfillment_mode      text NOT NULL DEFAULT 'seller' CHECK (fulfillment_mode IN ('seller', 'marketplace')),
  channel_warehouse_id  ulid,
  warehouse_id          ulid,
  pick_wave_id          ulid,
  customer_id           ulid,
  is_cod                boolean NOT NULL DEFAULT false,
  is_dropship           boolean NOT NULL DEFAULT false,
  dropship_sender       jsonb,
  buyer_username        text,
  buyer_name            text,
  buyer_phone           text,
  shipping_address      jsonb,
  shipping_provider     text,
  shipping_service      text,
  shipping_service_type text CHECK (shipping_service_type IN ('regular', 'next_day', 'same_day', 'instant')),
  tracking_number       text,
  ship_by_at            timestamptz,
  internal_ship_by_at   timestamptz,
  ordered_at            timestamptz NOT NULL,
  paid_at               timestamptz,
  shipped_at            timestamptz,
  delivered_at          timestamptz,
  completed_at          timestamptz,
  cancelled_at          timestamptz,
  cancel_reason         text,
  cancelled_by          text CHECK (cancelled_by IN ('buyer', 'seller', 'marketplace', 'system')),
  subtotal              bigint NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total        bigint NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  shipping_fee_buyer    bigint NOT NULL DEFAULT 0 CHECK (shipping_fee_buyer >= 0),
  voucher_seller        bigint NOT NULL DEFAULT 0 CHECK (voucher_seller >= 0),
  total                 bigint NOT NULL CHECK (total >= 0),
  currency              char(3) NOT NULL DEFAULT 'IDR',
  buyer_note            text,
  internal_note         text,
  source                text NOT NULL CHECK (source IN ('webhook', 'poll', 'manual', 'link', 'distribution', 'migration')),
  risk_score            smallint CHECK (risk_score BETWEEN 0 AND 100),
  problem_count         integer NOT NULL DEFAULT 0 CHECK (problem_count >= 0),
  raw_payload_ref       text,
  CONSTRAINT order_pk PRIMARY KEY (id),
  CONSTRAINT order_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT order_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT order_channel_warehouse_fk FOREIGN KEY (tenant_id, channel_warehouse_id) REFERENCES channel_warehouse (tenant_id, id) ON DELETE SET NULL (channel_warehouse_id),
  CONSTRAINT order_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE SET NULL (warehouse_id),
  CONSTRAINT order_pick_wave_fk FOREIGN KEY (tenant_id, pick_wave_id) REFERENCES pick_wave (tenant_id, id) ON DELETE SET NULL (pick_wave_id),
  CONSTRAINT order_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customer (tenant_id, id) ON DELETE SET NULL (customer_id)
) PARTITION BY RANGE (id);
CREATE TABLE order_pdefault PARTITION OF "order" DEFAULT;
CREATE INDEX order_tenant_status_ship_by_idx ON "order" (tenant_id, status, ship_by_at);
CREATE INDEX order_tenant_store_ordered_idx ON "order" (tenant_id, store_id, ordered_at DESC);
CREATE INDEX order_tenant_tracking_idx ON "order" (tenant_id, tracking_number);
CREATE INDEX order_tenant_warehouse_status_idx ON "order" (tenant_id, warehouse_id, status);
CREATE INDEX order_tenant_customer_idx ON "order" (tenant_id, customer_id);

CREATE TABLE order_external_ref (
  id                ulid PRIMARY KEY,
  tenant_id         ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  store_id          ulid NOT NULL,
  external_order_id text NOT NULL,
  order_id          ulid NOT NULL,
  CONSTRAINT order_external_ref_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT order_external_ref_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT order_external_ref_uq UNIQUE (store_id, external_order_id),
  CONSTRAINT order_external_ref_order_uq UNIQUE (order_id)
);

CREATE TABLE order_item (
  id                ulid NOT NULL,
  tenant_id         ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  order_id          ulid NOT NULL,
  external_item_id  text NOT NULL,
  listing_id        ulid,
  variant_id        ulid, -- NULL: SKU not mapped, order is a problem and never touches stock
  sku_snapshot      text NOT NULL,
  title_snapshot    text NOT NULL,
  variant_snapshot  jsonb NOT NULL DEFAULT '{}',
  qty               integer NOT NULL CHECK (qty > 0),
  unit_price        bigint NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  discount          bigint NOT NULL DEFAULT 0 CHECK (discount >= 0),
  line_total        bigint NOT NULL DEFAULT 0 CHECK (line_total >= 0),
  warehouse_id      ulid,
  reserved_qty      integer NOT NULL DEFAULT 0 CHECK (reserved_qty BETWEEN 0 AND qty),
  shipped_qty       integer NOT NULL DEFAULT 0 CHECK (shipped_qty BETWEEN 0 AND qty),
  returned_qty      integer NOT NULL DEFAULT 0 CHECK (returned_qty BETWEEN 0 AND shipped_qty),
  CONSTRAINT order_item_pk PRIMARY KEY (id),
  CONSTRAINT order_item_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT order_item_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT order_item_listing_fk FOREIGN KEY (tenant_id, listing_id) REFERENCES channel_listing (tenant_id, id) ON DELETE SET NULL (listing_id),
  CONSTRAINT order_item_variant_fk FOREIGN KEY (tenant_id, variant_id) REFERENCES variant (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT order_item_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE SET NULL (warehouse_id)
) PARTITION BY RANGE (id);
CREATE TABLE order_item_pdefault PARTITION OF order_item DEFAULT;
CREATE INDEX order_item_order_external_idx ON order_item (order_id, external_item_id);
CREATE INDEX order_item_tenant_variant_idx ON order_item (tenant_id, variant_id, id DESC);

CREATE TABLE order_event (
  id          ulid NOT NULL,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  order_id    ulid NOT NULL,
  type        text NOT NULL,
  from_status text,
  to_status   text,
  actor_type  text NOT NULL CHECK (actor_type IN ('user', 'system', 'marketplace', 'device', 'api_key')),
  actor_id    ulid,
  payload     jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT order_event_pk PRIMARY KEY (id),
  CONSTRAINT order_event_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id) ON DELETE CASCADE
) PARTITION BY RANGE (id);
CREATE TABLE order_event_pdefault PARTITION OF order_event DEFAULT;
CREATE INDEX order_event_order_idx ON order_event (order_id, id);

CREATE TABLE order_problem (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  order_id    ulid NOT NULL,
  code        text NOT NULL CHECK (code IN ('unmapped_sku', 'insufficient_stock', 'unmapped_warehouse', 'address_incomplete', 'duplicate', 'watchlist', 'high_value', 'fulfillment_conflict')),
  detail      jsonb,
  resolved_at timestamptz,
  resolved_by ulid,
  resolution  text,
  CONSTRAINT order_problem_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT order_problem_resolved_by_fk FOREIGN KEY (tenant_id, resolved_by) REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (resolved_by)
);
CREATE UNIQUE INDEX order_problem_open_uq ON order_problem (order_id, code) WHERE resolved_at IS NULL;
CREATE INDEX order_problem_tenant_open_idx ON order_problem (tenant_id, code) WHERE resolved_at IS NULL;

CREATE TABLE order_tag (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  order_id    ulid NOT NULL,
  tag_id      ulid NOT NULL,
  CONSTRAINT order_tag_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT order_tag_tag_fk FOREIGN KEY (tenant_id, tag_id) REFERENCES tag (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT order_tag_uq UNIQUE (order_id, tag_id)
);
CREATE INDEX order_tag_tenant_tag_idx ON order_tag (tenant_id, tag_id);

------------------------------------------------------------------------------------------------
-- Fulfillment (7.8.6)
------------------------------------------------------------------------------------------------

CREATE TABLE shipment (
  id                    ulid PRIMARY KEY,
  tenant_id             ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  row_version           integer NOT NULL DEFAULT 1,
  order_id              ulid NOT NULL,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'arranged', 'label_ready', 'packed', 'handed_over', 'in_transit', 'delivered', 'failed', 'rto_in_transit', 'rto_received', 'cancelled')),
  status_changed_at     timestamptz NOT NULL DEFAULT now(),
  provider              text,
  service               text,
  external_shipment_id  text,
  tracking_number       text,
  label_file_id         ulid,
  pickup_type           text CHECK (pickup_type IN ('pickup', 'dropoff')),
  pickup_at             timestamptz,
  packed_at             timestamptz,
  handed_over_at        timestamptz,
  delivered_at          timestamptz,
  failed_at             timestamptz,
  rto_at                timestamptz,
  rto_received_at       timestamptz,
  packed_by             ulid,
  handed_over_by        ulid,
  failed_reason         text,
  insured               boolean NOT NULL DEFAULT false,
  insured_value         bigint CHECK (insured_value >= 0),
  shipping_cost_actual  bigint CHECK (shipping_cost_actual >= 0),
  weight_g              integer CHECK (weight_g > 0),
  dims                  jsonb,
  package_count         integer NOT NULL DEFAULT 1 CHECK (package_count > 0),
  CONSTRAINT shipment_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT shipment_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT shipment_label_file_fk FOREIGN KEY (tenant_id, label_file_id) REFERENCES file_object (tenant_id, id) ON DELETE SET NULL (label_file_id),
  CONSTRAINT shipment_packed_by_fk FOREIGN KEY (tenant_id, packed_by) REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (packed_by),
  CONSTRAINT shipment_handed_over_by_fk FOREIGN KEY (tenant_id, handed_over_by) REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (handed_over_by)
);
CREATE INDEX shipment_tenant_order_idx ON shipment (tenant_id, order_id);
CREATE INDEX shipment_tenant_tracking_idx ON shipment (tenant_id, tracking_number);
CREATE INDEX shipment_tenant_status_idx ON shipment (tenant_id, status);

CREATE TABLE shipment_package (
  id                  ulid PRIMARY KEY,
  tenant_id           ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  row_version         integer NOT NULL DEFAULT 1,
  shipment_id         ulid NOT NULL,
  external_package_id text,
  tracking_number     text,
  items               jsonb NOT NULL, -- [{order_item_id, qty}]
  label_file_id       ulid,
  CONSTRAINT shipment_package_shipment_fk FOREIGN KEY (tenant_id, shipment_id) REFERENCES shipment (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT shipment_package_label_file_fk FOREIGN KEY (tenant_id, label_file_id) REFERENCES file_object (tenant_id, id) ON DELETE SET NULL (label_file_id)
);
CREATE UNIQUE INDEX shipment_package_external_uq ON shipment_package (shipment_id, external_package_id) WHERE external_package_id IS NOT NULL;
CREATE INDEX shipment_package_tenant_shipment_idx ON shipment_package (tenant_id, shipment_id);

CREATE TABLE print_job (
  id             ulid PRIMARY KEY,
  tenant_id      ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  row_version    integer NOT NULL DEFAULT 1,
  device_id      ulid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('label', 'pick_list', 'packing_list', 'invoice', 'barcode', 'manifest')),
  file_object_id ulid NOT NULL,
  printer_name   text,
  copies         smallint NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 10),
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'printed', 'failed', 'cancelled')),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error          text,
  requested_by   ulid,
  printed_at     timestamptz,
  CONSTRAINT print_job_device_fk FOREIGN KEY (tenant_id, device_id) REFERENCES device (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT print_job_file_fk FOREIGN KEY (tenant_id, file_object_id) REFERENCES file_object (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT print_job_requested_by_fk FOREIGN KEY (tenant_id, requested_by) REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (requested_by)
);
CREATE INDEX print_job_device_status_idx ON print_job (tenant_id, device_id, status, id);

------------------------------------------------------------------------------------------------
-- Sync and outbox (7.8.8)
------------------------------------------------------------------------------------------------

CREATE TABLE sync_job (
  id                ulid NOT NULL,
  tenant_id         ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  store_id          ulid,
  kind              text NOT NULL,
  direction         text NOT NULL CHECK (direction IN ('pull', 'push')),
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  request_summary   jsonb,
  response_summary  jsonb,
  error_code        text,
  error_message     text,
  started_at        timestamptz,
  finished_at       timestamptz,
  duration_ms       integer CHECK (duration_ms >= 0),
  queue_job_id      text,
  trace_id          text,
  CONSTRAINT sync_job_pk PRIMARY KEY (id),
  CONSTRAINT sync_job_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id) ON DELETE RESTRICT
) PARTITION BY RANGE (id);
CREATE TABLE sync_job_pdefault PARTITION OF sync_job DEFAULT;
CREATE INDEX sync_job_tenant_store_kind_idx ON sync_job (tenant_id, store_id, kind, id DESC);

CREATE TABLE outbox_event (
  id             ulid PRIMARY KEY,
  tenant_id      ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  aggregate_type text NOT NULL,
  aggregate_id   ulid NOT NULL,
  event_type     text NOT NULL,
  payload        jsonb NOT NULL,
  queue          text NOT NULL,
  job_name       text NOT NULL,
  job_id         text NOT NULL,
  job_options    jsonb NOT NULL DEFAULT '{}',
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     text
);
CREATE INDEX outbox_event_unpublished_idx ON outbox_event (id) WHERE published_at IS NULL;
CREATE INDEX outbox_event_published_idx ON outbox_event (published_at) WHERE published_at IS NOT NULL;

------------------------------------------------------------------------------------------------
-- Platform and audit (7.8.12 subset)
------------------------------------------------------------------------------------------------

CREATE TABLE feature_flag_override (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  flag_id     ulid NOT NULL REFERENCES feature_flag (id) ON DELETE CASCADE,
  enabled     boolean NOT NULL,
  CONSTRAINT feature_flag_override_uq UNIQUE (tenant_id, flag_id)
);

-- Append only (trigger audit_log_immutable), partitioned monthly on id.
CREATE TABLE audit_log (
  id          ulid NOT NULL,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL CHECK (actor_type IN ('user', 'system', 'api_key', 'device')),
  actor_id    text,
  request_id  text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   ulid NOT NULL,
  before      jsonb,
  after       jsonb,
  ip          inet,
  CONSTRAINT audit_log_pk PRIMARY KEY (id)
) PARTITION BY RANGE (id);
CREATE TABLE audit_log_pdefault PARTITION OF audit_log DEFAULT;
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id, id DESC);
