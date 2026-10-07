-- 0020_two_factor: verification in two steps with an authenticator app (PRD FR-USR-05, technology doc
-- 5.3; UI L41b and L49; backend doc 8.30). `totp_secret_enc` and `totp_enabled` exist since 0001. The
-- secret is sealed with the api's TOTP key, not a tenant DEK: login runs in the api, which never holds
-- KMS (ADR-029). A secret set up but not yet confirmed sits in `totp_secret_enc` with `totp_enabled`
-- false.

ALTER TABLE "user"
  -- HMAC of each unused backup code; a code is removed when it is used
  ADD COLUMN totp_backup_codes text[] NOT NULL DEFAULT '{}',
  -- the last time step a code was accepted for: the same code cannot sign in twice
  ADD COLUMN totp_last_step bigint,
  ADD COLUMN totp_enabled_at timestamptz;

ALTER TABLE "user"
  ADD CONSTRAINT user_totp_backup_codes_max CHECK (cardinality(totp_backup_codes) <= 10),
  ADD CONSTRAINT user_totp_enabled_secret CHECK (NOT totp_enabled OR (totp_secret_enc IS NOT NULL AND totp_enabled_at IS NOT NULL));
