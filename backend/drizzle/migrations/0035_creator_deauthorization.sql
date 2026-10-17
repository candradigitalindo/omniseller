-- Creator notifications carry creator_open_id, not a seller shop. Preserve inbox deduplication.
ALTER TABLE webhook_inbox
 ADD COLUMN external_account_kind text CHECK (external_account_kind IN ('creator','affiliate_partner')),
 ADD COLUMN external_account_id text,
 ADD COLUMN account_id ulid,
 ADD COLUMN occurred_at timestamptz,
 ADD CONSTRAINT webhook_inbox_account_identity_check CHECK
   ((external_account_kind IS NULL)=(external_account_id IS NULL)),
 ADD CONSTRAINT webhook_inbox_one_principal_check CHECK (account_id IS NULL OR store_id IS NULL);
CREATE INDEX webhook_inbox_account_revocation_idx
 ON webhook_inbox(source,external_account_kind,external_account_id,occurred_at DESC)
 WHERE signature_valid AND event_type='CREATOR_DEAUTHORIZATION';
