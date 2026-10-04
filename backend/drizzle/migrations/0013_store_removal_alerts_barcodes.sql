-- 0013_store_removal_alerts_barcodes: disconnecting a store with or without its data, connection alerts,
-- and barcode labels (PRD FR-INT-07, FR-INT-08, FR-PRD-12; backend doc 8.23).

-- FR-INT-07: a store disconnected here no longer holds its marketplace shop, so another business (or this
-- one, after deleting the data) can connect it. Only stores that are not disconnected are unique per shop.
-- The index keeps the constraint's name: a duplicate still reads as store.already_connected.
ALTER TABLE store DROP CONSTRAINT store_channel_external_shop_uq;
CREATE UNIQUE INDEX store_channel_external_shop_uq ON store (channel, external_shop_id) WHERE status <> 'disconnected';
CREATE INDEX store_tenant_channel_shop_idx ON store (tenant_id, channel, external_shop_id);

-- FR-INT-07: a store disconnected without keeping its data. Its orders, listings, warehouse mappings, and
-- sync log are deleted in the background; the row itself stays, so user store scopes that name it keep
-- meaning "this store" (an empty scope means every store).
ALTER TABLE store ADD COLUMN data_deletion_requested_at timestamptz;
ALTER TABLE store ADD COLUMN data_deleted_at timestamptz;
ALTER TABLE store ADD CONSTRAINT store_data_deletion_ck CHECK (
  (data_deletion_requested_at IS NULL OR status = 'disconnected')
  AND (data_deleted_at IS NULL OR data_deletion_requested_at IS NOT NULL));

-- FR-INT-08: since when the store's marketplace calls fail for a temporary reason (cleared by the next
-- call that works), and when its managers were told the connection is down (cleared once it is back).
ALTER TABLE store ADD COLUMN failing_since timestamptz;
ALTER TABLE store ADD COLUMN connection_alert_at timestamptz;

-- FR-PRD-11: the product history needs every change of a product or variant in the audit log. The old
-- triggers audited prices and status only; drizzle/sql/20_triggers.sql creates their wider successor
-- (audit_change_trg) right after the migrations.
DROP TRIGGER IF EXISTS audit_upd_trg ON variant;
DROP TRIGGER IF EXISTS audit_upd_trg ON product;

-- FR-PRD-12: internal barcode labels are rendered like the other documents.
ALTER TABLE document_job DROP CONSTRAINT document_job_kind_check;
ALTER TABLE document_job ADD CONSTRAINT document_job_kind_check
  CHECK (kind IN ('labels', 'pick_list', 'packing_list', 'barcode_labels'));
