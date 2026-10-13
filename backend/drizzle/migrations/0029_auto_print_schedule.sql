-- 0029_auto_print_schedule: automatic rules print labels and arrange shipments at a set time (PRD FR-SHP-18,
-- FR-ORD-19; backend doc 8.37). A shipment carries the rule's print instruction until its label is ready, and
-- an order whose rule arranges at a time of day waits in order_rule_schedule until the scan picks it up.
ALTER TABLE shipment ADD COLUMN auto_print jsonb;

CREATE TABLE order_rule_schedule (
  id           ulid PRIMARY KEY,
  tenant_id    ulid NOT NULL REFERENCES tenant (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  row_version  integer NOT NULL DEFAULT 1,
  order_id     ulid NOT NULL,
  rule_id      ulid,
  method       text NOT NULL CHECK (method IN ('pickup', 'dropoff')),
  -- when the arrange request goes to the marketplace
  due_at       timestamptz NOT NULL,
  -- the rule's print instruction, handed to the shipment when it is arranged
  print        jsonb,
  attempts     integer NOT NULL DEFAULT 0,
  claimed_at   timestamptz,
  CONSTRAINT order_rule_schedule_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT order_rule_schedule_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES "order" (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT order_rule_schedule_rule_fk FOREIGN KEY (tenant_id, rule_id)
    REFERENCES order_rule (tenant_id, id) ON DELETE SET NULL (rule_id),
  CONSTRAINT order_rule_schedule_order_uq UNIQUE (tenant_id, order_id)
);
-- the cross-tenant scan finds due rows; a tenant's job reads its own in due order
CREATE INDEX order_rule_schedule_due_idx ON order_rule_schedule (due_at);
CREATE INDEX order_rule_schedule_tenant_due_idx ON order_rule_schedule (tenant_id, due_at);
