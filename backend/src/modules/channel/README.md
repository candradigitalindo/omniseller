# Modul channel

## Tanggung jawab
Menghubungkan toko marketplace dan menjaga koneksinya tetap hidup (PRD 6.1, 6.3.1; backend doc 8.6, 8.11, 8.23): tautan otorisasi, penukaran kode, token terenkripsi dan refresh-nya, status toko, impor dan pemetaan gudang marketplace, langganan webhook per toko, reaksi terhadap notifikasi otorisasi dari marketplace, memutus toko dengan atau tanpa datanya (FR-INT-07), serta peringatan koneksi terputus (FR-INT-08).

Juga saluran pesanan manual: toko berkanal `manual` untuk pesanan WhatsApp, Instagram, atau toko offline (backend doc 8.21).

Marketplace yang didukung: Shopee dan TikTok Shop. Di Indonesia TikTok Shop dan Tokopedia adalah satu toko, dan seller melihatnya sebagai "Tokopedia & Shop" (pedoman platform melarang merek TikTok di antarmuka pihak ketiga). Lazada dan Blibli menyusul di Fase 2.

## Tabel yang dimiliki
- `store`, `store_credential`, `store_authorization`, `channel_warehouse`, `sync_cursor`.
- `tenant_key` ditulis lewat `TokenVault` (`common/security`), dipakai bersama rahasia tenant lain.

## Service publik
- `KeyRotationService.run(ctx, rotationId)` (worker): membuat versi DEK per kejadian dan menyegel ulang kredensial per 50 baris; retry memakai id yang sama dan tidak menurunkan versi yang lebih baru. `TokenVault.seal` serta rotasi mengambil advisory lock transaksi per tenant sebelum baris kredensial; versi aktif dibaca tiap penyegelan. Cache unwrap memakai sidik jari ciphertext agar versi dari transaksi yang dibatalkan tidak dipakai ulang. Kunci yang dipensiunkan tetap dapat membuka token lama.
- `StoreAuthorizationService` (api): `start(ctx, {channel, storeId?})` mengembalikan `authorizeUrl`; `callback(ctx, {channel, state, code?, shopId?, mainAccountId?, error?})`; `get(ctx, id)`. Error: `channel.unsupported`, `channel.not_configured`, `store.not_found`, `store_authorization.invalid`, `store_authorization.not_found`, `billing.limit_reached` (toko baru melebihi kuota toko marketplace paket: toko yang terhubung, bukan saluran manual dan bukan yang diputus; menghubungkan ulang tidak dihitung, backend doc 8.32). `ChannelModule` mengimpor `IdentityModule` untuk paket yang berlaku.
- Pemasangan seller dari **App Store Seller Center Tokopedia & Shop** didukung untuk aplikasi public yang telah disetujui platform. Panduan resmi `authorization-via-app-store` (`678e3a3b9c908d03044b58e9`) mengirim `?code=...` tanpa state aplikasi. Proxy web menangkap kode sebelum pengalihan login, mengirimkannya server-side ke `POST /v1/store-installations/tiktokshop/capture`, lalu mengalihkan ke `/integrasi/instalasi/tiktokshop` tanpa kode. Cookie `os_tiktok_install` hanya berisi receipt acak, HttpOnly/SameSite=Lax dan kedaluwarsa 10 menit. Redis menyimpan kode tersegel AES-GCM dengan kunci HKDF terpisah dari kunci API TOTP; kode segera dibersihkan setelah permintaan masuk outbox. Token marketplace tetap hanya ditukar dan disegel worker.
- `GET /v1/store-installations/tiktokshop` memberi nonce konfirmasi terikat sesi. `POST .../confirm` memerlukan `confirmed: true`, nonce terbaru dari sesi yang sama, origin web yang tepat, pengguna interaktif dan izin `settings:store`. Layar menyebut bisnis tujuan dan memperingatkan bahwa identitas toko belum diverifikasi; receipt tanpa state tidak otomatis menghubungkan toko. Klaim atomik global berdasarkan hash kode membatasi kode pada satu pengguna/sesi/tenant, termasuk callback duplikat. Ulangan respons hilang menggunakan authorization id yang sama dan satu outbox event. Worker memeriksa ulang pengguna/role/tenant, menukar kode sekali dan menyegel grant, lalu mengembalikan **preview nama dan ID toko Indonesia tanpa membuat toko/kredensial**. Status tetap `exchanging`, dengan `installation.awaitingShopSelection: true`. Pengguna harus memilih sendiri toko terverifikasi pada modal yang dapat dicari dan dipaginasi; `POST .../select-shops` memvalidasi nonce/sesi/tenant/pemohon lagi dan hanya menerima ID dari preview. Job terpisah `store.installation_connect` melanjutkan grant tersegel, tidak menukar kode lagi, memeriksa ulang izin dan identitas toko, dan hanya menghubungkan toko pilihan. Grant menunggu konfirmasi tetap kedaluwarsa setelah 10 menit dan dibersihkan worker. Flow state CSRF yang dimulai dari OmniSeller tetap memakai endpoint callback existing.
- **Kuota saat commit:** worker mengunci baris tenant dan membaca ulang paket/jumlah toko sebelum menghubungkan setiap toko baru atau mengaktifkan toko yang sempat diputus. Grant multi-toko dan dua grant bersamaan tidak dapat melewati batas; toko aktif tetap boleh diotorisasi ulang pada batas paket. Hasil toko yang melewati kuota memuat `billing_limit_reached`. Panggilan token exchange dan penemuan toko memakai `withRequestGate` per permintaan, termasuk umpan balik pembatasan laju platform, tanpa transaksi DB terbuka selama HTTP.
- `StoresService` (api dan worker): `list`, `listIn`, `get`, `inScope`, `stockTargetsIn` (toko beserta gudang marketplace, untuk modul inventory), `update` (nama, gudang default, `syncMode`; `If-Match`), `disconnect(ctx, id, keepData)`, `disconnectedIdsIn` (toko yang diputus, untuk modul orders), `rowIn` dan `finishDataDeletionIn` (untuk modul retention), `requestWarehouseSync`, `channelWarehouses`, `mapChannelWarehouse`; untuk worker: `markReauthRequired`, `noteAuthorizationExpiry`, `reevaluateStatus`, `noteCallFailed` dan `noteCallWorked` (gangguan koneksi, dipanggil `MarketplaceGateway`), `syncCursor`, `recordPull` (resource `listings` atau `orders`; mengisi `last_product_sync_at` atau `last_order_sync_at`), `saveSyncCursor` (resource lain, misalnya `returns`, tanpa menyentuh baris toko); untuk ekspor data (backend doc 8.18): `namesIn`, `exportSheets` (`toko.csv`); untuk migrasi (8.19): `lockIn` (toko pemanggil terkunci), `setSyncModeIn` (mode paralel atau `live` di transaksi pemanggil, dengan syarat yang sama dengan `update`), `unmappedWarehousesIn`. Saluran manual: `createManual`, `manualStoreIn` (saluran sebuah pesanan manual, dibuat bila belum ada); untuk penghapusan gudang: `warehouseUsageIn`. `update` juga menyimpan `autoAllocate`. Error: `store.not_found`, `store.not_active`, `store.disconnected`, `store.unmapped_warehouses`, `store.live_mapping_required`, `channel_warehouse.not_found`, `channel_warehouse.marketplace_managed`, `row.stale`.
- Hanya worker: `StoreConnectService.complete` (job `store.authorize`), `CredentialService` (`save`, `forShop`, `refresh`), `MarketplaceGateway.call` (satu-satunya jalan memanggil marketplace untuk toko; `{ background: true }` untuk pekerjaan latar yang hanya boleh memakai 30% batas laju toko, backend doc 8.6), `ChannelSyncService` (`syncWarehouses`, `subscribeWebhooks`), `ChannelAlertsService` (`reauthRequired`, `authorizationExpiring`, `warehousesChanged`, `checkConnections`: notifikasi in-app ke pengguna dengan `settings:store` yang melihat toko itu, backend doc 8.17, 8.21, 8.23; koneksi terputus juga lewat email).

## Aturan
- **Penutupan akun** (backend doc 8.36): `StoresService.disconnectAllIn(tx, ctx, reason)` memutus setiap toko marketplace yang masih terhubung dengan data disimpan, seperti `disconnect` satu toko (`statusReason` = alasannya); saluran manual tetap. `revokeLinks` memberi tautan pencabutan izin per marketplace (Shopee).
- `api` tidak pernah memanggil marketplace dan tidak bisa membaca atau menulis token. Kode otorisasi lewat outbox ke worker (ADR-029).
- `state` otorisasi: 256 bit acak, hanya hash yang disimpan, berlaku 30 menit, sekali pakai, dan hanya bisa dipakai tenant yang membuatnya (RLS).
- Satu toko marketplace hanya dipakai satu tenant: indeks unik parsial `(channel, external_shop_id) WHERE status <> 'disconnected'`. Toko yang dipakai tenant lain dideteksi lewat `resolve_store` sebelum insert dan gagal `shop_connected_elsewhere`.
- **Memutus toko** (FR-INT-07, backend doc 8.23):
  - Token dihapus seketika, status `disconnected`, `read_only`; event `store.disconnected` membuat pesanan terbuka melepas stok (modul orders).
  - Toko yang diputus tidak memegang tokonya lagi: bisnis lain boleh menghubungkannya, dan `resolve_store` mendahulukan toko yang dipakai.
  - Dihubungkan ulang oleh bisnis yang sama, toko yang diputus dengan data dipakai lagi (`storeByExternalId`).
  - Tanpa menyimpan data (`keepData: false`): `data_deletion_requested_at` diisi dan modul retention menghapus datanya; baris toko tetap sebagai penanda, karena `user_store_scope` merujuknya dengan CASCADE dan cakupan kosong berarti semua toko. Penanda tidak tampil di daftar toko dan tidak pernah dipakai lagi; menghubungkan tokonya lagi membuat toko baru.
- **Koneksi terputus** (FR-INT-08): `failing_since` diisi `MarketplaceGateway` pada kegagalan sementara pertama ke marketplace dan dikosongkan panggilan berikutnya yang berhasil. Setelah 15 menit (atau 15 menit `reauth_required`), pengelola toko diberi tahu sekali lewat in-app dan email (`store.connection_lost`, `connection_alert_at` diisi), lalu saat pulih (`store.connection_restored`). Toko yang diputus dan saluran manual tidak dipantau. Hubungkan ulang mengosongkan `failing_since`.
- Hanya toko region `ID` yang dihubungkan; toko region lain dari akun utama Shopee dicatat `skipped`.
- Token disegel AES-256-GCM dengan DEK tenant dan AAD `<tenant>:store:<id>:access|refresh`. Refresh di bawah advisory lock per toko; token akses di-refresh pada 80% masa hidupnya.
- Status `reauth_required` menghapus token seketika. Penyebab: notifikasi pencabutan, refresh token ditolak, tiga kegagalan refresh berturut, toko dibekukan.
- Setiap perubahan `sync_mode` mencatat `sync_mode_changed_at` (lama mode paralel) dan menulis `store.sync_mode_changed`. Web app memindahkan toko ke `live` lewat cutover modul migration (checklist, bisa dibatalkan 24 jam); `PATCH` tetap untuk klien API dan untuk kembali ke `read_only`.
- Status `token_expiring` 14 hari sebelum izin seller berakhir atau saat marketplace mengirim pemberitahuan. Masuk `token_expiring` menulis event `store.authorization_expiring`; masuk `reauth_required` menulis `store.reauth_required`. Keduanya menjadi notifikasi in-app, kecuali toko sudah pulih saat job berjalan.
- Toko baru selalu `read_only`. `live` butuh toko aktif dan semua gudang penjual aktif terpetakan; melepas pemetaan toko `live` ditolak.
- Saluran manual (`channel = 'manual'`):
  - `external_shop_id` sama dengan id toko, status `active`, dan selalu `live`.
  - Dilewati semua pekerjaan marketplace (`isManualChannel`).
  - Aksi marketplace ditolak 422 `store.manual`: impor gudang, `syncMode`, `autoAllocate`, dan aksi di modul lain.
  - Diputus berarti diarsipkan (tanpa `revokeUrl`).
- Gudang marketplace yang berubah memberi notifikasi `store.warehouses_changed` (FR-WHS-10) bila ada gudang penjual yang belum dipetakan atau ada yang hilang.
- Pemetaan otomatis saat impor gudang: bila toko hanya punya satu gudang penjual, atau bisnis hanya punya satu gudang aktif, gudang marketplace yang belum terpetakan diarahkan ke gudang default toko.

## `store.settings` dan `store.marketplace_info`
- `settings`: pengaturan pengguna per toko. `autoAllocate` (boolean, bawaan mati): pesanan toko tanpa multi-gudang dikirim dari gudang terdekat yang stoknya cukup (FR-ORD-12, backend doc 8.21). Tidak berlaku untuk toko dengan lebih dari satu gudang penjual aktif.
- `marketplace_info` (diisi saat terhubung, hanya baca): Shopee `status`, `is_cb`, `is_sip`, `merchant_id`, `fulfillment_flag`, `authorized_at`, `logo`, `main_account_id`, `merchant_ids`; TikTok Shop `seller_type`, `shop_code`, `open_id`, `seller_name`, `seller_base_region`.

## Event
- Operasional: `tenant.dek_rotation_requested` dari CLI, dikonsumsi `tenant.dek_rotate`; tidak memuat token atau kunci.
- Diterbitkan: `store.authorization_received`, `store.connected`, `store.disconnected` (dengan `keepData`), `store.data_deletion_requested` (dikonsumsi modul retention, juga untuk lanjutan), `store.reauth_required`, `store.warehouses_sync_requested`, `channel_warehouse.changed`, `channel_warehouse.mapping_changed` (pemetaan gudang marketplace berubah), `store.sync_mode_changed`, `store.authorization_expiring`. Pusher stok (modul inventory) mengonsumsi `channel_warehouse.changed`, `channel_warehouse.mapping_changed`, dan `store.sync_mode_changed`; `store.reauth_required` dan `store.authorization_expiring` menjadi notifikasi.
- Dikonsumsi dari webhook (`jobs/webhook-consumers.ts`): `authorization.revoked`, `authorization.expiring`.

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `tenant.dek_rotate` | `import` | `tenant.dek_rotation_requested`, id per tenant dan `rotationId` |
| `store.authorize` | `mp.outbound` | `store.authorization_received` |
| `store.installation_connect` | `mp.outbound` | `store.installation_selected`: toko pilihan dari preview App Store, memakai grant yang sudah disegel |
| `store.warehouses_sync` | `mp.poll` | `store.connected`, `store.warehouses_sync_requested`, jadwal `mp.poll.warehouses` (6 jam) |
| `store.webhooks_subscribe` | `mp.outbound` | `store.connected`, jadwal 6 jam agar toko lama mendapat topik baru (TikTok Shop; Shopee diatur per aplikasi) |
| `store.token_refresh` | `mp.outbound` | jadwal `token.refresh_scan` (15 menit) |
| `store.reauth_notice` | `notify` | `store.reauth_required` |
| `store.expiry_notice` | `notify` | `store.authorization_expiring` |
| `store.warehouses_notice` | `notify` | `channel_warehouse.changed` |
| `store.connection_check` | `notify` | jadwal `store.connection_scan` (5 menit, per tenant dengan koneksi terputus lebih dari 15 menit atau yang pulih) |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/channels` | `settings:store` |
| POST | `/v1/store-authorizations`, `/v1/store-authorizations/callback` | `settings:store` |
| GET | `/v1/store-authorizations/{id}` | `settings:store` |
| POST | `/v1/store-installations/tiktokshop/capture` | publik, origin web tepat, batas laju IP; receipt HttpOnly 10 menit |
| GET | `/v1/store-installations/tiktokshop` | sesi pengguna + `settings:store` |
| POST | `/v1/store-installations/tiktokshop/confirm`, `/v1/store-installations/tiktokshop/select-shops` | sesi/nonce/origin + `settings:store`; konfirmasi eksplisit |
| GET | `/v1/stores`, `/v1/stores/{id}` | sesi (cakupan toko) |
| POST | `/v1/stores/manual` | `settings:store` |
| PATCH | `/v1/stores/{id}` | `settings:store` |
| POST | `/v1/stores/{id}/disconnect` (`keepData`), `/v1/stores/{id}/warehouses/sync` | `settings:store` |
| GET, PUT | `/v1/stores/{id}/channel-warehouses`, `/v1/stores/{id}/channel-warehouses/{channelWarehouseId}` | `settings:store` |
| GET | `/v1/stores/{id}/sync-jobs` | `settings:store` |

## Pengaturan di konsol marketplace
- Audit Tokopedia & Shop: `AUDIT-INTEGRASI-TIKTOKSHOP.md` di root dan CSV inventaris memetakan dokumen resmi, versi API, scope dan referensi kode. Alur seller inti tersedia sebagian; bukan seluruh API/Partner Center, metode pemasangan App Store atau program Indonesia. Perubahan Imported Goods (27 Oktober 2026), Horizon+, pembatas laju adaptif dan scope perlu ditindaklanjuti sesuai audit; tes connector lokal tidak membuktikan lolos sandbox/review.
- Audit cakupan Shopee: lihat `AUDIT-INTEGRASI-SHOPEE.md` di root. Snapshot sekunder memuat 428 endpoint; referensi connector tidak berarti seluruh fitur API/UI selesai. Adapter opsional `affiliate.listOpenCampaignProducts` kini tersedia di paket Shopee, dipakai modul affiliate melalui worker/outbox, cache satu halaman, API dan UI `/affiliate`; jangan dipanggil dari proses API. Izin AMS dan sandbox nyata tetap perlu diverifikasi (ADR-044).
- Shopee: daftarkan domain `PUBLIC_WEB_URL` sebagai Redirect URL Domain (callback `/integrasi/callback/shopee`), dan atur push ke `${PUBLIC_WEBHOOK_URL}/webhooks/shopee` untuk kode 1, 2, 3, 4, 5, 6, 12, 15, 16, 22 (`SHOPEE_SUBSCRIBED_PUSH_CODES`, `setShopeePushConfig` di paket connector). Kode 15 (dokumen pengiriman siap) dipakai sejak pengiriman; konsol aplikasi yang sudah diatur perlu diatur ulang.
- TikTok Shop Partner Center: Redirect URL `${PUBLIC_WEB_URL}/integrasi/callback/tiktokshop`. Webhook per toko dipasang otomatis oleh `store.webhooks_subscribe`.

## Keputusan khusus modul
- Impor awal produk (FR-INT-04) dijalankan modul `catalog` sebagai konsumen `store.connected` (`listing.pull` penuh), dan impor pesanan 90 hari oleh modul `orders` (`order.pull` awal).
- `sync_cursor` milik modul ini; modul lain membaca dan memajukannya lewat `StoresService.syncCursor`, `recordPull` (resource `listings` juga mengisi `store.last_product_sync_at`), dan `saveSyncCursor` (`returns`).
- Pemasangan dari TikTok Shop App Store (tanpa `state`) belum didukung; butuh aplikasi publik yang lolos review.
- Notifikasi seketika `store.reauth_required` tetap ada; peringatan 15 menit (FR-INT-08) adalah eskalasinya dengan email. Kegagalan karena pembatas laju OmniSeller sendiri (`local_rate_limit`) dan penolakan permintaan (`permanent`) tidak dihitung sebagai koneksi terputus.

## API scopes on existing TikTok seller operations

`CredentialService.forShop` supplies persisted scope metadata separately from the worker-only token.
The gateway wraps each TikTok operation in the core `withGrantedScopes` context. Every signed client
call/upload matches its exact method/version/path against all 390 published endpoint-version scope
contracts before HTTP. A multi-request operation checks every individual request. Missing grants or
unverified contracts fail closed with an actionable Indonesian sync message; they do not masquerade
as an authorization revocation or infer write from read scope. Refresh reloads scopes and token before
retry, and concurrent contexts do not share grants. Known seller-flow mock permissions are explicit;
fixtures that provide `scopes` retain their exact narrower grants for denial tests.

Official scope packages are filtered by principal type. A matching applicable package is a necessary
precheck, so ordinary seller workflows do not require the full-service seller program listed beside
them. It is not proof of sufficient permission or AND/OR semantics: final marketplace authorization
and current app/program eligibility remain authoritative. Per-store UI feature availability and
live marketplace entitlement verification remain separate work.
