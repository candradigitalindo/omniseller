-- 0003_channel_connect: store connection (backend doc 7.8.2, 8.6, 8.11; technology doc 19.3).
--
-- A connection starts as a store_authorization row (the state sent to the marketplace), is exchanged
-- for tokens by the worker, and ends as one store per granted shop with its credential. The store row
-- cannot exist earlier: its external shop id is only known after the exchange (TikTok Shop) or at the
-- callback (Shopee).

-- Tenant data encryption keys: envelope encryption of marketplace tokens. The DEK is wrapped by the KMS
-- key (local master key in local and test); only the worker ever unwraps it. One active key per tenant;
-- rotation adds a version and retires the previous one after credentials are re-encrypted.
CREATE TABLE tenant_key (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  version     integer NOT NULL CHECK (version > 0),
  provider    text NOT NULL CHECK (provider IN ('local', 'aws_kms')),
  key_ref     text NOT NULL,
  wrapped_dek bytea NOT NULL,
  retired_at  timestamptz,
  CONSTRAINT tenant_key_version_uq UNIQUE (tenant_id, version)
);
CREATE UNIQUE INDEX tenant_key_one_active_uq ON tenant_key (tenant_id) WHERE retired_at IS NULL;

-- One row per "connect" (or "reconnect") attempt. Only the hash of the state is stored.
CREATE TABLE store_authorization (
  id            ulid PRIMARY KEY,
  tenant_id     ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 1,
  channel       text NOT NULL CHECK (channel IN ('shopee', 'tiktokshop', 'lazada', 'blibli', 'shopify', 'woocommerce')),
  -- set when the attempt re-authorizes an existing store; the granted shop must be that store
  store_id      ulid,
  requested_by  ulid,
  state_hash    text NOT NULL UNIQUE,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'exchanging', 'succeeded', 'failed', 'expired')),
  expires_at    timestamptz NOT NULL,
  callback_at   timestamptz,
  completed_at  timestamptz,
  result        jsonb NOT NULL DEFAULT '{}',
  error_code    text,
  error_message text,
  CONSTRAINT store_authorization_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES store (tenant_id, id) ON DELETE SET NULL (store_id),
  CONSTRAINT store_authorization_requested_by_fk FOREIGN KEY (tenant_id, requested_by) REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (requested_by),
  CONSTRAINT store_authorization_completed_ck CHECK ((status IN ('succeeded', 'failed', 'expired')) = (completed_at IS NOT NULL))
);
CREATE INDEX store_authorization_tenant_idx ON store_authorization (tenant_id, id DESC);

-- Store: when the seller's authorization ends, why the store is in its status, and non-secret
-- marketplace metadata (seller type, shop code, logo) shown on the connection screen.
ALTER TABLE store ADD COLUMN authorization_expires_at timestamptz;
ALTER TABLE store ADD COLUMN status_reason text;
ALTER TABLE store ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE store ADD COLUMN marketplace_info jsonb NOT NULL DEFAULT '{}';

-- TikTok Shop's shop_cipher is required on every shop-scoped call. It lives with the tokens so that a
-- disconnect removes it together with them and only the worker can read it.
ALTER TABLE store_credential ADD COLUMN shop_cipher text;
