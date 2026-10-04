-- 0009_migration_cutover: moving from another app without the stock going wrong (PRD 6.20: FR-MIG-01,
-- 05, 06; backend doc 7.8.2, 7.8.12, 7.9, 8.19).

-- When the store last changed sync mode; NULL means it has not changed since it was connected. Parallel
-- mode (read_only) has run since then (FR-MIG-05).
ALTER TABLE store ADD COLUMN sync_mode_changed_at timestamptz;

------------------------------------------------------------------------------------------------
-- Imports from another app (FR-MIG-01): the uploaded file, its column mapping, validation, import
------------------------------------------------------------------------------------------------

CREATE TABLE migration_job_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE migration_job (
  id                ulid PRIMARY KEY,
  tenant_id         ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  source_app        text NOT NULL CHECK (source_app IN ('omniseller', 'bigseller', 'ginee', 'jubelio', 'spreadsheet', 'other')),
  kind              text NOT NULL DEFAULT 'products' CHECK (kind IN ('products', 'costs', 'mappings', 'stock')),
  status            text NOT NULL DEFAULT 'uploaded'
                    CHECK (status IN ('uploaded', 'validating', 'validated', 'invalid', 'importing', 'imported', 'failed')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  -- the uploaded file, private, kept 30 days; the job keeps its result after the file is gone
  file_object_id    ulid,
  file_name         text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  file_type         text NOT NULL CHECK (file_type IN ('xlsx', 'csv')),
  columns           jsonb NOT NULL DEFAULT '[]',  -- headers of the source file, in order
  preview           jsonb NOT NULL DEFAULT '[]',  -- the first data rows, for the mapping screen
  column_mapping    jsonb NOT NULL DEFAULT '{}',  -- {headerRow, fields: {field: column index}, weightUnit, dimensionUnit}
  stats             jsonb NOT NULL DEFAULT '{}',  -- rows, errors, products and variants created or updated, stock
  error             text,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_by        ulid,
  CONSTRAINT migration_job_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT migration_job_file_fk FOREIGN KEY (tenant_id, file_object_id)
    REFERENCES file_object (tenant_id, id) ON DELETE SET NULL (file_object_id),
  CONSTRAINT migration_job_created_by_fk FOREIGN KEY (tenant_id, created_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX migration_job_tenant_id_idx ON migration_job (tenant_id, id DESC);

-- One row per problem found by the last validation; replaced by each validation.
CREATE TABLE migration_row_error (
  id               ulid PRIMARY KEY,
  tenant_id        ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT now(),
  migration_job_id ulid NOT NULL,
  row_number       integer NOT NULL CHECK (row_number >= 1), -- the spreadsheet row
  field            text,                                     -- the OmniSeller field, NULL for the whole row
  message          text NOT NULL,
  raw              jsonb NOT NULL DEFAULT '[]',              -- the row's cells as in the file
  CONSTRAINT migration_row_error_job_fk FOREIGN KEY (tenant_id, migration_job_id)
    REFERENCES migration_job (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX migration_row_error_job_idx ON migration_row_error (tenant_id, migration_job_id, row_number);

-- Column mappings a business saved for files of an app (FR-MIG-01 "dapat disimpan"), by header name.
CREATE TABLE migration_preset (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  source_app  text NOT NULL CHECK (source_app IN ('omniseller', 'bigseller', 'ginee', 'jubelio', 'spreadsheet', 'other')),
  mapping     jsonb NOT NULL, -- {fields: {field: header}, weightUnit, dimensionUnit}
  created_by  ulid,
  CONSTRAINT migration_preset_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT migration_preset_created_by_fk FOREIGN KEY (tenant_id, created_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE UNIQUE INDEX migration_preset_tenant_name_uq ON migration_preset (tenant_id, lower(btrim(name)));

------------------------------------------------------------------------------------------------
-- Cutover (FR-MIG-06): a read-only store goes live once its checklist passes; undo within 24 hours
------------------------------------------------------------------------------------------------

CREATE TABLE store_cutover_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE store_cutover (
  id                ulid PRIMARY KEY,
  tenant_id         ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  store_id          ulid NOT NULL,
  status            text NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'undone')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  checklist         jsonb NOT NULL, -- the checks as they passed, and the confirmations given
  undo_until        timestamptz NOT NULL,
  performed_by      ulid,
  undone_at         timestamptz,
  undone_by         ulid,
  CONSTRAINT store_cutover_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- history of the store: goes with it when a business is purged
  CONSTRAINT store_cutover_store_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES store (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT store_cutover_performed_by_fk FOREIGN KEY (tenant_id, performed_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (performed_by),
  CONSTRAINT store_cutover_undone_by_fk FOREIGN KEY (tenant_id, undone_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (undone_by),
  CONSTRAINT store_cutover_undone_ck CHECK ((status = 'undone') = (undone_at IS NOT NULL))
);
CREATE INDEX store_cutover_tenant_store_idx ON store_cutover (tenant_id, store_id, id DESC);
CREATE INDEX store_cutover_tenant_id_idx ON store_cutover (tenant_id, id DESC);
