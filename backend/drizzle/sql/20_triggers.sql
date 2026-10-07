-- Repeatable: attach triggers that do not exist yet (ensure_trigger never replaces an existing one).

-- touch_row on every parent table that has updated_at and row_version
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl, c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'updated_at' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'row_version' AND NOT a.attisdropped)
  LOOP
    PERFORM ensure_trigger(r.tbl, 'touch_row_trg',
      format('CREATE TRIGGER touch_row_trg BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION touch_row()', r.tbl));
  END LOOP;
END $$;

-- Status machines: the base table name is passed as the trigger argument
SELECT ensure_trigger('"order"', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON "order" FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''order'')');
SELECT ensure_trigger('shipment', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON shipment FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''shipment'')');
SELECT ensure_trigger('sync_job', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON sync_job FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''sync_job'')');
SELECT ensure_trigger('data_export', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON data_export FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''data_export'')');
SELECT ensure_trigger('migration_job', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON migration_job FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''migration_job'')');
SELECT ensure_trigger('store_cutover', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON store_cutover FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''store_cutover'')');
SELECT ensure_trigger('document_job', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON document_job FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''document_job'')');
SELECT ensure_trigger('print_job', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON print_job FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''print_job'')');
SELECT ensure_trigger('handover', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON handover FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''handover'')');
SELECT ensure_trigger('listing_copy', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON listing_copy FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''listing_copy'')');
SELECT ensure_trigger('listing_draft', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON listing_draft FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''listing_draft'')');
SELECT ensure_trigger('return_request', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON return_request FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''return_request'')');
SELECT ensure_trigger('stock_count', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON stock_count FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''stock_count'')');
SELECT ensure_trigger('stock_transfer', 'status_transition_trg',
  'CREATE TRIGGER status_transition_trg BEFORE UPDATE OF status ON stock_transfer FOR EACH ROW EXECUTE FUNCTION enforce_status_transition(''stock_transfer'')');

-- Inventory guard
SELECT ensure_trigger('inventory', 'inventory_guard_trg',
  'CREATE TRIGGER inventory_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON inventory FOR EACH ROW EXECUTE FUNCTION inventory_guard()');

-- Audit on sensitive tables (backend doc 7.7). Frequently synced tables audit only the columns that matter.
SELECT ensure_trigger('variant', 'audit_insdel_trg',
  'CREATE TRIGGER audit_insdel_trg AFTER INSERT OR DELETE ON variant FOR EACH ROW EXECUTE FUNCTION audit_row()');
-- Products and variants: every change of a column, not only prices and status, because the product
-- history (FR-PRD-11, backend doc 8.23) shows who changed what. Writes that only bump updated_at and
-- row_version are left out. Migration 0013 dropped the narrower audit_upd_trg these replace.
SELECT ensure_trigger('variant', 'audit_change_trg',
  'CREATE TRIGGER audit_change_trg AFTER UPDATE ON variant FOR EACH ROW
     WHEN ((to_jsonb(OLD) - ''updated_at'' - ''row_version'') IS DISTINCT FROM (to_jsonb(NEW) - ''updated_at'' - ''row_version''))
     EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('product', 'audit_insdel_trg',
  'CREATE TRIGGER audit_insdel_trg AFTER INSERT OR DELETE ON product FOR EACH ROW EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('product', 'audit_change_trg',
  'CREATE TRIGGER audit_change_trg AFTER UPDATE ON product FOR EACH ROW
     WHEN ((to_jsonb(OLD) - ''updated_at'' - ''row_version'') IS DISTINCT FROM (to_jsonb(NEW) - ''updated_at'' - ''row_version''))
     EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('channel_listing', 'audit_insdel_trg',
  'CREATE TRIGGER audit_insdel_trg AFTER INSERT OR DELETE ON channel_listing FOR EACH ROW EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('channel_listing', 'audit_upd_trg',
  'CREATE TRIGGER audit_upd_trg AFTER UPDATE ON channel_listing FOR EACH ROW
     WHEN ((OLD.price, OLD.status, OLD.variant_id) IS DISTINCT FROM (NEW.price, NEW.status, NEW.variant_id))
     EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('store', 'audit_insdel_trg',
  'CREATE TRIGGER audit_insdel_trg AFTER INSERT OR DELETE ON store FOR EACH ROW EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('store', 'audit_upd_trg',
  'CREATE TRIGGER audit_upd_trg AFTER UPDATE ON store FOR EACH ROW
     WHEN ((OLD.status, OLD.sync_mode, OLD.default_warehouse_id, OLD.name) IS DISTINCT FROM (NEW.status, NEW.sync_mode, NEW.default_warehouse_id, NEW.name))
     EXECUTE FUNCTION audit_row()');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['role', 'role_permission', 'user_role', 'user_store_scope', 'user_warehouse_scope',
                           'channel_warehouse', 'stock_allocation_rule', 'warehouse']
  LOOP
    PERFORM ensure_trigger(t::regclass, 'audit_trg',
      format('CREATE TRIGGER audit_trg AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t));
  END LOOP;
END $$;

-- PRD FR-USR-04: stock set by people (adjustment, count, initial stock), order cancellations asked by a
-- seller, and full data exports (requested and downloaded). Order movements (reserve, release, ship)
-- are in stock_movement only. Both tables are partitioned, so the triggers name the table.
SELECT ensure_trigger('stock_movement', 'audit_manual_trg',
  'CREATE TRIGGER audit_manual_trg AFTER INSERT ON stock_movement FOR EACH ROW
     WHEN (NEW.type IN (''adjustment'', ''count_apply'', ''migration_initial''))
     EXECUTE FUNCTION audit_row(''stock_movement'')');
SELECT ensure_trigger('order_event', 'audit_cancel_trg',
  'CREATE TRIGGER audit_cancel_trg AFTER INSERT ON order_event FOR EACH ROW
     WHEN (NEW.type = ''cancel_requested'')
     EXECUTE FUNCTION audit_row(''order_event'')');
SELECT ensure_trigger('data_export', 'audit_insert_trg',
  'CREATE TRIGGER audit_insert_trg AFTER INSERT ON data_export FOR EACH ROW EXECUTE FUNCTION audit_row()');
-- Moving to OmniSeller (FR-MIG-01, 06): who imported a file, who switched a store live and who undid it.
SELECT ensure_trigger('migration_job', 'audit_insert_trg',
  'CREATE TRIGGER audit_insert_trg AFTER INSERT ON migration_job FOR EACH ROW EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('store_cutover', 'audit_trg',
  'CREATE TRIGGER audit_trg AFTER INSERT OR UPDATE ON store_cutover FOR EACH ROW EXECUTE FUNCTION audit_row()');
-- Print agents (FR-SHP-17, backend doc 8.24): who paired, renamed, or revoked one. Heartbeats (last_seen_at,
-- printers) are left out, and so is the token hash.
SELECT ensure_trigger('device', 'audit_insert_trg',
  'CREATE TRIGGER audit_insert_trg AFTER INSERT ON device FOR EACH ROW EXECUTE FUNCTION audit_row(''device'', ''token_hash'')');
SELECT ensure_trigger('device', 'audit_upd_trg',
  'CREATE TRIGGER audit_upd_trg AFTER UPDATE ON device FOR EACH ROW
     WHEN ((OLD.name, OLD.warehouse_id, OLD.revoked_at, OLD.label_printer, OLD.document_printer)
           IS DISTINCT FROM (NEW.name, NEW.warehouse_id, NEW.revoked_at, NEW.label_printer, NEW.document_printer))
     EXECUTE FUNCTION audit_row(''device'', ''token_hash'')');
-- Courier handovers (FR-SHP-05): who opened, completed, or cancelled a manifest.
SELECT ensure_trigger('handover', 'audit_trg',
  'CREATE TRIGGER audit_trg AFTER INSERT OR UPDATE ON handover FOR EACH ROW EXECUTE FUNCTION audit_row()');
-- Copying listings (FR-PRD-13, backend doc 8.25): who copied which store where, and who published or
-- deleted a draft. Product content (descriptions, images, variants) stays out of the log.
SELECT ensure_trigger('listing_copy', 'audit_trg',
  'CREATE TRIGGER audit_trg AFTER INSERT OR UPDATE OF status ON listing_copy FOR EACH ROW
     EXECUTE FUNCTION audit_row(''listing_copy'', ''failures'', ''external_item_ids'')');
SELECT ensure_trigger('listing_draft', 'audit_trg',
  'CREATE TRIGGER audit_trg AFTER UPDATE OF status OR DELETE ON listing_draft FOR EACH ROW
     EXECUTE FUNCTION audit_row(''listing_draft'', ''description'', ''description_html'', ''attributes'', ''images'',
                                ''size_chart'', ''variants'', ''source'', ''problems'')');
-- Returns (FR-RET-02, 03; backend doc 8.26): who answered a request and how, and who received the goods.
-- The buyer's reason and photos, the seller's comment and contact email, and the photos stay out of the log.
SELECT ensure_trigger('return_request', 'audit_trg',
  'CREATE TRIGGER audit_trg AFTER UPDATE OF response_status, received_at ON return_request FOR EACH ROW
     WHEN ((OLD.response_status, OLD.received_at) IS DISTINCT FROM (NEW.response_status, NEW.received_at))
     EXECUTE FUNCTION audit_row(''return_request'', ''reason'', ''evidence'', ''decisions'', ''response'',
                                ''seller_evidence'')');
-- Stock counts and transfers (FR-STK-08, 09; backend doc 8.27): who started, sent for review, approved,
-- sent, received, or cancelled them. The stock itself is in the audited count_apply movements.
SELECT ensure_trigger('stock_count', 'audit_trg',
  'CREATE TRIGGER audit_trg AFTER INSERT OR UPDATE OF status, apply_requested_at ON stock_count FOR EACH ROW
     EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('stock_transfer', 'audit_trg',
  'CREATE TRIGGER audit_trg AFTER INSERT OR UPDATE OF status ON stock_transfer FOR EACH ROW EXECUTE FUNCTION audit_row()');
-- Users (backend doc 8.30): disabling and re-enabling an account, and turning verification in two steps on
-- or off (by the user, or reset by an Owner). Secrets and login bookkeeping never reach the log.
SELECT ensure_trigger('user', 'audit_trg',
  'CREATE TRIGGER audit_trg AFTER UPDATE OF status, totp_enabled ON "user" FOR EACH ROW
     WHEN ((OLD.status, OLD.totp_enabled) IS DISTINCT FROM (NEW.status, NEW.totp_enabled))
     EXECUTE FUNCTION audit_row(''user'', ''password_hash'', ''totp_secret_enc'', ''totp_backup_codes'',
       ''totp_last_step'', ''failed_login_count'', ''locked_until'', ''last_login_at'')');
-- Business profile and legal documents (backend doc 8.29): who changed the NIB, NPWP, PKP status, address,
-- phone, or logo, and who uploaded, renewed, or removed a document. Reminder bookkeeping stays out.
SELECT ensure_trigger('business_profile', 'audit_trg',
  'CREATE TRIGGER audit_trg AFTER INSERT OR UPDATE OF address, phone, logo_file_id, nib, nib_in_process_since, npwp, pkp
     OR DELETE ON business_profile FOR EACH ROW EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('business_document', 'audit_trg',
  'CREATE TRIGGER audit_trg AFTER INSERT OR UPDATE OF kind, title, number, issued_on, valid_until, file_object_id
     OR DELETE ON business_document FOR EACH ROW EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('data_export', 'audit_download_trg',
  'CREATE TRIGGER audit_download_trg AFTER UPDATE ON data_export FOR EACH ROW
     WHEN (OLD.download_count IS DISTINCT FROM NEW.download_count)
     EXECUTE FUNCTION audit_row()');

SELECT ensure_trigger('audit_log', 'audit_log_immutable_trg',
  'CREATE TRIGGER audit_log_immutable_trg BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()');

SELECT ensure_trigger('outbox_event', 'outbox_notify_trg',
  'CREATE TRIGGER outbox_notify_trg AFTER INSERT ON outbox_event FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify()');
