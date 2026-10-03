-- 0005_stock_sync: stock adjustments, stock push to marketplaces, push state (backend doc 7.8.4, 9.4; PRD 6.3).

-- When the quantity was last established by a person: an adjustment, a stock count, or initial stock
-- (apply_stock_movement and confirm_stock set it; app roles cannot write it). Stock that was never
-- established is not pushed, so a marketplace never receives a 0 that only means "not entered yet".
ALTER TABLE inventory ADD COLUMN stock_set_at timestamptz;
UPDATE inventory i SET stock_set_at = i.updated_at
 WHERE EXISTS (SELECT 1 FROM stock_movement m
                WHERE m.tenant_id = i.tenant_id AND m.variant_id = i.variant_id AND m.warehouse_id = i.warehouse_id
                  AND m.type IN ('adjustment', 'count_apply', 'migration_initial'));

-- Last push attempt, successful or not, for "push failed n times, last tried at ..." (L19).
ALTER TABLE listing_stock_state ADD COLUMN last_attempt_at timestamptz;
CREATE INDEX listing_stock_state_tenant_failing_idx ON listing_stock_state (tenant_id, listing_id) WHERE last_error IS NOT NULL;
