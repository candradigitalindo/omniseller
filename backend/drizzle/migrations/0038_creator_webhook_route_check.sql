-- Account routing must retain both the normalized external principal and its tenant.
-- Kept separate from the already-applied creator deauthorization migration.
ALTER TABLE webhook_inbox
 ADD CONSTRAINT webhook_inbox_account_route_check CHECK
   (account_id IS NULL OR (external_account_id IS NOT NULL AND tenant_id IS NOT NULL));
