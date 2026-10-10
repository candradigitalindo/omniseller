-- Repeatable: run on every db:migrate after versioned migrations. Everything here is CREATE OR REPLACE.
-- SECURITY DEFINER functions run as the schema owner (omniseller_migrator, BYPASSRLS), so each one
-- checks the tenant explicitly and pins search_path. EXECUTE on them is granted in 40_grants.sql.

------------------------------------------------------------------------------------------------
-- ULID helpers. Application code creates ids; these exist only for seeds of global reference
-- tables, audit rows, and partition bounds (backend doc 6.3).
------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ulid_time_prefix(p_at timestamptz) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  ms bigint := floor(extract(epoch FROM p_at) * 1000)::bigint;
  out text := '';
BEGIN
  FOR i IN 1..10 LOOP
    out := substr(alphabet, (ms % 32)::int + 1, 1) || out;
    ms := ms / 32;
  END LOOP;
  RETURN out;
END $$;

CREATE OR REPLACE FUNCTION ulid_lower_bound(p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT ulid_time_prefix(p_at) || '0000000000000000'
$$;

CREATE OR REPLACE FUNCTION gen_ulid() RETURNS text
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  -- 80 random bits taken from the fully random bytes of a v4 UUID (skipping version/variant bits)
  b bytea := uuid_send(gen_random_uuid());
  hi bigint;
  lo bigint;
  out text := '';
BEGIN
  hi := (get_byte(b, 0)::bigint << 32) | (get_byte(b, 1)::bigint << 24) | (get_byte(b, 2)::bigint << 16)
      | (get_byte(b, 3)::bigint << 8) | get_byte(b, 4)::bigint;
  lo := (get_byte(b, 10)::bigint << 32) | (get_byte(b, 11)::bigint << 24) | (get_byte(b, 12)::bigint << 16)
      | (get_byte(b, 13)::bigint << 8) | get_byte(b, 14)::bigint;
  FOR i IN 1..8 LOOP
    out := substr(alphabet, (lo % 32)::int + 1, 1) || out;
    lo := lo / 32;
  END LOOP;
  FOR i IN 1..8 LOOP
    out := substr(alphabet, (hi % 32)::int + 1, 1) || out;
    hi := hi / 32;
  END LOOP;
  RETURN ulid_time_prefix(clock_timestamp()) || out;
END $$;

------------------------------------------------------------------------------------------------
-- Row housekeeping
------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END $$;

------------------------------------------------------------------------------------------------
-- Status machines (backend doc 7.9). TG_ARGV[0] is the base table name: on a partitioned table
-- TG_TABLE_NAME is the partition (for example order_p202609), not the table the rules belong to.
-- Rows with via = 'marketplace' are allowed only when the transaction set app.status_source.
------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_table  text := TG_ARGV[0];
  v_source text := coalesce(nullif(current_setting('app.status_source', true), ''), 'app');
  v_ok     boolean;
BEGIN
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'STATUS_TRIGGER_MISCONFIGURED' USING DETAIL = TG_TABLE_NAME;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM %I WHERE from_status = $1 AND to_status = $2 AND (via = ''any'' OR via = $3))',
    v_table || '_status_transition'
  ) INTO v_ok USING OLD.status, NEW.status, v_source;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'INVALID_STATUS_TRANSITION' USING ERRCODE = 'check_violation',
      DETAIL = format('%s: %s -> %s (source %s)', v_table, OLD.status, NEW.status, v_source);
  END IF;
  NEW.status_changed_at := now();
  RETURN NEW;
END $$;

------------------------------------------------------------------------------------------------
-- Inventory: quantities change only through apply_stock_movement (invariant I2).
-- api/worker have no INSERT/DELETE and only column UPDATE (bin_location, min_stock) on inventory;
-- this guard is the second line for the owner and system roles.
------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION inventory_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_allowed boolean := current_setting('app.stock_write', true) = 'on';
BEGIN
  IF v_allowed THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE'
     OR (TG_OP = 'INSERT' AND (NEW.on_hand, NEW.reserved, NEW.buffer, NEW.damaged) <> (0, 0, 0, 0))
     OR (TG_OP = 'UPDATE' AND (NEW.on_hand, NEW.reserved, NEW.buffer, NEW.damaged)
                              IS DISTINCT FROM (OLD.on_hand, OLD.reserved, OLD.buffer, OLD.damaged)) THEN
    RAISE EXCEPTION 'INVENTORY_DIRECT_WRITE_FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION assert_tenant(p_tenant_id text) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '') THEN
    RAISE EXCEPTION 'TENANT_MISMATCH' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- Creates the zero row for (variant, warehouse) if missing and returns its id.
CREATE OR REPLACE FUNCTION ensure_inventory(p_id text, p_tenant_id text, p_variant_id text, p_warehouse_id text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id text;
BEGIN
  PERFORM assert_tenant(p_tenant_id);
  PERFORM set_config('app.stock_write', 'on', true);
  INSERT INTO inventory (id, tenant_id, variant_id, warehouse_id)
  VALUES (p_id, p_tenant_id, p_variant_id, p_warehouse_id)
  ON CONFLICT (tenant_id, variant_id, warehouse_id) DO NOTHING;
  PERFORM set_config('app.stock_write', 'off', true);
  SELECT id INTO v_id FROM inventory
   WHERE tenant_id = p_tenant_id AND variant_id = p_variant_id AND warehouse_id = p_warehouse_id;
  RETURN v_id;
END $$;

-- The only way to change stock quantities. Locks the inventory row, rejects results below zero,
-- and writes the ledger row with the resulting balances. A movement that establishes the quantity
-- (adjustment, stock count, initial stock) also sets stock_set_at: only established stock is pushed
-- to marketplaces (backend doc 9.4).
CREATE OR REPLACE FUNCTION apply_stock_movement(
  p_id text, p_tenant_id text, p_variant_id text, p_warehouse_id text, p_type text,
  p_on_hand_delta bigint, p_reserved_delta bigint, p_damaged_delta bigint, p_buffer_delta bigint,
  p_reference_type text, p_reference_id text, p_reason text, p_note text, p_actor_user_id text
) RETURNS stock_movement
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_inv inventory%ROWTYPE;
  v_mv  stock_movement%ROWTYPE;
BEGIN
  PERFORM assert_tenant(p_tenant_id);
  IF p_type = 'adjustment' AND coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'STOCK_REASON_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_inv FROM inventory
   WHERE tenant_id = p_tenant_id AND variant_id = p_variant_id AND warehouse_id = p_warehouse_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STOCK_INVENTORY_MISSING' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_inv.on_hand + p_on_hand_delta < 0
     OR v_inv.reserved + p_reserved_delta < 0
     OR v_inv.damaged + p_damaged_delta < 0
     OR v_inv.buffer + p_buffer_delta < 0 THEN
    RAISE EXCEPTION 'STOCK_INSUFFICIENT' USING ERRCODE = 'check_violation',
      DETAIL = format('on_hand=%s reserved=%s damaged=%s buffer=%s', v_inv.on_hand, v_inv.reserved, v_inv.damaged, v_inv.buffer);
  END IF;
  PERFORM set_config('app.stock_write', 'on', true);
  UPDATE inventory
     SET on_hand = on_hand + p_on_hand_delta,
         reserved = reserved + p_reserved_delta,
         damaged = damaged + p_damaged_delta,
         buffer = buffer + p_buffer_delta,
         stock_set_at = CASE WHEN p_type IN ('adjustment', 'count_apply', 'migration_initial') THEN now()
                             ELSE stock_set_at END
   WHERE id = v_inv.id
  RETURNING * INTO v_inv;
  PERFORM set_config('app.stock_write', 'off', true);
  INSERT INTO stock_movement (
    id, tenant_id, variant_id, warehouse_id, type,
    on_hand_delta, reserved_delta, damaged_delta, buffer_delta,
    on_hand_after, reserved_after, damaged_after, buffer_after,
    reference_type, reference_id, reason, note, actor_user_id
  ) VALUES (
    p_id, p_tenant_id, p_variant_id, p_warehouse_id, p_type,
    p_on_hand_delta, p_reserved_delta, p_damaged_delta, p_buffer_delta,
    v_inv.on_hand, v_inv.reserved, v_inv.damaged, v_inv.buffer,
    p_reference_type, p_reference_id, p_reason, p_note, p_actor_user_id
  ) RETURNING * INTO v_mv;
  RETURN v_mv;
END $$;

-- A person confirmed the quantity without changing it (an adjustment to the same number, initial stock
-- equal to what is recorded): the quantity counts as established from now on.
CREATE OR REPLACE FUNCTION confirm_stock(p_tenant_id text, p_variant_id text, p_warehouse_id text)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_at timestamptz;
BEGIN
  PERFORM assert_tenant(p_tenant_id);
  UPDATE inventory SET stock_set_at = now()
   WHERE tenant_id = p_tenant_id AND variant_id = p_variant_id AND warehouse_id = p_warehouse_id
  RETURNING stock_set_at INTO v_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STOCK_INVENTORY_MISSING' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN v_at;
END $$;

------------------------------------------------------------------------------------------------
-- Audit. Ids come from gen_ulid() here: one statement can touch many rows, so an id handed in
-- from the application per statement would collide. Actor comes from withTenantTx settings.
-- On a partitioned table TG_TABLE_NAME is the partition (stock_movement_p202610): its triggers
-- pass the table's own name as TG_ARGV[0], which becomes entity_type.
------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_entity     text := coalesce(TG_ARGV[0], TG_TABLE_NAME);
  v_actor_type text := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system');
  v_actor_id   text := nullif(current_setting('app.actor_id', true), '');
  v_request_id text := nullif(current_setting('app.request_id', true), '');
  v_tenant_id  text;
  v_entity_id  text;
  v_before     jsonb;
  v_after      jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tenant_id := OLD.tenant_id; v_entity_id := OLD.id; v_before := to_jsonb(OLD);
  ELSIF TG_OP = 'INSERT' THEN
    v_tenant_id := NEW.tenant_id; v_entity_id := NEW.id; v_after := to_jsonb(NEW);
  ELSE
    v_tenant_id := NEW.tenant_id; v_entity_id := NEW.id; v_before := to_jsonb(OLD); v_after := to_jsonb(NEW);
  END IF;
  -- The tenant purge deletes a closed business's rows and writes no history about them (backend doc 8.36).
  IF v_tenant_id = nullif(current_setting('app.purge_tenant', true), '') THEN
    RETURN NULL;
  END IF;
  -- Columns named after the entity never reach the log (a device's token hash).
  FOR i IN 1 .. TG_NARGS - 1 LOOP
    v_before := v_before - TG_ARGV[i];
    v_after := v_after - TG_ARGV[i];
  END LOOP;
  IF v_actor_type NOT IN ('user', 'system', 'api_key', 'device') THEN
    v_actor_type := 'system';
  END IF;
  INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, request_id, action, entity_type, entity_id, before, after)
  VALUES (gen_ulid(), v_tenant_id, v_actor_type, v_actor_id, v_request_id, lower(TG_OP), v_entity, v_entity_id, v_before, v_after);
  RETURN NULL; -- AFTER trigger
END $$;

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- the tenant purge deletes the log of the business it deletes, and nothing else (backend doc 8.36)
  IF TG_OP = 'DELETE' AND OLD.tenant_id = nullif(current_setting('app.purge_tenant', true), '') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AUDIT_LOG_IMMUTABLE' USING ERRCODE = 'insufficient_privilege';
END $$;

-- The tenant row has no tenant_id, so audit_row cannot log it: a closure and a reopening (status
-- changes) are written here, in the business's own log (backend doc 8.36).
CREATE OR REPLACE FUNCTION audit_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor_type text := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system');
BEGIN
  IF NEW.id = nullif(current_setting('app.purge_tenant', true), '') THEN
    RETURN NULL;
  END IF;
  IF v_actor_type NOT IN ('user', 'system', 'api_key', 'device') THEN
    v_actor_type := 'system';
  END IF;
  INSERT INTO audit_log (id, tenant_id, actor_type, actor_id, request_id, action, entity_type, entity_id, before, after)
  VALUES (gen_ulid(), NEW.id, v_actor_type, nullif(current_setting('app.actor_id', true), ''),
          nullif(current_setting('app.request_id', true), ''), 'update', 'tenant', NEW.id,
          jsonb_build_object('status', OLD.status, 'closing_at', OLD.closing_at, 'purge_after', OLD.purge_after),
          jsonb_build_object('status', NEW.status, 'closing_at', NEW.closing_at, 'purge_after', NEW.purge_after));
  RETURN NULL;
END $$;

------------------------------------------------------------------------------------------------
-- Outbox wake-up: one NOTIFY per statement; the relay listens on 'outbox'.
------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION outbox_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('outbox', '');
  RETURN NULL;
END $$;

------------------------------------------------------------------------------------------------
-- Lookups that must happen before the tenant is known. RLS returns zero rows without
-- app.tenant_id, so these narrow SECURITY DEFINER functions are the only cross-tenant reads
-- allowed to omniseller_api / omniseller_worker. Each returns the tenant so the caller can
-- continue inside withTenantTx.
------------------------------------------------------------------------------------------------

-- Webhook routing and shop ownership: (channel, marketplace shop id) -> tenant and store. Only one store
-- per shop is not disconnected (unique index); disconnected ones of this or other tenants may remain
-- (FR-INT-07), so the store in use wins, else the one disconnected last.
CREATE OR REPLACE FUNCTION resolve_store(p_channel text, p_external_shop_id text)
RETURNS TABLE (tenant_id text, store_id text, status text, sync_mode text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.tenant_id, s.id, s.status, s.sync_mode
    FROM store s
   WHERE s.channel = p_channel AND s.external_shop_id = p_external_shop_id
   ORDER BY s.status = 'disconnected', s.status_changed_at DESC
   LIMIT 1
$$;

-- Login: the same email may exist in several tenants; the caller picks or asks the user.
CREATE OR REPLACE FUNCTION auth_login_candidates(p_email text)
RETURNS TABLE (
  tenant_id text, tenant_slug text, tenant_name text, tenant_status text,
  user_id text, user_status text, password_hash text, totp_enabled boolean,
  failed_login_count integer, locked_until timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.slug, t.name, t.status, u.id, u.status, u.password_hash, u.totp_enabled,
         u.failed_login_count, u.locked_until
    FROM "user" u
    JOIN tenant t ON t.id = u.tenant_id
   WHERE u.email = p_email::citext
$$;

CREATE OR REPLACE FUNCTION auth_resolve_refresh_token(p_token_hash text)
RETURNS TABLE (tenant_id text, refresh_token_id text, user_id text, device_id text, expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.tenant_id, r.id, r.user_id, r.device_id, r.expires_at, r.revoked_at
    FROM refresh_token r WHERE r.token_hash = p_token_hash
$$;

-- Return type changed in 0014 (last_seen_at, tenant_status: the device guard checks the business in the
-- same lookup, backend doc 8.24); DROP first because CREATE OR REPLACE cannot change it.
DROP FUNCTION IF EXISTS auth_resolve_device(text);
CREATE FUNCTION auth_resolve_device(p_token_hash text)
RETURNS TABLE (tenant_id text, device_id text, kind text, warehouse_id text, revoked_at timestamptz,
               last_seen_at timestamptz, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.tenant_id, d.id, d.kind, d.warehouse_id, d.revoked_at, d.last_seen_at, t.status
    FROM device d JOIN tenant t ON t.id = d.tenant_id
   WHERE d.token_hash = p_token_hash
$$;

CREATE OR REPLACE FUNCTION auth_resolve_api_key(p_key_hash text)
RETURNS TABLE (tenant_id text, api_key_id text, scopes text[], revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.tenant_id, k.id, k.scopes, k.revoked_at
    FROM api_key k WHERE k.key_hash = p_key_hash
$$;

-- Return type changed in 0002 (revoked_at); DROP first because CREATE OR REPLACE cannot change it.
DROP FUNCTION IF EXISTS auth_resolve_invitation(text);
CREATE FUNCTION auth_resolve_invitation(p_token_hash text)
RETURNS TABLE (tenant_id text, invitation_id text, email text, role_id text, expires_at timestamptz,
               accepted_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.tenant_id, i.id, i.email::text, i.role_id, i.expires_at, i.accepted_at, i.revoked_at
    FROM invitation i WHERE i.token_hash = p_token_hash
$$;

CREATE OR REPLACE FUNCTION auth_resolve_password_reset(p_token_hash text)
RETURNS TABLE (tenant_id text, token_id text, user_id text, expires_at timestamptz, used_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.tenant_id, r.id, r.user_id, r.expires_at, r.used_at
    FROM password_reset_token r WHERE r.token_hash = p_token_hash
$$;

-- Xendit's invoice callback (backend doc 8.32): our invoice id is the invoice's external_id at Xendit.
-- The webhook process finds the tenant here and enqueues; the job applies it inside the tenant.
CREATE OR REPLACE FUNCTION billing_resolve_invoice(p_external_id text)
RETURNS TABLE (tenant_id text, invoice_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.tenant_id, i.id FROM invoice i WHERE i.id = p_external_id
$$;

------------------------------------------------------------------------------------------------
-- Partitions (backend doc 7.6). Monthly range partitions on id; bounds are ULID lower bounds of
-- the first millisecond of each UTC month. Creating a partition requires owning the parent,
-- hence SECURITY DEFINER; executed by the scheduler as omniseller_system and by db:migrate.
------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION partition_targets()
RETURNS TABLE (table_name text, ahead_months integer, retain_months integer, archive boolean)
LANGUAGE sql IMMUTABLE AS $$
  VALUES
    ('order', 3, 24, true),
    ('order_item', 3, 24, true),
    ('order_event', 3, 24, true),
    ('stock_movement', 3, 24, true),
    ('sync_job', 3, 3, false),
    ('audit_log', 3, 12, true)
$$;

CREATE OR REPLACE FUNCTION maintain_partitions(p_now timestamptz DEFAULT now()) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t record;
  v_month_start timestamp; -- UTC wall time, so month arithmetic ignores the session TimeZone
  v_from timestamp;
  v_to timestamp;
  v_name text;
  v_created integer := 0;
BEGIN
  v_month_start := date_trunc('month', p_now AT TIME ZONE 'UTC');
  FOR t IN SELECT * FROM partition_targets() LOOP
    FOR i IN 0..t.ahead_months LOOP
      v_from := v_month_start + make_interval(months => i);
      v_to := v_month_start + make_interval(months => i + 1);
      v_name := t.table_name || '_p' || to_char(v_from, 'YYYYMM');
      IF to_regclass(format('public.%I', v_name)) IS NULL THEN
        EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                       v_name, t.table_name,
                       ulid_lower_bound(v_from AT TIME ZONE 'UTC'), ulid_lower_bound(v_to AT TIME ZONE 'UTC'));
        v_created := v_created + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_created;
END $$;

------------------------------------------------------------------------------------------------
-- Idempotent trigger creation used by 20_triggers.sql. Existing triggers are left alone;
-- changing a trigger definition is done in a versioned migration.
------------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ensure_trigger(p_table regclass, p_name text, p_ddl text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = p_table AND tgname = p_name AND NOT tgisinternal) THEN
    EXECUTE p_ddl;
  END IF;
END $$;
