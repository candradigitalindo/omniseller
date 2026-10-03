-- 0006_orders: order ingest from Shopee and TikTok Shop, reservations, problems (backend doc 7.8.6, 7.9, 8.14).

-- Marketplace update time of the stored snapshot: an older snapshot (a late webhook, a slow poll) is
-- ignored, so an order never moves back.
ALTER TABLE "order" ADD COLUMN external_updated_at timestamptz;
-- Where the buyer ordered when one shop sells on several platforms (TikTok Shop: TIKTOK_SHOP, TOKOPEDIA).
ALTER TABLE "order" ADD COLUMN platform text;
-- The buyer asked to cancel and the seller has to respond (Shopee IN_CANCEL, TikTok Shop is_buyer_request_cancel).
ALTER TABLE "order" ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;
-- Marketplace buyer id, for the duplicate-order check (personal data, anonymized with the buyer fields).
ALTER TABLE "order" ADD COLUMN external_buyer_id text;

CREATE INDEX order_tenant_id_idx ON "order" (tenant_id, id DESC);
CREATE INDEX order_tenant_status_id_idx ON "order" (tenant_id, status, id DESC);
CREATE INDEX order_tenant_store_buyer_idx ON "order" (tenant_id, store_id, external_buyer_id)
  WHERE external_buyer_id IS NOT NULL;

-- The listing a line sold (Shopee item and model, TikTok Shop product and SKU), to attach the variant
-- once the listing is mapped.
ALTER TABLE order_item ADD COLUMN external_product_id text;
ALTER TABLE order_item ADD COLUMN external_sku_id text;
-- Units of qty cancelled since the order was placed (partial cancellation).
ALTER TABLE order_item ADD COLUMN cancelled_qty integer NOT NULL DEFAULT 0;
ALTER TABLE order_item ADD CONSTRAINT order_item_cancelled_qty_ck CHECK (cancelled_qty BETWEEN 0 AND qty);
ALTER TABLE order_item ADD CONSTRAINT order_item_reserved_open_ck CHECK (reserved_qty <= qty - cancelled_qty);

CREATE INDEX order_item_tenant_listing_ref_idx ON order_item (tenant_id, external_product_id, external_sku_id);
CREATE INDEX order_item_tenant_listing_idx ON order_item (tenant_id, listing_id) WHERE variant_id IS NULL;
