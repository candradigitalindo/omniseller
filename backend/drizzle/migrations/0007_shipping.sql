-- 0007_shipping: arranging pickup or drop-off with Shopee and TikTok Shop, shipping labels, pick lists,
-- printable documents, ship-by alerts, in-app notifications (backend doc 7.8.6, 7.8.12, 7.9, 8.15).

-- When the marketplace accepted the pickup or drop-off, and the last arrangement or label error the
-- seller sees (pending shipments keep it until the next attempt).
ALTER TABLE shipment ADD COLUMN arranged_at timestamptz;
ALTER TABLE shipment ADD COLUMN last_error text;
-- One live shipment per order: two arrange requests at once cannot both create one. A cancelled
-- shipment may be followed by a new one.
CREATE UNIQUE INDEX shipment_tenant_order_live_uq ON shipment (tenant_id, order_id) WHERE status <> 'cancelled';

-- Ship-by alerts already sent for this order (FR-SHP-10): 'warning' (6 hours or less left), 'overdue'.
ALTER TABLE "order" ADD COLUMN sla_alert_level text CHECK (sla_alert_level IN ('warning', 'overdue'));
-- Orders still to ship by deadline, for the ship-by alert scan.
CREATE INDEX order_tenant_due_idx ON "order" (tenant_id, ship_by_at)
  WHERE status IN ('new', 'problem', 'ready_to_pack', 'packed', 'ready_to_ship') AND ship_by_at IS NOT NULL;

------------------------------------------------------------------------------------------------
-- Printable documents rendered by the worker on request (labels in one PDF, pick lists)
------------------------------------------------------------------------------------------------

CREATE TABLE document_job_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE document_job (
  id                ulid PRIMARY KEY,
  tenant_id         ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  kind              text NOT NULL CHECK (kind IN ('labels', 'pick_list')),
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  params            jsonb NOT NULL, -- {orderIds, format}
  result            jsonb NOT NULL DEFAULT '{}', -- {orders, labels, missing: [{orderId, code, message}]}
  file_object_id    ulid,
  page_count        integer CHECK (page_count >= 0),
  error             text,
  requested_by      ulid,
  finished_at       timestamptz,
  CONSTRAINT document_job_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT document_job_file_fk FOREIGN KEY (tenant_id, file_object_id)
    REFERENCES file_object (tenant_id, id) ON DELETE SET NULL (file_object_id),
  CONSTRAINT document_job_requested_by_fk FOREIGN KEY (tenant_id, requested_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (requested_by)
);
CREATE INDEX document_job_tenant_id_idx ON document_job (tenant_id, id DESC);

------------------------------------------------------------------------------------------------
-- In-app notifications (7.8.12, PRD FR-NTF-01): one row per recipient
------------------------------------------------------------------------------------------------

CREATE TABLE notification (
  id            ulid PRIMARY KEY,
  tenant_id     ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   integer NOT NULL DEFAULT 1,
  user_id       ulid, -- NULL: every user of the tenant
  kind          text NOT NULL,
  severity      text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  data          jsonb NOT NULL DEFAULT '{}',
  channels_sent jsonb NOT NULL DEFAULT '{}',
  read_at       timestamptz,
  CONSTRAINT notification_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT notification_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES "user" (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX notification_tenant_user_read_idx ON notification (tenant_id, user_id, read_at, id DESC);
