-- 0030_report_schedule_run: scheduled report emails (PRD FR-RPT-05, backend doc 8.20). One row per business,
-- cadence, and period: the claim that keeps a weekly or monthly report from going out twice, like daily_digest.
CREATE TABLE report_schedule_run (
  id           ulid PRIMARY KEY,
  tenant_id    ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  integer NOT NULL DEFAULT 1,
  cadence      text NOT NULL CHECK (cadence IN ('weekly', 'monthly')),
  -- the business's local dates the reports covered
  period_start date NOT NULL,
  period_end   date NOT NULL,
  recipients   integer NOT NULL DEFAULT 0 CHECK (recipients >= 0),
  CONSTRAINT report_schedule_run_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT report_schedule_run_period_uq UNIQUE (tenant_id, cadence, period_start)
);
