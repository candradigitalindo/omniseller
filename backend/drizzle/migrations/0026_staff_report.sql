-- 0026_staff_report: the team performance report (PRD FR-RPT-10, backend doc 8.35) counts what each user
-- did to orders per day from the order history. Only users' entries are read, by time, per business; the
-- rest of the history (marketplace and system entries, most of it) stays out of the index.
CREATE INDEX order_event_user_action_idx ON order_event (tenant_id, created_at) WHERE actor_type = 'user';
