-- 0027_account_closure: a business closes its own account (PRD 12.1, backend doc 8.36). For 30 days it
-- stays read only for whoever manages billing (export, reopen); then the tenant purge deletes its data,
-- except invoices and the subscriptions they bill, which tax records keep. The tenant row stays as
-- their owner, renamed, with the times of its closure.
ALTER TABLE tenant
  ADD COLUMN closing_at timestamptz,
  -- who closed it; no FK, because the user goes with the business's data
  ADD COLUMN closed_by ulid,
  ADD COLUMN purge_after timestamptz,
  ADD COLUMN purge_reminded_at timestamptz,
  ADD COLUMN purged_at timestamptz,
  ADD CONSTRAINT tenant_closing_ck CHECK (status <> 'closing' OR (closing_at IS NOT NULL AND purge_after IS NOT NULL)),
  ADD CONSTRAINT tenant_active_ck CHECK (status <> 'active' OR (closing_at IS NULL AND purge_after IS NULL AND purged_at IS NULL));

-- The purge deletes a business's rows table by table, finding them by tenant_id: these tables had no
-- index leading with it (test/schema checks every table the purge walks).
CREATE INDEX order_event_tenant_idx ON order_event (tenant_id, id);
CREATE INDEX order_external_ref_tenant_idx ON order_external_ref (tenant_id, id);
CREATE INDEX order_problem_tenant_idx ON order_problem (tenant_id, id);
CREATE INDEX store_credential_tenant_idx ON store_credential (tenant_id, id);
CREATE INDEX sync_cursor_tenant_idx ON sync_cursor (tenant_id, id);
CREATE INDEX webhook_inbox_tenant_idx ON webhook_inbox (tenant_id, received_at);
