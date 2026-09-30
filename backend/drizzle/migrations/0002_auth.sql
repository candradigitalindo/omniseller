-- 0002_auth: invitations sent by the worker, password reset tokens (backend doc 7.8.1, 8.1).
--
-- Tokens are created by the job that sends the email, not by the request that asks for it: the raw
-- token then never sits in outbox_event (kept 7 days), and a retried send simply issues a new token
-- that replaces the previous one. token_hash is therefore NULL until the first send.

ALTER TABLE invitation ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE invitation ADD COLUMN sent_at timestamptz;
ALTER TABLE invitation ADD COLUMN revoked_at timestamptz;
-- one open invitation per email per tenant; resending reuses it
CREATE UNIQUE INDEX invitation_open_email_uq ON invitation (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE password_reset_token (
  id          ulid PRIMARY KEY,
  tenant_id   ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  user_id     ulid NOT NULL,
  token_hash  text UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  CONSTRAINT password_reset_token_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES "user" (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX password_reset_token_tenant_user_idx ON password_reset_token (tenant_id, user_id);
