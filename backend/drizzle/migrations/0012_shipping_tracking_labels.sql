-- 0012_shipping_tracking_labels: parcel tracking from the marketplaces, packing lists, and the custom
-- label template (PRD FR-SHP-03, 07, 16; backend doc 8.22).

-- Where the parcel is (FR-SHP-07), read from the marketplace by the job shipment.tracking_pull. The
-- events may name who received the parcel: personal data, anonymized with the order's buyer data.
ALTER TABLE shipment ADD COLUMN tracking_stage text CHECK (tracking_stage IN (
  'waiting_pickup', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returning', 'returned', 'lost',
  'cancelled'));
ALTER TABLE shipment ADD COLUMN tracking_events jsonb NOT NULL DEFAULT '[]';
-- the newest event's time, and the last successful read
ALTER TABLE shipment ADD COLUMN tracking_event_at timestamptz;
ALTER TABLE shipment ADD COLUMN tracking_synced_at timestamptz;
-- why the last read failed, in the marketplace's words; cleared by the next successful read
ALTER TABLE shipment ADD COLUMN tracking_error text;

-- Packing lists (FR-SHP-03) are rendered like labels and pick lists.
ALTER TABLE document_job DROP CONSTRAINT document_job_kind_check;
ALTER TABLE document_job ADD CONSTRAINT document_job_kind_check CHECK (kind IN ('labels', 'pick_list', 'packing_list'));

-- What the custom template adds under a marketplace label (FR-SHP-16, UI L42), one per business. The
-- marketplace label itself is never drawn over. Without a row the defaults apply.
CREATE TABLE label_template (
  id              ulid PRIMARY KEY,
  tenant_id       ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  row_version     integer NOT NULL DEFAULT 1,
  show_sku        boolean NOT NULL DEFAULT true,
  show_variant    boolean NOT NULL DEFAULT true,
  show_bin        boolean NOT NULL DEFAULT true,
  show_buyer_note boolean NOT NULL DEFAULT true,
  show_tags       boolean NOT NULL DEFAULT false,
  CONSTRAINT label_template_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT label_template_tenant_uq UNIQUE (tenant_id)
);
