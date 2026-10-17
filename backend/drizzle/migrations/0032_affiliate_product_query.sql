-- A requested AMS page is read by a worker; the API never holds marketplace credentials.
CREATE TABLE affiliate_product_query_status_transition (
  id ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status text NOT NULL,
  via text NOT NULL DEFAULT 'any' CHECK (via IN ('any','marketplace')),
  UNIQUE (from_status,to_status),
  CHECK (from_status <> to_status)
);
CREATE TABLE affiliate_product_query (
  id ulid PRIMARY KEY,
  tenant_id ulid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  store_id ulid NOT NULL,
  requested_by ulid,
  query jsonb NOT NULL CHECK (jsonb_typeof(query)='object'),
  items jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items)='array' AND jsonb_array_length(items)<=100),
  total integer CHECK (total >= 0),
  next_cursor text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  error_message text,
  claim_id ulid,
  claimed_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT affiliate_product_query_tenant_id_id_uq UNIQUE (tenant_id,id),
  -- The store marker survives disconnection; retention deletes query pages explicitly.
  FOREIGN KEY (tenant_id,store_id) REFERENCES store(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,requested_by) REFERENCES "user"(tenant_id,id) ON DELETE SET NULL (requested_by)
);
CREATE UNIQUE INDEX affiliate_product_query_pending_uq ON affiliate_product_query(tenant_id,store_id)
  WHERE status IN ('queued','running');
CREATE INDEX affiliate_product_query_store_idx ON affiliate_product_query(tenant_id,store_id,id DESC);
CREATE INDEX affiliate_product_query_expiry_idx ON affiliate_product_query(tenant_id,expires_at);
