-- Creator/partner principals are not seller stores. Staged OAuth grants survive a worker restart.
CREATE TABLE affiliate_account_status_transition (
 id ulid PRIMARY KEY,from_status text NOT NULL,to_status text NOT NULL,
 via text NOT NULL DEFAULT 'any' CHECK(via IN ('any','marketplace')),
 UNIQUE(from_status,to_status),CHECK(from_status<>to_status)
);
CREATE TABLE affiliate_authorization_status_transition (
 id ulid PRIMARY KEY,from_status text NOT NULL,to_status text NOT NULL,
 via text NOT NULL DEFAULT 'any' CHECK(via IN ('any','marketplace')),
 UNIQUE(from_status,to_status),CHECK(from_status<>to_status)
);
CREATE TABLE affiliate_account (
 id ulid PRIMARY KEY,tenant_id ulid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),row_version integer NOT NULL DEFAULT 1,
 kind text NOT NULL CHECK(kind IN ('creator','affiliate_partner')),
 external_principal_id text NOT NULL,
 name text NOT NULL,region text NOT NULL DEFAULT 'ID' CHECK(region='ID'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','verifying','reauth_required','disconnected')),
 status_changed_at timestamptz NOT NULL DEFAULT now(),
 scopes text[] NOT NULL DEFAULT '{}',profile jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(profile)='object'),
 connected_at timestamptz NOT NULL DEFAULT now(),disconnected_at timestamptz,
 access_expires_at timestamptz,authorization_expires_at timestamptz,last_refreshed_at timestamptz,
 error_code text,error_message text,
 CONSTRAINT affiliate_account_tenant_id_id_uq UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,kind,external_principal_id)
);
CREATE UNIQUE INDEX affiliate_account_active_owner_uq ON affiliate_account(kind,external_principal_id) WHERE status<>'disconnected';
CREATE INDEX affiliate_account_tenant_status_idx ON affiliate_account(tenant_id,status,id);
CREATE TABLE affiliate_account_credential (
 id ulid PRIMARY KEY,tenant_id ulid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),row_version integer NOT NULL DEFAULT 1,
 account_id ulid NOT NULL,access_token_enc bytea NOT NULL,refresh_token_enc bytea NOT NULL,
 dek_version integer NOT NULL,
 category_assets jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(category_assets)='array'),
 CONSTRAINT affiliate_account_credential_tenant_id_id_uq UNIQUE(tenant_id,id),UNIQUE(account_id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES affiliate_account(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,dek_version) REFERENCES tenant_key(tenant_id,version) ON DELETE RESTRICT
);
CREATE TABLE affiliate_authorization (
 id ulid PRIMARY KEY,tenant_id ulid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),row_version integer NOT NULL DEFAULT 1,
 kind text NOT NULL CHECK(kind IN ('creator','affiliate_partner')),
 account_id ulid,requested_by ulid,state_hash text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','exchanging','verifying','succeeded','failed','expired')),
 status_changed_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 callback_at timestamptz,completed_at timestamptz,error_code text,error_message text,
 claim_id ulid,claimed_at timestamptz,
 external_principal_id text,grant_access_token_enc bytea,grant_refresh_token_enc bytea,grant_dek_version integer,
 grant_access_expires_at timestamptz,grant_refresh_expires_at timestamptz,grant_scopes text[],
 CONSTRAINT affiliate_authorization_tenant_id_id_uq UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,account_id) REFERENCES affiliate_account(tenant_id,id) ON DELETE SET NULL(account_id),
 FOREIGN KEY(tenant_id,requested_by) REFERENCES "user"(tenant_id,id) ON DELETE SET NULL(requested_by),
 FOREIGN KEY(tenant_id,grant_dek_version) REFERENCES tenant_key(tenant_id,version) ON DELETE RESTRICT,
 CHECK((grant_access_token_enc IS NULL)=(grant_refresh_token_enc IS NULL)),
 CHECK((grant_access_token_enc IS NULL)=(grant_dek_version IS NULL)),
 CHECK(status<>'verifying' OR (grant_access_token_enc IS NOT NULL AND external_principal_id IS NOT NULL AND grant_access_expires_at IS NOT NULL AND grant_refresh_expires_at IS NOT NULL AND grant_scopes IS NOT NULL))
);
CREATE INDEX affiliate_authorization_tenant_idx ON affiliate_authorization(tenant_id,id DESC);
