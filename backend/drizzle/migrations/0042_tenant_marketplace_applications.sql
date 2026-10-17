-- Application credentials belong to a business, separately from worker-only OAuth tokens.
CREATE TABLE marketplace_application (
 id ulid PRIMARY KEY,tenant_id ulid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),row_version integer NOT NULL DEFAULT 1,
 channel text NOT NULL CHECK(channel IN ('shopee','tiktokshop')),
 environment text NOT NULL DEFAULT 'production' CHECK(environment IN ('production','sandbox')),
 enabled boolean NOT NULL DEFAULT true,
 partner_id text,app_key text,service_id text,secret_enc bytea,
 CONSTRAINT marketplace_application_tenant_id_id_uq UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,channel),
 CHECK(channel='shopee' OR environment='production'),
 CHECK(NOT enabled OR (secret_enc IS NOT NULL AND
  ((channel='shopee' AND partner_id IS NOT NULL AND partner_id ~ '^[1-9][0-9]{0,14}$' AND app_key IS NULL AND service_id IS NULL) OR
   (channel='tiktokshop' AND coalesce(length(app_key),0)>0 AND coalesce(length(service_id),0)>0 AND partner_id IS NULL))))
);
ALTER TABLE webhook_inbox ADD COLUMN application_id ulid;
ALTER TABLE webhook_inbox ADD CONSTRAINT webhook_inbox_application_fk
 FOREIGN KEY(tenant_id,application_id) REFERENCES marketplace_application(tenant_id,id) ON DELETE RESTRICT;
