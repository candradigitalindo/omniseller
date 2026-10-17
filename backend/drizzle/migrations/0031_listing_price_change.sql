-- Regular marketplace SKU prices: requests are distinct from marketplace-confirmed listing prices.
ALTER TABLE channel_listing ADD CONSTRAINT channel_listing_tenant_id_id_store_uq UNIQUE (tenant_id, id, store_id);

CREATE TABLE listing_price_change_status_transition (
  id ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status text NOT NULL,
  via text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE listing_price_change (
  id ulid PRIMARY KEY,
  tenant_id ulid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  listing_id ulid NOT NULL,
  store_id ulid NOT NULL,
  requested_by ulid,
  expected_price bigint NOT NULL CHECK (expected_price > 0),
  requested_price bigint NOT NULL CHECK (requested_price > 0),
  observed_price bigint CHECK (observed_price >= 0),
  sent_at timestamptz,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','succeeded','failed','cancelled')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  error_message text,
  claimed_at timestamptz,
  claim_id ulid,
  CONSTRAINT listing_price_change_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT listing_price_change_listing_fk FOREIGN KEY (tenant_id, listing_id, store_id)
    REFERENCES channel_listing(tenant_id, id, store_id) ON DELETE CASCADE,
  CONSTRAINT listing_price_change_requester_fk FOREIGN KEY (tenant_id, requested_by)
    REFERENCES "user"(tenant_id,id) ON DELETE SET NULL (requested_by)
);
CREATE UNIQUE INDEX listing_price_change_pending_uq ON listing_price_change(tenant_id, listing_id)
  WHERE status IN ('queued','processing');
CREATE INDEX listing_price_change_history_idx ON listing_price_change(tenant_id, listing_id, id DESC);
