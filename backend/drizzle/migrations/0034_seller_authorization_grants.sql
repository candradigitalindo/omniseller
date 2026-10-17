-- Durable seller token grants: API reads metadata only, worker resumes discovery after a retry.
ALTER TABLE store_authorization ADD COLUMN grant_enc bytea;
ALTER TABLE store_authorization ADD COLUMN grant_dek_version integer;
ALTER TABLE store_authorization ADD CONSTRAINT store_authorization_grant_pair_ck
 CHECK ((grant_enc IS NULL) = (grant_dek_version IS NULL));
ALTER TABLE store_authorization ADD CONSTRAINT store_authorization_grant_key_fk
 FOREIGN KEY (tenant_id,grant_dek_version) REFERENCES tenant_key(tenant_id,version) ON DELETE RESTRICT;
