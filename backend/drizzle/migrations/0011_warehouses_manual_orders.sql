-- 0011_warehouses_manual_orders: more than one physical warehouse, manual orders, automatic warehouse
-- allocation, and order tags (PRD FR-STK-01, FR-WHS-08, 10, FR-ORD-04, 09, 12; backend doc 7.8, 8.21).

-- How a manual order is paid (FR-ORD-09). NULL for marketplace orders: the marketplace collects.
ALTER TABLE "order" ADD COLUMN payment_method text
  CHECK (payment_method IN ('transfer', 'cash', 'ewallet', 'cod', 'other'));

-- Document numbers per business, kind, and period (manual orders now, purchase orders later). The next
-- number to hand out is taken with INSERT ... ON CONFLICT DO UPDATE ... RETURNING inside the document's
-- own transaction: numbers never repeat, and two requests for the same period wait for each other.
CREATE TABLE document_sequence (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  kind        text NOT NULL CHECK (kind ~ '^[a-z_]+$'),
  period      text NOT NULL CHECK (period ~ '^[0-9]{4,8}$'),
  next_value  bigint NOT NULL CHECK (next_value > 0),
  CONSTRAINT document_sequence_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT document_sequence_uq UNIQUE (tenant_id, kind, period)
);

-- Idempotency-Key of requests that create records (backend doc 10.2), kept in the transaction that
-- creates the record: a repeated request (double click, retry after a lost response) waits for the first
-- and gets its record instead of a second one. Holds no request body, only its hash.
CREATE TABLE idempotency_record (
  id           ulid PRIMARY KEY,
  tenant_id    ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  integer NOT NULL DEFAULT 1,
  scope        text NOT NULL CHECK (scope ~ '^[a-z_]+(\.[a-z_]+)+$'),
  key          text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 100),
  request_hash text NOT NULL,
  resource_id  ulid NOT NULL,
  created_by   ulid,
  CONSTRAINT idempotency_record_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT idempotency_record_uq UNIQUE (tenant_id, scope, key),
  CONSTRAINT idempotency_record_created_by_fk FOREIGN KEY (tenant_id, created_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (created_by)
);

-- Order tags (FR-ORD-04). Nothing wrote tags before this migration. Names are unique per business
-- without regard to case or surrounding spaces; colors are the UI palette's hex values.
DROP INDEX tag_tenant_name_uq;
CREATE UNIQUE INDEX tag_tenant_name_uq ON tag (tenant_id, lower(btrim(name))) WHERE deleted_at IS NULL;
ALTER TABLE tag ADD CONSTRAINT tag_name_ck CHECK (char_length(btrim(name)) BETWEEN 1 AND 30);
ALTER TABLE tag ADD CONSTRAINT tag_color_ck CHECK (color ~ '^#[0-9A-F]{6}$');
