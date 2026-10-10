-- 0028_order_rules: rules that process new orders on their own (PRD FR-ORD-19, backend doc 8.37), from
-- plan Growth on. A new marketplace order the seller ships is checked against the active rules by
-- priority; the first that matches does its actions (choose warehouse, tag, accept, arrange shipment).
CREATE TABLE order_rule (
  id           ulid PRIMARY KEY,
  tenant_id    ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  integer NOT NULL DEFAULT 1,
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  -- 1 is checked first; the same number orders by age
  priority     integer NOT NULL CHECK (priority >= 1),
  active       boolean NOT NULL DEFAULT true,
  -- stores, couriers, warehouses, SKUs, item count, total range, operating hours: empty means any
  conditions   jsonb NOT NULL DEFAULT '{}',
  -- warehouse, tags, accept, arrange (pickup or drop-off): at least one
  actions      jsonb NOT NULL,
  created_by   ulid,
  CONSTRAINT order_rule_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT order_rule_created_by_fk FOREIGN KEY (tenant_id, created_by)
    REFERENCES "user" (tenant_id, id) ON DELETE SET NULL (created_by)
);
CREATE UNIQUE INDEX order_rule_name_uq ON order_rule (tenant_id, lower(name));
CREATE INDEX order_rule_tenant_priority_idx ON order_rule (tenant_id, priority, id);
