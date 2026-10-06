-- 0018_audit_log_reading: indexes for reading the audit log by business and by person (PRD FR-USR-04;
-- backend doc 8.28). audit_log_entity_idx only serves one record's history (FR-PRD-11), so a business's
-- whole log read the primary key backwards through every tenant's rows.
-- Created in a migration because no production data exists yet; once live, indexes on big tables follow
-- 12.2 (CONCURRENTLY, outside migrations).
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, id DESC);
CREATE INDEX audit_log_tenant_actor_idx ON audit_log (tenant_id, actor_id, id DESC) WHERE actor_id IS NOT NULL;
