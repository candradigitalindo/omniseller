-- 0014_print_agent_packing_handover: the local print agent and scan to print, packing by scan, and courier
-- handover with a manifest (PRD FR-SHP-17, FR-SHP-04, FR-SHP-05; backend doc 8.24).

------------------------------------------------------------------------------------------------
-- FR-SHP-17: print agents
------------------------------------------------------------------------------------------------

-- What the agent last reported (its printers) and which of them takes shipping labels and A4 documents
-- when a print request names no printer. NULL leaves the choice to the computer's default printer.
ALTER TABLE device ADD COLUMN printers jsonb NOT NULL DEFAULT '[]';
ALTER TABLE device ADD COLUMN label_printer text;
ALTER TABLE device ADD COLUMN document_printer text;

-- A print job may wait for its document (rendered by the worker), so it starts without a file. Files with
-- buyer data expire and the hourly cleanup deletes their rows: the job keeps its history without the file.
ALTER TABLE print_job ALTER COLUMN file_object_id DROP NOT NULL;
ALTER TABLE print_job DROP CONSTRAINT print_job_file_fk;
ALTER TABLE print_job ADD CONSTRAINT print_job_file_fk FOREIGN KEY (tenant_id, file_object_id)
  REFERENCES file_object (tenant_id, id) ON DELETE SET NULL (file_object_id);
ALTER TABLE print_job ADD COLUMN document_id ulid;
ALTER TABLE print_job ADD CONSTRAINT print_job_document_fk FOREIGN KEY (tenant_id, document_id)
  REFERENCES document_job (tenant_id, id) ON DELETE SET NULL (document_id);
-- What the queue shows ("Label 12 pesanan"), when the agent took the file, and when the status changed.
ALTER TABLE print_job ADD COLUMN title text NOT NULL DEFAULT '';
ALTER TABLE print_job ADD COLUMN sent_at timestamptz;
ALTER TABLE print_job ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now();
-- `test`: the test page of "Cetak percobaan" (UI L42).
ALTER TABLE print_job DROP CONSTRAINT print_job_kind_check;
ALTER TABLE print_job ADD CONSTRAINT print_job_kind_check
  CHECK (kind IN ('label', 'pick_list', 'packing_list', 'invoice', 'barcode', 'manifest', 'test'));
CREATE INDEX print_job_tenant_id_idx ON print_job (tenant_id, id DESC);
CREATE INDEX print_job_tenant_document_idx ON print_job (tenant_id, document_id) WHERE document_id IS NOT NULL;

CREATE TABLE print_job_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

-- Handover manifests and the agent's test page are rendered like the other documents.
ALTER TABLE document_job DROP CONSTRAINT document_job_kind_check;
ALTER TABLE document_job ADD CONSTRAINT document_job_kind_check
  CHECK (kind IN ('labels', 'pick_list', 'packing_list', 'barcode_labels', 'handover_manifest', 'test_page'));

------------------------------------------------------------------------------------------------
-- Scanning an order number or a tracking number (FR-SHP-17, 04, 05)
------------------------------------------------------------------------------------------------

-- order.tracking_number and shipment.tracking_number have their indexes since 0001.
CREATE INDEX order_tenant_external_order_idx ON "order" (tenant_id, external_order_id);
CREATE INDEX shipment_package_tenant_tracking_idx ON shipment_package (tenant_id, tracking_number)
  WHERE tracking_number IS NOT NULL;

------------------------------------------------------------------------------------------------
-- FR-SHP-05: courier handover. One open manifest per warehouse and courier collects the scanned parcels;
-- completing it hands them over (marketplace shipments) or ships them (manual orders).
------------------------------------------------------------------------------------------------

CREATE TABLE handover_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE handover (
  id                ulid PRIMARY KEY,
  tenant_id         ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       integer NOT NULL DEFAULT 1,
  number            text NOT NULL,
  warehouse_id      ulid NOT NULL,
  courier           text NOT NULL CHECK (length(courier) BETWEEN 1 AND 80),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  -- the courier's name as they sign the manifest
  received_by       text CHECK (length(received_by) <= 80),
  created_by        ulid,
  completed_by      ulid,
  completed_at      timestamptz,
  CONSTRAINT handover_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT handover_tenant_number_uq UNIQUE (tenant_id, number),
  -- warehouses are archived, never deleted (WarehouseAdminService)
  CONSTRAINT handover_warehouse_fk FOREIGN KEY (tenant_id, warehouse_id) REFERENCES warehouse (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT handover_created_by_fk FOREIGN KEY (tenant_id, created_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (created_by),
  CONSTRAINT handover_completed_by_fk FOREIGN KEY (tenant_id, completed_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (completed_by),
  CONSTRAINT handover_completed_ck CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX handover_tenant_id_idx ON handover (tenant_id, id DESC);
-- Two stations scanning for the same courier fill the same manifest.
CREATE UNIQUE INDEX handover_open_uq ON handover (tenant_id, warehouse_id, lower(courier)) WHERE status = 'open';

CREATE TABLE handover_item (
  id              ulid PRIMARY KEY,
  tenant_id       ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  handover_id     ulid NOT NULL,
  order_id        ulid NOT NULL,
  shipment_id     ulid,
  -- what the manifest prints: the parcel's tracking number (or the order number when it has none)
  tracking_number text NOT NULL,
  order_number    text NOT NULL,
  scanned_by      ulid,
  CONSTRAINT handover_item_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT handover_item_order_uq UNIQUE (tenant_id, handover_id, order_id),
  CONSTRAINT handover_item_handover_fk FOREIGN KEY (tenant_id, handover_id)
    REFERENCES handover (tenant_id, id) ON DELETE CASCADE,
  -- a store disconnected without its data takes its orders off the manifests (FR-INT-07)
  CONSTRAINT handover_item_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT handover_item_shipment_fk FOREIGN KEY (tenant_id, shipment_id)
    REFERENCES shipment (tenant_id, id) ON DELETE SET NULL (shipment_id),
  CONSTRAINT handover_item_scanned_by_fk FOREIGN KEY (tenant_id, scanned_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (scanned_by)
);
CREATE INDEX handover_item_tenant_order_idx ON handover_item (tenant_id, order_id);
