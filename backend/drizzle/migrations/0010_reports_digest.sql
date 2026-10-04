-- 0010_reports_digest: the daily operational email and notification preferences (PRD FR-NTF-02;
-- backend doc 7.8.12, 8.20). Sales reports and the restock list read existing tables.

-- What a user wants to receive per kind of notification (UI L44). A missing row means the default of
-- that kind: in-app always on; the daily email on for users who may see sales (report:read).
CREATE TABLE notification_preference (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  user_id     ulid NOT NULL,
  kind        text NOT NULL CHECK (kind ~ '^[a-z_]+(\.[a-z_]+)+$'),
  in_app      boolean NOT NULL DEFAULT true,
  email       boolean NOT NULL DEFAULT false,
  whatsapp    boolean NOT NULL DEFAULT false,
  CONSTRAINT notification_preference_tenant_id_id_uq UNIQUE (tenant_id, id),
  -- a person's preferences go with them
  CONSTRAINT notification_preference_user_fk FOREIGN KEY (tenant_id, user_id)
    REFERENCES "user" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT notification_preference_user_kind_uq UNIQUE (tenant_id, user_id, kind)
);

-- One daily operational email run per business and local date: the run's key, so a retried or
-- repeated scan never mails twice.
CREATE TABLE daily_digest (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  digest_date date NOT NULL,                                  -- the business's local date it was sent on
  recipients  integer NOT NULL DEFAULT 0 CHECK (recipients >= 0),
  CONSTRAINT daily_digest_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT daily_digest_tenant_date_uq UNIQUE (tenant_id, digest_date)
);
