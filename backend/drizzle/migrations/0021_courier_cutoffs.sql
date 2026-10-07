-- 0021_courier_cutoffs: courier cut-offs, courier holidays, and operating hours (PRD FR-CMP-05, 06; UI L43;
-- backend doc 8.31). From them each order to ship gets an internal deadline, `order.internal_ship_by_at`
-- (column since 0001): the courier's last pickup it can still make. Couriers are names as the marketplaces
-- send them (`order.shipping_provider`, "J&T Express"), matched the way handovers match them.

-- The last pickup or drop-off of a courier at a warehouse, on the days it comes (0 = Sunday .. 6).
CREATE TABLE courier_cutoff (
  id              ulid PRIMARY KEY,
  tenant_id       ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  warehouse_id    ulid NOT NULL,
  courier         text NOT NULL CHECK (char_length(btrim(courier)) BETWEEN 1 AND 60),
  cutoff_time     time NOT NULL,
  days_of_week    smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6}'
                  CHECK (cardinality(days_of_week) BETWEEN 1 AND 7 AND days_of_week <@ '{0,1,2,3,4,5,6}'::smallint[]),
  active          boolean NOT NULL DEFAULT true,
  CONSTRAINT courier_cutoff_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT courier_cutoff_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id)
    REFERENCES warehouse (tenant_id, id) ON DELETE CASCADE
);
-- one cut-off per warehouse and courier, however the name is typed
CREATE UNIQUE INDEX courier_cutoff_courier_uq ON courier_cutoff (tenant_id, warehouse_id, lower(btrim(courier)));

-- Days a courier does not pick up (all couriers when `courier` is null), on top of its days of the week.
CREATE TABLE courier_holiday (
  id              ulid PRIMARY KEY,
  tenant_id       ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  holiday_date    date NOT NULL,
  courier         text CHECK (char_length(btrim(courier)) BETWEEN 1 AND 60),
  note            text CHECK (char_length(note) <= 120),
  CONSTRAINT courier_holiday_tenant_id_id_uq UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX courier_holiday_uq ON courier_holiday (tenant_id, holiday_date, lower(btrim(coalesce(courier, ''))));

-- When the business works: one default week, and special periods (Ramadan) that replace it on their dates.
-- `schedule` holds 7 days from Sunday: null when closed, else {"open": "HH:MM", "close": "HH:MM"}.
CREATE TABLE operating_hours (
  id              ulid PRIMARY KEY,
  tenant_id       ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  name            text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  schedule        jsonb NOT NULL CHECK (jsonb_typeof(schedule) = 'array' AND jsonb_array_length(schedule) = 7),
  valid_from      date,
  valid_to        date,
  is_default      boolean NOT NULL DEFAULT false,
  CONSTRAINT operating_hours_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- the default week has no dates; a special period has both, in order
  CONSTRAINT operating_hours_period CHECK (
    (is_default AND valid_from IS NULL AND valid_to IS NULL)
    OR (NOT is_default AND valid_from IS NOT NULL AND valid_to IS NOT NULL AND valid_to >= valid_from))
);
CREATE UNIQUE INDEX operating_hours_default_uq ON operating_hours (tenant_id) WHERE is_default;

-- the queue of orders to ship, soonest deadline first, internal or the marketplace's (backend doc 8.31)
CREATE INDEX order_tenant_status_deadline_idx ON "order" (tenant_id, status, (LEAST(internal_ship_by_at, ship_by_at)));
