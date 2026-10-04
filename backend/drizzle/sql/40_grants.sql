-- Repeatable: exact privileges per role (backend doc 7.5). Runs in the same transaction as the other
-- repeatable files, so the REVOKE-then-GRANT reset is never visible half-done.
--
--   omniseller_api     RLS enforced. Serves api and webhook. Cannot read marketplace tokens.
--   omniseller_worker  RLS enforced. worker, research-collector, per-tenant scheduler jobs. Reads tokens.
--   omniseller_system  BYPASSRLS. Only registered cross-tenant scheduler jobs.
-- Partitions and schema_migration are never granted.

GRANT USAGE ON SCHEMA public TO omniseller_api, omniseller_worker, omniseller_system;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND c.relname NOT IN ('schema_migration')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %I FROM omniseller_api, omniseller_worker, omniseller_system, PUBLIC', r.relname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO omniseller_api, omniseller_worker, omniseller_system', r.relname);
  END LOOP;
END $$;

-- Global reference data: read only for the app; changed by seeds and migrations.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plan', 'permission', 'feature_flag',
                           'order_status_transition', 'shipment_status_transition', 'sync_job_status_transition',
                           'document_job_status_transition', 'data_export_status_transition',
                           'migration_job_status_transition', 'store_cutover_status_transition',
                           'print_job_status_transition', 'handover_status_transition',
                           'listing_copy_status_transition', 'listing_draft_status_transition',
                           'return_request_status_transition', 'stock_count_status_transition',
                           'stock_transfer_status_transition']
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON TABLE %I FROM omniseller_api, omniseller_worker, omniseller_system', t);
  END LOOP;
END $$;

-- tenant: no deletes from the app (purge is a system job)
REVOKE DELETE ON TABLE tenant FROM omniseller_api, omniseller_worker;

-- Marketplace tokens: api can see expiry metadata only and cannot write credentials at all.
-- The OAuth code exchange and token encryption run in the worker (backend doc 8.6).
REVOKE ALL ON TABLE store_credential FROM omniseller_api;
GRANT SELECT (id, tenant_id, created_at, updated_at, row_version, store_id, dek_version,
              access_expires_at, refresh_expires_at, scopes, last_refreshed_at, refresh_fail_count)
  ON TABLE store_credential TO omniseller_api;
-- Disconnecting a store deletes its tokens at once; deleting needs no read access to them.
GRANT DELETE ON TABLE store_credential TO omniseller_api;

-- Tenant data encryption keys (technology doc 19.3): created and unwrapped by the worker only.
REVOKE ALL ON TABLE tenant_key FROM omniseller_api;
REVOKE DELETE ON TABLE tenant_key FROM omniseller_worker;

-- Stock: quantities only via apply_stock_movement / ensure_inventory (SECURITY DEFINER).
REVOKE INSERT, UPDATE, DELETE ON TABLE inventory FROM omniseller_api, omniseller_worker;
GRANT UPDATE (bin_location, min_stock, stock_alert) ON TABLE inventory TO omniseller_api, omniseller_worker;
REVOKE INSERT, UPDATE, DELETE ON TABLE stock_movement FROM omniseller_api, omniseller_worker;
REVOKE UPDATE ON TABLE stock_movement FROM omniseller_system;

-- Views a module exports for others to read (backend doc 11). security_invoker: the caller's RLS applies.
GRANT SELECT ON catalog_variant_v TO omniseller_api, omniseller_worker;

-- Append-only history
REVOKE UPDATE, DELETE ON TABLE order_event FROM omniseller_api, omniseller_worker;
REVOKE UPDATE ON TABLE order_external_ref FROM omniseller_api, omniseller_worker;
REVOKE INSERT, UPDATE, DELETE ON TABLE audit_log FROM omniseller_api, omniseller_worker;
REVOKE INSERT, UPDATE ON TABLE audit_log FROM omniseller_system;

-- Webhook inbox: api (webhook process) inserts and learns whether the event is new; the worker processes.
REVOKE ALL ON TABLE webhook_inbox FROM omniseller_api;
GRANT INSERT ON TABLE webhook_inbox TO omniseller_api;
GRANT SELECT (id, source, event_id) ON TABLE webhook_inbox TO omniseller_api;
REVOKE INSERT, DELETE ON TABLE webhook_inbox FROM omniseller_worker;

-- Outbox: the app only appends; the relay (system) reads, marks, and deletes.
REVOKE SELECT, UPDATE, DELETE ON TABLE outbox_event FROM omniseller_api, omniseller_worker;

-- SECURITY DEFINER functions: nobody by default, then exactly the roles that need them.
REVOKE ALL ON FUNCTION ensure_inventory(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_stock_movement(text, text, text, text, text, bigint, bigint, bigint, bigint, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION confirm_stock(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_store(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_login_candidates(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_refresh_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_device(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_api_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_invitation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_password_reset(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION maintain_partitions(timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION ensure_inventory(text, text, text, text) TO omniseller_api, omniseller_worker;
GRANT EXECUTE ON FUNCTION apply_stock_movement(text, text, text, text, text, bigint, bigint, bigint, bigint, text, text, text, text, text) TO omniseller_api, omniseller_worker;
GRANT EXECUTE ON FUNCTION confirm_stock(text, text, text) TO omniseller_api, omniseller_worker;
GRANT EXECUTE ON FUNCTION resolve_store(text, text) TO omniseller_api, omniseller_worker;
GRANT EXECUTE ON FUNCTION auth_login_candidates(text) TO omniseller_api;
GRANT EXECUTE ON FUNCTION auth_resolve_refresh_token(text) TO omniseller_api;
GRANT EXECUTE ON FUNCTION auth_resolve_device(text) TO omniseller_api;
GRANT EXECUTE ON FUNCTION auth_resolve_api_key(text) TO omniseller_api;
GRANT EXECUTE ON FUNCTION auth_resolve_invitation(text) TO omniseller_api;
GRANT EXECUTE ON FUNCTION auth_resolve_password_reset(text) TO omniseller_api;
GRANT EXECUTE ON FUNCTION maintain_partitions(timestamptz) TO omniseller_system;
