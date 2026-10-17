-- Reviewed commerce requests retain a single bounded page for at most 24 hours.
CREATE TABLE commerce_operation_status_transition (
 id ulid PRIMARY KEY, from_status text NOT NULL, to_status text NOT NULL,
 via text NOT NULL DEFAULT 'any' CHECK(via IN('any','marketplace')),
 UNIQUE(from_status,to_status), CHECK(from_status<>to_status)
);
CREATE TABLE commerce_operation (
 id ulid PRIMARY KEY, tenant_id ulid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 row_version integer NOT NULL DEFAULT 1,
 operation_id text NOT NULL, principal_kind text NOT NULL CHECK(principal_kind IN('seller','creator','affiliate_partner')),
 store_id ulid, account_id ulid, requested_by ulid,
 is_write boolean NOT NULL, input jsonb NOT NULL CHECK(jsonb_typeof(input)='object' AND octet_length(input::text)<=65536),
 result jsonb CHECK(result IS NULL OR octet_length(result::text)<=262144),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','succeeded','failed','uncertain')),
 status_changed_at timestamptz NOT NULL DEFAULT now(),
 claim_id ulid, claimed_at timestamptz, dispatched_at timestamptz,
 error_code text, error_message text, finished_at timestamptz, expires_at timestamptz NOT NULL,
 CONSTRAINT commerce_operation_tenant_id_id_uq UNIQUE(tenant_id,id),
 CHECK((principal_kind='seller' AND store_id IS NOT NULL AND account_id IS NULL) OR
       (principal_kind<>'seller' AND store_id IS NULL AND account_id IS NOT NULL)),
 FOREIGN KEY(tenant_id,store_id) REFERENCES store(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,account_id) REFERENCES affiliate_account(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,requested_by) REFERENCES "user"(tenant_id,id) ON DELETE SET NULL(requested_by)
);
CREATE INDEX commerce_operation_recent_idx ON commerce_operation(tenant_id,id DESC);
CREATE INDEX commerce_operation_expiry_idx ON commerce_operation(tenant_id,expires_at);
CREATE INDEX commerce_operation_due_idx ON commerce_operation(expires_at,id)
 WHERE input <> '{}'::jsonb OR result IS NOT NULL;
