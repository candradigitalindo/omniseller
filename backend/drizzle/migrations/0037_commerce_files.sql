-- Temporary input media is tied to an operation and a tenant-owned seller/creator principal.
CREATE TABLE commerce_file (
 id ulid PRIMARY KEY, tenant_id ulid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),row_version integer NOT NULL DEFAULT 1,
 operation_id text NOT NULL,principal_kind text NOT NULL CHECK(principal_kind IN('seller','creator','affiliate_partner')),
 store_id ulid,account_id ulid,file_id ulid,created_by ulid,
 filename text NOT NULL,mime text NOT NULL,size_bytes bigint NOT NULL CHECK(size_bytes>0 AND size_bytes<=524288000),expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,id),
 CHECK((principal_kind='seller' AND store_id IS NOT NULL AND account_id IS NULL) OR(principal_kind<>'seller' AND store_id IS NULL AND account_id IS NOT NULL)),
 FOREIGN KEY(tenant_id,store_id) REFERENCES store(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,account_id) REFERENCES affiliate_account(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,file_id) REFERENCES file_object(tenant_id,id) ON DELETE SET NULL(file_id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES "user"(tenant_id,id) ON DELETE SET NULL(created_by)
);
CREATE INDEX commerce_file_expiry_idx ON commerce_file(tenant_id,expires_at);
