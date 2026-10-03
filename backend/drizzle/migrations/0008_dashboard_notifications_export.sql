-- 0008_dashboard_notifications_export: in-app notifications for new orders and critical stock,
-- and the full data export (backend doc 7.8.4, 7.8.6, 7.8.12, 8.16, 8.17, 8.18).

-- Stock alert already sent for this variant in this warehouse (FR-NTF-01): 'low' (at or under the
-- minimum) or 'out' (nothing sellable). Cleared when the stock recovers, so the next drop alerts again.
ALTER TABLE inventory ADD COLUMN stock_alert text CHECK (stock_alert IN ('low', 'out'));

-- The order waits for the next new-order notification (FR-NTF-01). Set when an order needs the
-- seller for the first time, cleared by the notification job.
ALTER TABLE "order" ADD COLUMN notify_new boolean NOT NULL DEFAULT false;
CREATE INDEX order_tenant_notify_new_idx ON "order" (tenant_id) WHERE notify_new;

------------------------------------------------------------------------------------------------
-- Full data export (PRD FR-MIG-09): every CSV of the business in one ZIP, rendered by the worker
------------------------------------------------------------------------------------------------

CREATE TABLE data_export_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE data_export (
  id                ulid PRIMARY KEY,
  tenant_id         ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  file_object_id    ulid,
  size_bytes        bigint CHECK (size_bytes >= 0),
  result            jsonb NOT NULL DEFAULT '{}', -- {files: [{name, rows}]}
  error             text,
  requested_by      ulid,
  finished_at       timestamptz,
  expires_at        timestamptz, -- when the ZIP is deleted (7 days after it is ready)
  -- every download is audited (the ZIP holds buyer data): the count changes, the trigger logs who
  download_count    integer NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  last_downloaded_at timestamptz,
  CONSTRAINT data_export_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT data_export_file_fk FOREIGN KEY (tenant_id, file_object_id)
    REFERENCES file_object (tenant_id, id) ON DELETE SET NULL (file_object_id),
  CONSTRAINT data_export_requested_by_fk FOREIGN KEY (tenant_id, requested_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (requested_by)
);
CREATE INDEX data_export_tenant_id_idx ON data_export (tenant_id, id DESC);
-- One export at a time per business: a second request while one is queued or running gets that one.
CREATE UNIQUE INDEX data_export_tenant_open_uq ON data_export (tenant_id) WHERE status IN ('queued', 'running');
