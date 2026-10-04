-- Repeatable, idempotent seeds for global reference tables (backend doc 12.2).
-- Removing a row from these lists does not delete it: removals are versioned migrations.

INSERT INTO plan (id, code, name, limits, features, price_monthly) VALUES
  (gen_ulid(), 'starter', 'Starter',
   '{"stores": 2, "warehouses": 1, "orders_per_month": 1000, "users": 2}', '{}', 0),
  (gen_ulid(), 'growth', 'Growth',
   '{"stores": 10, "warehouses": 2, "orders_per_month": 10000, "users": 10}',
   '{auto_process, promo_auto_renew, boost, customer_receivable, staff_report, custom_roles, chat}', 0),
  (gen_ulid(), 'business', 'Business',
   '{"stores": null, "warehouses": null, "orders_per_month": 100000, "users": null}',
   '{auto_process, promo_auto_renew, boost, customer_receivable, staff_report, custom_roles, chat, accounting, public_api, distribution}', 0)
ON CONFLICT (code) DO NOTHING;

-- Must equal PERMISSIONS in packages/shared/src/permissions.ts (checked by the schema test).
INSERT INTO permission (id, code, module, description)
SELECT gen_ulid(), p.code, split_part(p.code, ':', 1), p.description
  FROM (VALUES
    ('order:read', 'Lihat pesanan'),
    ('order:accept', 'Terima pesanan'),
    ('order:cancel', 'Batalkan pesanan'),
    ('order:tag', 'Beri tag pesanan'),
    ('order:write', 'Buat dan ubah pesanan manual'),
    ('shipment:arrange', 'Atur pengiriman dan pickup'),
    ('shipment:print', 'Cetak label dan dokumen'),
    ('shipment:pack', 'Kemas dengan scan'),
    ('shipment:handover', 'Serah terima kurir'),
    ('return:respond', 'Tanggapi retur dan pembatalan'),
    ('return:receive', 'Terima barang retur'),
    ('inventory:read', 'Lihat stok'),
    ('inventory:adjust', 'Sesuaikan stok'),
    ('inventory:count', 'Stock opname'),
    ('inventory:transfer', 'Transfer stok'),
    ('catalog:read', 'Lihat produk'),
    ('catalog:write', 'Ubah produk'),
    ('catalog:publish', 'Terbitkan produk ke toko'),
    ('catalog:map', 'Hubungkan listing ke produk'),
    ('price:write', 'Ubah harga'),
    ('promo:write', 'Kelola promosi'),
    ('finance:read', 'Lihat keuangan'),
    ('finance:reconcile', 'Cocokkan dana cair'),
    ('finance:export', 'Ekspor data keuangan'),
    ('chat:read', 'Lihat chat'),
    ('chat:write', 'Balas chat'),
    ('chat:assign', 'Tugaskan chat'),
    ('report:read', 'Lihat laporan'),
    ('settings:store', 'Kelola toko terhubung'),
    ('settings:warehouse', 'Kelola gudang, printer, dan kurir'),
    ('settings:user', 'Kelola tim dan peran'),
    ('settings:billing', 'Kelola langganan dan profil bisnis'),
    ('research:read', 'Lihat riset pasar'),
    ('research:write', 'Kelola riset pasar'),
    ('audit:read', 'Lihat log audit'),
    ('data:export', 'Ekspor seluruh data bisnis')
  ) AS p(code, description)
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, module = EXCLUDED.module;

-- The built-in Owner role of every business holds every permission, including ones added after the
-- business was created (data:export in 0008).
INSERT INTO role_permission (id, tenant_id, role_id, permission_id)
SELECT gen_ulid(), r.tenant_id, r.id, p.id
  FROM role r CROSS JOIN permission p
 WHERE r.is_system AND r.name = 'Owner'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Built-in roles never change after signup (new businesses copy SYSTEM_ROLES), so permissions added later
-- reach the built-in roles of existing businesses here: answering and receiving returns (0016).
INSERT INTO role_permission (id, tenant_id, role_id, permission_id)
SELECT gen_ulid(), r.tenant_id, r.id, p.id
  FROM role r
  JOIN (VALUES ('Admin', 'return:respond'), ('Admin', 'return:receive'), ('CS', 'return:respond'),
               ('Gudang', 'return:receive')) AS g(role_name, code) ON g.role_name = r.name
  JOIN permission p ON p.code = g.code
 WHERE r.is_system
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- Order status machine (backend doc 7.9).
-- 'any': seller-side steps and cancellations. 'marketplace': facts reported by the marketplace
-- (courier picked up, delivered, completed) that can skip seller-side steps, for example in
-- read_only (parallel migration) mode or when a solo seller prints labels without scanning.
INSERT INTO order_status_transition (id, from_status, to_status, via)
SELECT gen_ulid(), t.f, t.t, t.v
  FROM (VALUES
    ('unpaid', 'new', 'any'),
    ('unpaid', 'cancelled', 'any'),
    ('new', 'problem', 'any'),
    ('new', 'ready_to_pack', 'any'),
    ('new', 'cancelled', 'any'),
    ('new', 'marketplace_fulfilled', 'any'),
    ('problem', 'new', 'any'),
    ('problem', 'ready_to_pack', 'any'),
    ('problem', 'cancelled', 'any'),
    ('ready_to_pack', 'packed', 'any'),
    ('ready_to_pack', 'problem', 'any'),
    ('ready_to_pack', 'cancelled', 'any'),
    ('packed', 'ready_to_ship', 'any'),
    ('packed', 'ready_to_pack', 'any'),
    ('packed', 'cancelled', 'any'),
    ('ready_to_ship', 'shipped', 'any'),
    ('ready_to_ship', 'cancelled', 'any'),
    ('shipped', 'delivered', 'any'),
    ('shipped', 'return_in_progress', 'any'),
    ('shipped', 'cancelled', 'any'),
    ('delivered', 'completed', 'any'),
    ('delivered', 'return_in_progress', 'any'),
    ('completed', 'return_in_progress', 'any'),
    ('return_in_progress', 'returned', 'any'),
    ('return_in_progress', 'completed', 'any'),
    ('marketplace_fulfilled', 'completed', 'any'),
    ('marketplace_fulfilled', 'cancelled', 'any'),
    ('marketplace_fulfilled', 'return_in_progress', 'any'),
    ('new', 'shipped', 'marketplace'),
    ('new', 'delivered', 'marketplace'),
    ('new', 'completed', 'marketplace'),
    ('problem', 'shipped', 'marketplace'),
    ('problem', 'delivered', 'marketplace'),
    ('problem', 'completed', 'marketplace'),
    ('ready_to_pack', 'shipped', 'marketplace'),
    ('ready_to_pack', 'delivered', 'marketplace'),
    ('ready_to_pack', 'completed', 'marketplace'),
    ('packed', 'shipped', 'marketplace'),
    ('packed', 'delivered', 'marketplace'),
    ('packed', 'completed', 'marketplace'),
    ('ready_to_ship', 'delivered', 'marketplace'),
    ('ready_to_ship', 'completed', 'marketplace'),
    ('shipped', 'completed', 'marketplace')
  ) AS t(f, t, v)
ON CONFLICT (from_status, to_status) DO UPDATE SET via = EXCLUDED.via;

INSERT INTO shipment_status_transition (id, from_status, to_status, via)
SELECT gen_ulid(), t.f, t.t, t.v
  FROM (VALUES
    ('pending', 'arranged', 'any'),
    ('arranged', 'label_ready', 'any'),
    ('label_ready', 'packed', 'any'),
    ('packed', 'handed_over', 'any'),
    ('handed_over', 'in_transit', 'any'),
    ('in_transit', 'delivered', 'any'),
    ('in_transit', 'failed', 'any'),
    ('failed', 'rto_in_transit', 'any'),
    ('rto_in_transit', 'rto_received', 'any'),
    ('pending', 'cancelled', 'any'),
    ('arranged', 'cancelled', 'any'),
    ('label_ready', 'cancelled', 'any'),
    ('packed', 'cancelled', 'any'),
    ('pending', 'label_ready', 'marketplace'),
    ('arranged', 'in_transit', 'marketplace'),
    ('label_ready', 'in_transit', 'marketplace'),
    ('packed', 'in_transit', 'marketplace'),
    ('arranged', 'delivered', 'marketplace'),
    ('label_ready', 'delivered', 'marketplace'),
    ('packed', 'delivered', 'marketplace'),
    ('handed_over', 'delivered', 'marketplace'),
    ('handed_over', 'failed', 'marketplace'),
    ('in_transit', 'rto_in_transit', 'marketplace'),
    ('failed', 'in_transit', 'marketplace'),
    ('failed', 'delivered', 'marketplace'),
    -- arranged outside OmniSeller (Seller Center), or the arrangement never confirmed here: the
    -- courier's pickup and the delivery still move the shipment
    ('pending', 'in_transit', 'marketplace'),
    ('pending', 'delivered', 'marketplace')
  ) AS t(f, t, v)
ON CONFLICT (from_status, to_status) DO UPDATE SET via = EXCLUDED.via;

-- Printable documents (backend doc 8.15): rendered once; a failed one may be queued again, and a job
-- whose worker stopped mid-render goes back to the queue.
INSERT INTO document_job_status_transition (id, from_status, to_status, via)
SELECT gen_ulid(), t.f, t.t, 'any'
  FROM (VALUES
    ('queued', 'running'),
    ('queued', 'failed'),
    ('running', 'ready'),
    ('running', 'failed'),
    ('running', 'queued'),
    ('failed', 'queued')
  ) AS t(f, t)
ON CONFLICT (from_status, to_status) DO NOTHING;

-- Print jobs (backend doc 8.24): queued until the agent takes the file (sent), then printed or failed. A
-- failed job, or one the agent took and never reported, can be queued again; a printed one is final
-- (printing it again is a new job). The worker fails a job whose document could not be made.
INSERT INTO print_job_status_transition (id, from_status, to_status, via)
SELECT gen_ulid(), t.f, t.t, 'any'
  FROM (VALUES
    ('queued', 'sent'),
    ('queued', 'failed'),
    ('queued', 'cancelled'),
    ('sent', 'printed'),
    ('sent', 'failed'),
    ('sent', 'queued'),
    ('sent', 'cancelled'),
    ('failed', 'queued'),
    ('failed', 'cancelled')
  ) AS t(f, t)
ON CONFLICT (from_status, to_status) DO NOTHING;

-- Courier handover manifests (backend doc 8.24): an open manifest is completed or cancelled, once.
INSERT INTO handover_status_transition (id, from_status, to_status, via)
SELECT gen_ulid(), t.f, t.t, 'any'
  FROM (VALUES
    ('open', 'completed'),
    ('open', 'cancelled')
  ) AS t(f, t)
ON CONFLICT (from_status, to_status) DO NOTHING;

-- Copying listings (backend doc 8.25): a copy prepares its drafts once; it fails when the source store
-- cannot be read, and the seller may stop a long one (a whole store).
INSERT INTO listing_copy_status_transition (id, from_status, to_status, via)
SELECT gen_ulid(), t.f, t.t, 'any'
  FROM (VALUES
    ('preparing', 'ready'),
    ('preparing', 'failed'),
    ('preparing', 'cancelled')
  ) AS t(f, t)
ON CONFLICT (from_status, to_status) DO NOTHING;

-- A draft is reviewed (draft), prepared again after its category changes (preparing), published once
-- (publishing, published), and after a failure edited or published again. Published is final.
INSERT INTO listing_draft_status_transition (id, from_status, to_status, via)
SELECT gen_ulid(), t.f, t.t, 'any'
  FROM (VALUES
    ('preparing', 'draft'),
    ('draft', 'preparing'),
    ('draft', 'publishing'),
    ('publishing', 'published'),
    ('publishing', 'failed'),
    ('failed', 'draft'),
    ('failed', 'preparing'),
    ('failed', 'publishing')
  ) AS t(f, t)
ON CONFLICT (from_status, to_status) DO NOTHING;

-- Returns (backend doc 8.26): a request follows the marketplace, which may jump between any open status
-- (a late snapshot, arbitration). refunded, cancelled, and closed are final; only the marketplace opens a
-- request again (a Shopee buyer asks to cancel the same order twice). An rto closes when it is received.
INSERT INTO return_request_status_transition (id, from_status, to_status, via)
SELECT gen_ulid(), f.s, t.s, CASE WHEN f.s IN ('refunded', 'cancelled', 'closed') THEN 'marketplace' ELSE 'any' END
  FROM unnest(ARRAY['requested', 'negotiating', 'accepted', 'in_transit', 'rejected', 'disputed', 'refunded',
                    'cancelled', 'closed']) AS f(s)
 CROSS JOIN unnest(ARRAY['requested', 'negotiating', 'accepted', 'in_transit', 'rejected', 'disputed', 'refunded',
                         'cancelled', 'closed']) AS t(s)
 WHERE f.s <> t.s AND (f.s NOT IN ('refunded', 'cancelled', 'closed') OR t.s = 'requested')
ON CONFLICT (from_status, to_status) DO NOTHING;

-- Full data export (backend doc 8.18): rendered once by the worker. A failed or stuck export is not
-- queued again: the next request starts a new one.
INSERT INTO data_export_status_transition (id, from_status, to_status, via)
SELECT gen_ulid(), t.f, t.t, 'any'
  FROM (VALUES
    ('queued', 'running'),
    ('queued', 'failed'),
    ('running', 'ready'),
    ('running', 'failed')
  ) AS t(f, t)
ON CONFLICT (from_status, to_status) DO NOTHING;

-- Imports from another app (backend doc 8.19): validated before importing; a new mapping sends the job
-- back to uploaded, and validation can run again (the catalog may have changed in between).
INSERT INTO migration_job_status_transition (id, from_status, to_status, via)
SELECT gen_ulid(), t.f, t.t, 'any'
  FROM (VALUES
    ('uploaded', 'validating'),
    ('validating', 'validated'),
    ('validating', 'invalid'),
    ('validating', 'failed'),
    ('validated', 'importing'),
    ('validated', 'validating'),
    ('validated', 'uploaded'),
    ('invalid', 'validating'),
    ('invalid', 'uploaded'),
    ('importing', 'imported'),
    ('importing', 'failed'),
    ('failed', 'validating'),
    ('failed', 'uploaded')
  ) AS t(f, t)
ON CONFLICT (from_status, to_status) DO NOTHING;

-- Cutover (backend doc 8.19): undone within 24 hours, once.
INSERT INTO store_cutover_status_transition (id, from_status, to_status, via)
VALUES (gen_ulid(), 'done', 'undone', 'any')
ON CONFLICT (from_status, to_status) DO NOTHING;

INSERT INTO sync_job_status_transition (id, from_status, to_status, via)
SELECT gen_ulid(), t.f, t.t, 'any'
  FROM (VALUES
    ('queued', 'running'),
    ('queued', 'skipped'),
    ('running', 'succeeded'),
    ('running', 'failed'),
    ('running', 'skipped'),
    ('failed', 'queued')
  ) AS t(f, t)
ON CONFLICT (from_status, to_status) DO NOTHING;
