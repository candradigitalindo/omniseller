-- Repeatable: read-only views a module exports so other modules can join its data without touching its
-- tables (backend doc 11). Every view is security_invoker, so the caller's RLS policies apply to the
-- underlying tables exactly as if the caller queried them. Recreated on every migrate; grants follow
-- in 40_grants.sql.

-- catalog: live variants with their product, for stock lists and reports (inventory module).
DROP VIEW IF EXISTS catalog_variant_v;
CREATE VIEW catalog_variant_v WITH (security_invoker = true) AS
SELECT v.tenant_id,
       v.id AS variant_id,
       v.product_id,
       v.sku,
       v.name AS variant_name,
       v.status AS variant_status,
       v.barcode,
       v.cost_price,
       p.sku AS product_sku,
       p.name AS product_name,
       p.status AS product_status,
       coalesce(
         (SELECT i.source_url FROM product_image i
           WHERE i.tenant_id = v.tenant_id AND i.product_id = v.product_id AND i.variant_id = v.id
           ORDER BY i.position LIMIT 1),
         (SELECT i.source_url FROM product_image i
           WHERE i.tenant_id = v.tenant_id AND i.product_id = v.product_id AND i.variant_id IS NULL
           ORDER BY i.position LIMIT 1)) AS image_url
  FROM variant v
  JOIN product p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
 WHERE v.deleted_at IS NULL AND p.deleted_at IS NULL;
