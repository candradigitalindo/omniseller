-- Repeatable: RLS on every parent table that has tenant_id (backend doc 7.5).
-- Partitions are not granted to any application role, so they are reachable only through the parent,
-- where the policy applies. A missing or empty app.tenant_id matches no row.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       AND c.relname NOT IN ('webhook_inbox') -- global; written before the tenant is known
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', r.relname);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = r.relname AND policyname = 'tenant_isolation') THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) '
        'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', r.relname);
    END IF;
  END LOOP;
END $$;

-- tenant: a tenant sees and updates only itself. Signup inserts with app.tenant_id already set to the new id.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tenant' AND policyname = 'tenant_self') THEN
    CREATE POLICY tenant_self ON tenant
      USING (id = current_setting('app.tenant_id', true))
      WITH CHECK (id = current_setting('app.tenant_id', true));
  END IF;
END $$;
