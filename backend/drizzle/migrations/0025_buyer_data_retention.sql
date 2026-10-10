-- 0025_buyer_data_retention: buyers' personal data is anonymized a chosen time after the order (PRD 12.1,
-- backend doc 8.34). The business chooses 3 to 24 months; 24, the privacy policy's longest, by default.
ALTER TABLE business_profile ADD COLUMN buyer_data_retention_months smallint NOT NULL DEFAULT 24
  CONSTRAINT business_profile_buyer_data_retention CHECK (buyer_data_retention_months BETWEEN 3 AND 24);

-- When an order's buyer data was anonymized; NULL while it is kept.
ALTER TABLE "order" ADD COLUMN buyer_anonymized_at timestamptz;
-- The orders whose buyer data is still kept, oldest first per business: anonymized ones leave the index,
-- so each run starts where the last one stopped.
CREATE INDEX order_tenant_buyer_kept_idx ON "order" (tenant_id, ordered_at) WHERE buyer_anonymized_at IS NULL;

-- The audit trigger is made again by drizzle/sql/20_triggers.sql with the new column (ensure_trigger never
-- replaces an existing trigger): who changed how long buyer data is kept.
DROP TRIGGER IF EXISTS audit_trg ON business_profile;
