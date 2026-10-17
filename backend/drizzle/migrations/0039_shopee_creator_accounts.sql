-- Add a distinct Shopee user authorization namespace without sharing seller/partner credentials.
ALTER TABLE affiliate_account
 ADD COLUMN channel text NOT NULL DEFAULT 'tiktokshop' CHECK(channel IN ('tiktokshop','shopee')),
 ADD COLUMN program text NOT NULL DEFAULT 'standard' CHECK(program IN ('standard','video','live')),
 ADD COLUMN region_verified boolean NOT NULL DEFAULT true,
 ADD CONSTRAINT affiliate_account_program_channel_ck CHECK(
  (channel='tiktokshop' AND program='standard') OR (channel='shopee' AND kind='creator' AND program IN ('video','live'))
 );
ALTER TABLE affiliate_authorization
 ADD COLUMN channel text NOT NULL DEFAULT 'tiktokshop' CHECK(channel IN ('tiktokshop','shopee')),
 ADD COLUMN program text NOT NULL DEFAULT 'standard' CHECK(program IN ('standard','video','live')),
 ADD CONSTRAINT affiliate_authorization_program_channel_ck CHECK(
  (channel='tiktokshop' AND program='standard') OR (channel='shopee' AND kind='creator' AND program IN ('video','live'))
 );
-- Both generations can read the new fields; replacing identity indexes changes no existing identity.
CREATE UNIQUE INDEX affiliate_account_channel_principal_uq ON affiliate_account(tenant_id,channel,kind,external_principal_id);
CREATE UNIQUE INDEX affiliate_account_channel_active_owner_uq ON affiliate_account(channel,kind,external_principal_id) WHERE status<>'disconnected';
ALTER TABLE affiliate_account DROP CONSTRAINT affiliate_account_tenant_id_kind_external_principal_id_key;
DROP INDEX affiliate_account_active_owner_uq;
