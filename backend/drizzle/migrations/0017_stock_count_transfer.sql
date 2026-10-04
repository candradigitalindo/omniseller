-- 0017_stock_count_transfer: stock counts (opname) counted blind and approved before stock changes, and
-- stock transfers between warehouses, sent and received (PRD FR-STK-08, 09; backend doc 8.27).

------------------------------------------------------------------------------------------------
-- Stock count: a list of variants of one warehouse, counted, reviewed, then applied by the worker
------------------------------------------------------------------------------------------------

CREATE TABLE stock_count_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE stock_count (
  id                 ulid PRIMARY KEY,
  tenant_id          ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  row_version        integer NOT NULL DEFAULT 1,
  -- OP-YYMM-NNNN in the business's time zone
  number             text NOT NULL,
  warehouse_id       ulid NOT NULL,
  -- full: every variant the warehouse holds a row for; partial: chosen variants or a rack
  mode               text NOT NULL CHECK (mode IN ('full', 'partial')),
  -- the counting screens do not show the system's quantity until review
  blind              boolean NOT NULL DEFAULT true,
  status             text NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'review', 'applied', 'cancelled')),
  status_changed_at  timestamptz NOT NULL DEFAULT now(),
  note               text,
  created_by         ulid,
  submitted_at       timestamptz,
  submitted_by       ulid,
  -- the approval: the worker applies the lines in batches, then marks the count applied
  apply_requested_at timestamptz,
  apply_requested_by ulid,
  -- lines not counted are left alone, or counted as none
  zero_uncounted     boolean NOT NULL DEFAULT false,
  applied_at         timestamptz,
  CONSTRAINT stock_count_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT stock_count_number_uq UNIQUE (tenant_id, number),
  CONSTRAINT stock_count_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_count_created_by_fk FOREIGN KEY (tenant_id, created_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (created_by),
  CONSTRAINT stock_count_submitted_by_fk FOREIGN KEY (tenant_id, submitted_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (submitted_by),
  CONSTRAINT stock_count_apply_requested_by_fk FOREIGN KEY (tenant_id, apply_requested_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (apply_requested_by),
  CONSTRAINT stock_count_applied_ck CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  CONSTRAINT stock_count_apply_ck CHECK (status <> 'applied' OR apply_requested_at IS NOT NULL)
);
CREATE INDEX stock_count_tenant_id_idx ON stock_count (tenant_id, id DESC);
-- one open count per warehouse: two counts of one shelf would overwrite each other's numbers
CREATE UNIQUE INDEX stock_count_open_uq ON stock_count (tenant_id, warehouse_id) WHERE status IN ('counting', 'review');

CREATE TABLE stock_count_line (
  id             ulid PRIMARY KEY,
  tenant_id      ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  row_version    integer NOT NULL DEFAULT 1,
  stock_count_id ulid NOT NULL,
  variant_id     ulid NOT NULL,
  -- the variant and its rack when the line was listed (or found): the count lists, searches, and
  -- exports its own lines without joining the catalog, whose plans go wrong right after a bulk import
  sku            text NOT NULL,
  product_name   text NOT NULL,
  variant_name   text NOT NULL,
  barcode        text,
  bin_location   text,
  -- the system's quantity on hand when the line was counted (when it was listed, until then): applying
  -- moves stock by the difference, so what shipped after the count is kept
  expected_qty   bigint NOT NULL,
  counted_qty    bigint CHECK (counted_qty >= 0),
  diff           bigint GENERATED ALWAYS AS (counted_qty - expected_qty) STORED,
  counted_at     timestamptz,
  counted_by     ulid,
  -- found on the shelf during the count, not on the list
  added          boolean NOT NULL DEFAULT false,
  -- what applying did: the stock moved by this much (less than diff when stock left in between), 0 when
  -- the quantity was confirmed; null until applied
  applied_delta  bigint,
  CONSTRAINT stock_count_line_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT stock_count_line_count_fk FOREIGN KEY (tenant_id, stock_count_id)
    REFERENCES stock_count (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT stock_count_line_variant_fk FOREIGN KEY (tenant_id, variant_id) REFERENCES variant (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_count_line_counted_by_fk FOREIGN KEY (tenant_id, counted_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (counted_by),
  CONSTRAINT stock_count_line_uq UNIQUE (stock_count_id, variant_id),
  CONSTRAINT stock_count_line_counted_ck CHECK ((counted_qty IS NULL) = (counted_at IS NULL))
);
CREATE INDEX stock_count_line_count_idx ON stock_count_line (tenant_id, stock_count_id, id);

------------------------------------------------------------------------------------------------
-- Stock transfer: goods leave one warehouse when sent and arrive in another when received
------------------------------------------------------------------------------------------------

CREATE TABLE stock_transfer_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE stock_transfer (
  id                ulid PRIMARY KEY,
  tenant_id         ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  -- TF-YYMM-NNNN in the business's time zone
  number            text NOT NULL,
  from_warehouse_id ulid NOT NULL,
  to_warehouse_id   ulid NOT NULL,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  note              text,
  created_by        ulid,
  sent_at           timestamptz,
  sent_by           ulid,
  received_at       timestamptz,
  received_by       ulid,
  receipt_note      text,
  cancelled_at      timestamptz,
  cancelled_by      ulid,
  CONSTRAINT stock_transfer_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT stock_transfer_number_uq UNIQUE (tenant_id, number),
  CONSTRAINT stock_transfer_from_fk FOREIGN KEY (tenant_id, from_warehouse_id)
    REFERENCES warehouse (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_transfer_to_fk FOREIGN KEY (tenant_id, to_warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_transfer_created_by_fk FOREIGN KEY (tenant_id, created_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (created_by),
  CONSTRAINT stock_transfer_sent_by_fk FOREIGN KEY (tenant_id, sent_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (sent_by),
  CONSTRAINT stock_transfer_received_by_fk FOREIGN KEY (tenant_id, received_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (received_by),
  CONSTRAINT stock_transfer_cancelled_by_fk FOREIGN KEY (tenant_id, cancelled_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (cancelled_by),
  CONSTRAINT stock_transfer_warehouses_ck CHECK (from_warehouse_id <> to_warehouse_id),
  CONSTRAINT stock_transfer_sent_ck CHECK (status NOT IN ('sent', 'received') OR sent_at IS NOT NULL),
  CONSTRAINT stock_transfer_received_ck CHECK ((status = 'received') = (received_at IS NOT NULL)),
  CONSTRAINT stock_transfer_cancelled_ck CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX stock_transfer_tenant_id_idx ON stock_transfer (tenant_id, id DESC);
-- transfers still open hold a warehouse (it cannot be deleted)
CREATE INDEX stock_transfer_open_from_idx ON stock_transfer (tenant_id, from_warehouse_id) WHERE status IN ('draft', 'sent');
CREATE INDEX stock_transfer_open_to_idx ON stock_transfer (tenant_id, to_warehouse_id) WHERE status IN ('draft', 'sent');

CREATE TABLE stock_transfer_line (
  id                ulid PRIMARY KEY,
  tenant_id         ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  stock_transfer_id ulid NOT NULL,
  variant_id        ulid NOT NULL,
  qty               bigint NOT NULL CHECK (qty > 0),
  -- what arrived; null until received. The rest is missing (counted as lost in transit)
  received_qty      bigint CHECK (received_qty >= 0 AND received_qty <= qty),
  CONSTRAINT stock_transfer_line_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT stock_transfer_line_transfer_fk FOREIGN KEY (tenant_id, stock_transfer_id)
    REFERENCES stock_transfer (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT stock_transfer_line_variant_fk FOREIGN KEY (tenant_id, variant_id)
    REFERENCES variant (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT stock_transfer_line_uq UNIQUE (stock_transfer_id, variant_id)
);
CREATE INDEX stock_transfer_line_transfer_idx ON stock_transfer_line (tenant_id, stock_transfer_id, id);
