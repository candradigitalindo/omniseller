------------------------------------------------------------------------------------------------
-- Deleting a closed business (backend doc 8.36, runbook 16.6). The worker's job tenant.purge calls
-- these SECURITY DEFINER functions, so it needs no BYPASSRLS credentials; each refuses a business that
-- is not closed and past its purge date. The worker deletes the stored files itself (prefix t/<id>/).
------------------------------------------------------------------------------------------------

-- Rows that outlive the business: tax records, the invoices and the subscriptions they bill.
CREATE OR REPLACE FUNCTION tenant_kept_tables() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['invoice', 'subscription']::text[]
$$;

-- Every table holding a business's rows (it has tenant_id), except the kept ones and the outbox (its
-- published events go by retention.run within 7 days; begin_tenant_purge deletes the waiting ones).
-- `depth`: every table comes before the tables it references (restrict or cascade; a SET NULL reference
-- orders nothing), so a referencing row is always gone before the row it points to. A new table joins by
-- itself; test/schema checks the order and that each table has an index leading with tenant_id.
CREATE OR REPLACE FUNCTION tenant_purge_order() RETURNS TABLE (table_name text, depth integer)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE t AS (
    SELECT c.oid, c.relname::text AS relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       AND c.relname::text <> ALL (tenant_kept_tables() || ARRAY['outbox_event'])
  ), e AS (
    SELECT DISTINCT k.conrelid AS child, k.confrelid AS parent
      FROM pg_constraint k
     WHERE k.contype = 'f' AND k.conrelid <> k.confrelid AND k.confdeltype IN ('a', 'r', 'c')
       AND k.conrelid IN (SELECT oid FROM t) AND k.confrelid IN (SELECT oid FROM t)
  ), d (oid, depth) AS (
    SELECT oid, 0 FROM t
    UNION
    SELECT e.parent, d.depth + 1 FROM d JOIN e ON e.child = d.oid WHERE d.depth < 64
  )
  SELECT t.relname, max(d.depth)::integer FROM d JOIN t ON t.oid = d.oid GROUP BY t.relname
$$;

-- Starts deleting a business closing past its purge date: from now on nobody signs in (status closed),
-- and its events still waiting in the outbox go. True while something is left to delete, also when an
-- earlier run stopped for time.
CREATE OR REPLACE FUNCTION begin_tenant_purge(p_tenant text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM set_config('app.purge_tenant', p_tenant, true);
  UPDATE tenant SET status = 'closed', updated_at = now()
   WHERE id = p_tenant AND status = 'closing' AND purge_after <= now();
  IF NOT EXISTS (SELECT 1 FROM tenant
                  WHERE id = p_tenant AND status = 'closed' AND purge_after <= now() AND purged_at IS NULL) THEN
    RETURN false;
  END IF;
  DELETE FROM outbox_event WHERE tenant_id = p_tenant AND published_at IS NULL;
  RETURN true;
END $$;

-- Deletes up to p_limit of the business's rows from one table of the purge order. Returns how many
-- went; fewer than p_limit means the table is done.
CREATE OR REPLACE FUNCTION purge_tenant_step(p_tenant text, p_table text, p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant
                  WHERE id = p_tenant AND status = 'closed' AND purge_after <= now() AND purged_at IS NULL) THEN
    RAISE EXCEPTION 'TENANT_NOT_PURGEABLE' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_purge_order() o WHERE o.table_name = p_table) THEN
    RAISE EXCEPTION 'TABLE_NOT_PURGED: %', p_table USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- no history about the rows that go (audit_row, audit_log_immutable), and stock rows may go
  PERFORM set_config('app.purge_tenant', p_tenant, true);
  PERFORM set_config('app.stock_write', 'on', true);
  EXECUTE format(
    'DELETE FROM %I WHERE (tenant_id, id) IN (SELECT tenant_id, id FROM %I WHERE tenant_id = $1 LIMIT $2)',
    p_table, p_table) USING p_tenant, p_limit;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Ends the purge once no table holds the business's rows: the tenant row stays for its invoices, with
-- its name, address, and settings gone. False while anything is left.
CREATE OR REPLACE FUNCTION finish_tenant_purge(p_tenant text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_table text;
  v_left boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant
                  WHERE id = p_tenant AND status = 'closed' AND purge_after <= now() AND purged_at IS NULL) THEN
    RETURN false;
  END IF;
  FOR v_table IN SELECT o.table_name FROM tenant_purge_order() o LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE tenant_id = $1)', v_table) INTO v_left USING p_tenant;
    IF v_left THEN
      RETURN false;
    END IF;
  END LOOP;
  PERFORM set_config('app.purge_tenant', p_tenant, true);
  UPDATE tenant
     SET purged_at = now(), name = 'Bisnis dihapus', slug = 'dihapus-' || lower(id), legal = '{}',
         settings = '{}', closed_by = NULL, updated_at = now()
   WHERE id = p_tenant;
  RETURN true;
END $$;
