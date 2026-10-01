# Modul channel

## Tanggung jawab
Menghubungkan toko marketplace dan menjaga koneksinya tetap hidup (PRD 6.1, 6.3.1; backend doc 8.6, 8.11): tautan otorisasi, penukaran kode, token terenkripsi dan refresh-nya, status toko, impor dan pemetaan gudang marketplace, langganan webhook per toko, serta reaksi terhadap notifikasi otorisasi dari marketplace.

Marketplace yang didukung: Shopee dan TikTok Shop. Di Indonesia TikTok Shop dan Tokopedia adalah satu toko, dan seller melihatnya sebagai "Tokopedia & Shop" (pedoman platform melarang merek TikTok di antarmuka pihak ketiga). Lazada dan Blibli menyusul di Fase 2.

## Tabel yang dimiliki
- `store`, `store_credential`, `store_authorization`, `channel_warehouse`, `sync_cursor`.
- `tenant_key` ditulis lewat `TokenVault` (`common/security`), dipakai bersama rahasia tenant lain.

## Service publik
- `StoreAuthorizationService` (api): `start(ctx, {channel, storeId?})` mengembalikan `authorizeUrl`; `callback(ctx, {channel, state, code?, shopId?, mainAccountId?, error?})`; `get(ctx, id)`. Error: `channel.unsupported`, `channel.not_configured`, `store.not_found`, `store_authorization.invalid`, `store_authorization.not_found`.
- `StoresService` (api dan worker): `list`, `get`, `update` (nama, gudang default, `syncMode`; `If-Match`), `disconnect`, `requestWarehouseSync`, `channelWarehouses`, `mapChannelWarehouse`; untuk worker: `markReauthRequired`, `noteAuthorizationExpiry`, `reevaluateStatus`. Error: `store.not_found`, `store.not_active`, `store.disconnected`, `store.unmapped_warehouses`, `store.live_mapping_required`, `channel_warehouse.not_found`, `channel_warehouse.marketplace_managed`, `row.stale`.
- Hanya worker: `StoreConnectService.complete` (job `store.authorize`), `CredentialService` (`save`, `forShop`, `refresh`), `MarketplaceGateway.call` (satu-satunya jalan memanggil marketplace untuk toko), `ChannelSyncService` (`syncWarehouses`, `subscribeWebhooks`).

## Aturan
- `api` tidak pernah memanggil marketplace dan tidak bisa membaca atau menulis token. Kode otorisasi lewat outbox ke worker (ADR-029).
- `state` otorisasi: 256 bit acak, hanya hash yang disimpan, berlaku 30 menit, sekali pakai, dan hanya bisa dipakai tenant yang membuatnya (RLS).
- Satu toko marketplace hanya boleh terhubung ke satu tenant (UNIQUE global). Toko milik tenant lain dideteksi lewat `resolve_store` sebelum insert dan gagal `shop_connected_elsewhere`.
- Hanya toko region `ID` yang dihubungkan; toko region lain dari akun utama Shopee dicatat `skipped`.
- Token disegel AES-256-GCM dengan DEK tenant dan AAD `<tenant>:store:<id>:access|refresh`. Refresh di bawah advisory lock per toko; token akses di-refresh pada 80% masa hidupnya.
- Status `reauth_required` menghapus token seketika. Penyebab: notifikasi pencabutan, refresh token ditolak, tiga kegagalan refresh berturut, toko dibekukan.
- Status `token_expiring` 14 hari sebelum izin seller berakhir atau saat marketplace mengirim pemberitahuan.
- Toko baru selalu `read_only`. `live` butuh toko aktif dan semua gudang penjual aktif terpetakan; melepas pemetaan toko `live` ditolak.
- Pemetaan otomatis saat impor gudang: bila toko hanya punya satu gudang penjual, atau bisnis hanya punya satu gudang aktif, gudang marketplace yang belum terpetakan diarahkan ke gudang default toko.

## `store.settings` dan `store.marketplace_info`
- `settings`: pengaturan pengguna per toko; belum ada kunci yang dipakai.
- `marketplace_info` (diisi saat terhubung, hanya baca): Shopee `status`, `is_cb`, `is_sip`, `merchant_id`, `fulfillment_flag`, `authorized_at`, `logo`, `main_account_id`, `merchant_ids`; TikTok Shop `seller_type`, `shop_code`, `open_id`, `seller_name`, `seller_base_region`.

## Event
- Diterbitkan: `store.authorization_received`, `store.connected`, `store.disconnected`, `store.reauth_required`, `store.warehouses_sync_requested`, `channel_warehouse.changed`, `store.sync_mode_changed`.
- Dikonsumsi dari webhook (`jobs/webhook-consumers.ts`): `authorization.revoked`, `authorization.expiring`.

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `store.authorize` | `mp.outbound` | `store.authorization_received` |
| `store.warehouses_sync` | `mp.poll` | `store.connected`, `store.warehouses_sync_requested`, jadwal `mp.poll.warehouses` (6 jam) |
| `store.webhooks_subscribe` | `mp.outbound` | `store.connected` (TikTok Shop; Shopee diatur per aplikasi) |
| `store.token_refresh` | `mp.outbound` | jadwal `token.refresh_scan` (15 menit) |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/channels` | `settings:store` |
| POST | `/v1/store-authorizations`, `/v1/store-authorizations/callback` | `settings:store` |
| GET | `/v1/store-authorizations/{id}` | `settings:store` |
| GET | `/v1/stores`, `/v1/stores/{id}` | sesi (cakupan toko) |
| PATCH | `/v1/stores/{id}` | `settings:store` |
| POST | `/v1/stores/{id}/disconnect`, `/v1/stores/{id}/warehouses/sync` | `settings:store` |
| GET, PUT | `/v1/stores/{id}/channel-warehouses`, `/v1/stores/{id}/channel-warehouses/{channelWarehouseId}` | `settings:store` |
| GET | `/v1/stores/{id}/sync-jobs` | `settings:store` |

## Pengaturan di konsol marketplace
- Shopee: daftarkan domain `PUBLIC_WEB_URL` sebagai Redirect URL Domain (callback `/integrasi/callback/shopee`), dan atur push ke `${PUBLIC_WEBHOOK_URL}/webhooks/shopee` untuk kode 1, 2, 3, 4, 5, 12 (`setShopeePushConfig` di paket connector).
- TikTok Shop Partner Center: Redirect URL `${PUBLIC_WEB_URL}/integrasi/callback/tiktokshop`. Webhook per toko dipasang otomatis oleh `store.webhooks_subscribe`.

## Keputusan khusus modul
- Impor awal produk dan pesanan 90 hari (FR-INT-04) menyusul bersama modul katalog dan pesanan sebagai konsumen `store.connected`.
- Pemasangan dari TikTok Shop App Store (tanpa `state`) belum didukung; butuh aplikasi publik yang lolos review.
- Peringatan email atau in-app saat koneksi terputus (FR-INT-08) menyusul bersama modul notifikasi sebagai konsumen `store.reauth_required`.
