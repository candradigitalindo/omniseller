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

-- Inventory guard
SELECT ensure_trigger('inventory', 'inventory_guard_trg',
  'CREATE TRIGGER inventory_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON inventory FOR EACH ROW EXECUTE FUNCTION inventory_guard()');

-- Audit on sensitive tables (backend doc 7.7). Frequently synced tables audit only the columns that matter.
SELECT ensure_trigger('variant', 'audit_insdel_trg',
  'CREATE TRIGGER audit_insdel_trg AFTER INSERT OR DELETE ON variant FOR EACH ROW EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('variant', 'audit_upd_trg',
  'CREATE TRIGGER audit_upd_trg AFTER UPDATE ON variant FOR EACH ROW
     WHEN ((OLD.cost_price, OLD.base_price, OLD.status) IS DISTINCT FROM (NEW.cost_price, NEW.base_price, NEW.status))
     EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('product', 'audit_insdel_trg',
  'CREATE TRIGGER audit_insdel_trg AFTER INSERT OR DELETE ON product FOR EACH ROW EXECUTE FUNCTION audit_row()');
SELECT ensure_trigger('product', 'audit_upd_trg',
  'CREATE TRIGGER audit_upd_trg AFTER UPDATE ON product FOR EACH ROW
     WHEN ((OLD.name, OLD.sku, OLD.status, OLD.deleted_at) IS DISTINCT FROM (NEW.name, NEW.sku, NEW.status, NEW.deleted_at))
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
                           'channel_warehouse', 'stock_allocation_rule']
  LOOP
    PERFORM ensure_trigger(t::regclass, 'audit_trg',
      format('CREATE TRIGGER audit_trg AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row()', t));
  END LOOP;
END $$;

SELECT ensure_trigger('audit_log', 'audit_log_immutable_trg',
  'CREATE TRIGGER audit_log_immutable_trg BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()');

SELECT ensure_trigger('outbox_event', 'outbox_notify_trg',
  'CREATE TRIGGER outbox_notify_trg AFTER INSERT ON outbox_event FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify()');
