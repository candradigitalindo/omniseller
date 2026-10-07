-- 0022_billing: subscriptions, their invoices paid through Xendit, and monthly usage (PRD 15.1 and 15.4,
-- technology doc ADR-020, UI L45, backend doc 8.32). `plan` exists since 0001 and is seeded (prices in
-- 90_seeds.sql); `tenant.plan_id` stays the plan in force, and this module keeps it in sync.

-- One tenure of one plan: a 14-day trial of Growth, a paid month that renews, or the free Starter plan
-- (no period). A tenant has one live row (trialing, active, past_due); ended rows stay as history. A move
-- to a cheaper plan waits for the end of the paid period (`next_plan_id`); a move up starts when paid.
CREATE TABLE subscription_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE subscription (
  id                    ulid PRIMARY KEY,
  tenant_id             ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  row_version           integer NOT NULL DEFAULT 1,
  plan_id               ulid NOT NULL REFERENCES plan (id) ON DELETE RESTRICT,
  status                text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'expired', 'cancelled')),
  status_changed_at     timestamptz NOT NULL DEFAULT now(),
  current_period_start  timestamptz NOT NULL,
  -- NULL for the free plan: nothing to renew
  current_period_end    timestamptz,
  -- the plan the business moves to when this period ends (a cheaper one, or Starter); NULL: it renews
  next_plan_id          ulid REFERENCES plan (id) ON DELETE RESTRICT,
  -- the last reminder sent for this period: 'ending' (trial), 'due' (renewal invoice), 'past_due'
  reminded_stage        text CHECK (reminded_stage IN ('ending', 'due', 'past_due')),
  ended_at              timestamptz,
  CONSTRAINT subscription_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT subscription_trial_has_end CHECK (status <> 'trialing' OR current_period_end IS NOT NULL),
  CONSTRAINT subscription_ended CHECK ((status IN ('expired', 'cancelled')) = (ended_at IS NOT NULL)),
  CONSTRAINT subscription_next_plan CHECK (next_plan_id <> plan_id)
);
CREATE UNIQUE INDEX subscription_live_uq ON subscription (tenant_id)
  WHERE status IN ('trialing', 'active', 'past_due');
CREATE INDEX subscription_tenant_id_idx ON subscription (tenant_id, id DESC);
-- the renewal scan: live subscriptions whose period ends soon or ended (cross-tenant, so no tenant_id first)
CREATE INDEX subscription_period_end_idx ON subscription (current_period_end)
  WHERE status IN ('trialing', 'active', 'past_due') AND current_period_end IS NOT NULL;

-- A payment asked for one period of one plan: created here, paid on Xendit's page, confirmed by callback.
-- `renewal`: the period after the current one (it starts when that one ends, even when paid early);
-- `upgrade`: a pricier plan from the moment it is paid, less what is left of a paid period (`credit_amount`).
CREATE TABLE invoice_status_transition (
  id          ulid PRIMARY KEY,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  via         text NOT NULL DEFAULT 'any' CHECK (via IN ('any', 'marketplace')),
  UNIQUE (from_status, to_status),
  CHECK (from_status <> to_status)
);

CREATE TABLE invoice (
  id                  ulid PRIMARY KEY,
  tenant_id           ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  row_version         integer NOT NULL DEFAULT 1,
  subscription_id     ulid NOT NULL,
  plan_id             ulid NOT NULL REFERENCES plan (id) ON DELETE RESTRICT,
  number              text NOT NULL CHECK (number ~ '^INV-[0-9]{4}-[0-9]{4,}$'),
  kind                text NOT NULL CHECK (kind IN ('renewal', 'upgrade')),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'failed', 'void')),
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  amount              bigint NOT NULL CHECK (amount > 0),
  credit_amount       bigint NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  period_start        timestamptz NOT NULL,
  period_end          timestamptz NOT NULL,
  due_at              timestamptz NOT NULL,
  paid_at             timestamptz,
  paid_amount         bigint CHECK (paid_amount IS NULL OR paid_amount >= 0),
  payment_method      text,
  payment_channel     text,
  -- the invoice's id at Xendit (ours is its external_id there)
  external_invoice_id text,
  invoice_url         text,
  invoice_expires_at  timestamptz,
  error               text,
  requested_by        ulid,
  CONSTRAINT invoice_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT invoice_tenant_number_uq UNIQUE (tenant_id, number),
  CONSTRAINT invoice_subscription_fk FOREIGN KEY (tenant_id, subscription_id)
    REFERENCES subscription (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT invoice_requested_by_fk FOREIGN KEY (tenant_id, requested_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (requested_by),
  CONSTRAINT invoice_period CHECK (period_end > period_start),
  CONSTRAINT invoice_paid CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);
CREATE UNIQUE INDEX invoice_external_uq ON invoice (external_invoice_id) WHERE external_invoice_id IS NOT NULL;
CREATE INDEX invoice_tenant_id_idx ON invoice (tenant_id, id DESC);
CREATE INDEX invoice_subscription_idx ON invoice (tenant_id, subscription_id, id DESC);

-- What the business used in a month of its own time zone (metric `orders` first), against the plan's
-- quota; `warned_pct` is the last usage warning sent (80, 100) for that month.
CREATE TABLE usage_counter (
  id           ulid PRIMARY KEY,
  tenant_id    ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  integer NOT NULL DEFAULT 1,
  metric       text NOT NULL CHECK (metric ~ '^[a-z_]+$'),
  period       text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  value        bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  warned_pct   integer NOT NULL DEFAULT 0 CHECK (warned_pct IN (0, 80, 100)),
  CONSTRAINT usage_counter_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT usage_counter_uq UNIQUE (tenant_id, metric, period)
);
