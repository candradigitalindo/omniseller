# Modul inventory

## Tanggung jawab
Gudang, stok, pergerakan stok, aturan alokasi, dan push stok ke marketplace (PRD 6.3, 6.3.1: FR-STK-01 sampai 07, FR-WHS-04, 05, 09, FR-ORD-12, FR-MFS-02, FR-MIG-05; backend doc 8.13, 8.20, 8.21, dan 9.4). Juga mengelola gudang fisik (tambah, ubah, gudang utama, hapus) dan memilih gudang untuk pesanan yang gudangnya tidak ditetapkan marketplace. Stock opname, transfer, pembelian, dan cadangan kampanye menyusul.

## Tabel yang dimiliki
- `warehouse`, `inventory`, `stock_movement`, `stock_allocation_rule`, `listing_stock_state`, `stock_count`, `stock_count_line`, `stock_transfer`, `stock_transfer_line`, `campaign_stock_hold`.
- Membaca listing lewat `ListingsService` (catalog), toko dan gudang marketplace lewat `StoresService` (channel), varian lewat view `catalog_variant_v` yang diekspor catalog, dan penjualan per varian dan gudang lewat `OrdersService.unitsByStockIn` (perlu restock).

## Modul Nest
- `InventoryModule` (`inventory-core.module.ts`, api dan worker): `WarehousesService`, `InventoryService`, `InventoryRepository`. Tidak mengimpor catalog atau channel, karena channel bergantung padanya.
- `InventoryStockModule` (api dan worker): `StockOverviewService`, `InitialStockService`, `AllocationRulesService`, `StockComparisonService`, `RestockService`, `WarehouseAdminService`. Mengimpor `OrdersModule`; orders mengimpor `InventoryModule` dari berkas lain, jadi tidak ada siklus.
- `InventoryWorkerModule` (worker): `StockPushService`, `StockTriggersService`, `StockAlertsService`.
- `InventoryHttpModule` (api): `WarehousesController`, `InventoryController`, `StockRulesController`.

## Service publik
- `WarehousesService`:
  - baca: `list(ctx)`, `get(ctx, id)`, `visibleOneIn`, `visibleIn(tx, ctx)` (cakupan gudang pengguna), `activeIn(tx)`, `findActiveIn(tx, id)`;
  - tulis, untuk `WarehouseAdminService`: `codeTakenIn`, `insertIn`, `updateIn` (`If-Match`), `clearDefaultIn`;
  - ekspor: `codesIn(tx)` dan `exportSheets()` (`gudang.csv` dengan alamat per kolom, backend doc 8.18).

  `addressLine` menulis alamat dalam satu baris.
- `WarehouseAdminService` (backend doc 8.21): `create`, `update`, `makeDefault`, `remove`. Error: `warehouse.not_found`, `warehouse.code_taken`, `warehouse.is_default`, `warehouse.in_use`, `warehouse.has_orders`, `warehouse.has_stock`, `row.stale`.
- `InventoryService.allocateIn(tx, {lines, buyerProvince, home, within})`: gudang terdekat yang memegang semua barang (FR-ORD-12). Keputusannya ada di `allocation-plan.ts` dengan uji unit; provinsi dan pulau di `common/region.ts`.
- `InventoryService`: `adjust(ctx, {lines, reason, note})`, `establishIn(tx, ctx, lines, meta)` (stok awal, nanti opname), `orderMovementsIn(tx, ctx, moves)` (reservasi, pelepasan, dan pengiriman pesanan; kunci baris berurutan, kekurangan stok fisik dilaporkan), `returnMovementsIn(tx, ctx, moves, note)` (barang retur diterima, modul returns: layak jual `return_restock` ke stok, rusak `return_quarantine` ke stok rusak; hanya yang layak jual memicu `inventory.changed`), `stockIn`, `pickInfoIn(tx, pairs)` (lokasi rak dan nama varian untuk pick list dan urutan label, modul fulfillment), `setLocation`, `movements`, `summary`, `warehousesIn`; dasbor (8.16): `criticalIn` (stok yang ditetapkan, habis atau di bawah minimum, dalam cakupan gudang), `variantsIn`; peringatan: `stockAlertsIn`; ekspor (8.18): `exportSheets()` (`stok.csv`, `mutasi_stok.csv`); `deleteStoreRulesIn(tx, storeId)` (aturan alokasi toko yang datanya dihapus, modul retention, 8.23). Error: validasi 422 (`lines.<i>.variantId`, `lines.<i>.warehouseId`, `lines.<i>.quantity` untuk stok fisik di bawah nol, `lines.<i>` untuk baris ganda).
- `StockOverviewService.list`: daftar stok dengan status push per toko.
- `StockComparisonService.initialStockIn(tx, storeId, variantIds)`: stok awal listing yang dibuat salin listing (modul `listing-copy`, backend doc 8.25): yang akan didorong pusher di gudang penjual utama toko, 0 untuk stok yang belum ditetapkan dan toko yang dijeda pusher.
- `StockComparisonService.compareIn(tx, ctx, storeId)`: per listing, stok di marketplace (tarikan terakhir, per lokasi) dibanding yang akan dikirim OmniSeller bila toko `live`, dari `planStockPush` tanpa mengirim apa pun (mode paralel, backend doc 8.19).
- `InventoryService.importInitialIn(tx, ctx, lines, {note, reference})`: stok awal dari berkas migrasi, hanya untuk stok yang belum pernah ditetapkan (mutasi `migration_initial` dengan referensi job).
- `RestockService` (backend doc 8.20, FR-STK-07):
  - `list(ctx, {windowDays, coverDays, targetDays, warehouseId, q, needed, limit})`: per varian dan gudang, terjual per hari, cukup untuk berapa hari, saran jumlah pesan, dan alasan.
  - `csv(ctx, query)`: semua baris sebagai CSV.
  - Keputusannya ada di `restock-plan.ts` dengan uji unit.
- `InitialStockService.fromStore(ctx, storeId, dryRun)`. Error: `store.not_found`, `store.orders_importing` (impor pesanan toko belum selesai).
- `AllocationRulesService`: `list`, `get`, `create`, `update` (`If-Match`), `remove`, `requestResync`. Error: `store.not_found`, `channel_warehouse.not_found`, `stock_rule.not_found`, `stock_rule.duplicate`, `store.not_live`, `row.stale`.
- Hanya worker: `StockPushService.push(ctx, marks)` (penolakan marketplace yang baru diumumkan sebagai `sync.stock_push_failed`), `StockTriggersService` (`markPairs`, `listingMapped`, `listingUnmapped`, `resyncStore`), `StockAlertsService.check(ctx, pairs)` (notifikasi `stock.critical`).

## Aturan
- Nilai persediaan di ringkasan stok (`GET /v1/inventory/summary`, stok fisik x HPP) bernilai `null` bagi yang tidak memegang `finance:read`, karena mengungkap HPP (`seesCost`, backend doc 8.24).
- `WarehousesService.anyIn(tx, id)` membaca gudang yang sudah dihapus juga, untuk dokumen masa lalu (manifest serah terima).
- Jumlah stok hanya berubah lewat `apply_stock_movement()` dan `confirm_stock()`, dan setiap perubahan menulis `inventory.changed` di transaksi yang sama.
- Stok yang belum pernah ditetapkan (`stock_set_at` kosong) tidak didorong. Penyesuaian, stok awal, dan konfirmasi menetapkannya; mutasi pesanan tidak.
- Penyesuaian: semua baris atau tidak sama sekali, alasan wajib, catatan wajib untuk `other`.
- Stok awal dari toko hanya mengisi stok yang belum pernah ditetapkan; `on_hand` = stok marketplace + `reserved` + `buffer`.
- Push: toko `read_only`, tidak aktif, atau dengan gudang penjual belum dipetakan tidak pernah dikirimi; gudang yang dikelola marketplace tidak pernah dikirimi; setiap listing dikirim utuh dengan semua lokasinya; satu gudang fisik tidak ditampilkan dua kali dalam satu listing; nilai yang sudah diterima marketplace tidak dikirim lagi kecuali dipaksa (mode `live`, pemetaan, dorong ulang).
- Kegagalan sementara diulang BullMQ; penolakan marketplace dicatat di `listing_stock_state` dan dicoba lagi saat stoknya berubah. Penolakan pertama setelah berhasil (`push_fail_count` menjadi 1) diumumkan ke pengguna dengan `settings:store`; penolakan berikutnya tidak.
- Stok kritis (FR-NTF-01, backend doc 8.17): `inventory.stock_alert` menyimpan tingkat yang sudah diumumkan (`low` di bawah atau sama dengan minimum, `out` habis); diumumkan hanya saat memburuk, dan pulih di atas minimum mengosongkannya. Stok yang belum ditetapkan dan varian atau produk yang diarsipkan tidak diumumkan.
- Perlu restock:
  - Kecepatan jual adalah unit pesanan yang dipenuhi penjual sendiri dalam 7, 14, atau 30 hari terakhir, per gudang baris pesanan.
  - Target restock adalah `max(ceil(per hari × targetDays), min_stock + 1)`; saran pesan adalah target dikurangi stok tersedia.
  - Alasan: `out` (habis, padahal laku atau punya minimum), `below_min`, dan `low_cover` (cukup untuk kurang dari `coverDays` hari).
  - Hanya stok yang sudah ditetapkan, dari varian dan produk aktif.
- Gudang:
  - Kode unik termasuk gudang yang dihapus.
  - Penghapusan lunak, hanya bila gudang bukan gudang utama, tidak dipakai toko (gudang bawaan atau pemetaan), tidak punya pesanan terbuka, dan tidak berisi stok.
  - Nama provinsi di alamat disimpan dalam bentuk baku.
  - Setiap perubahan diaudit.
- Alokasi: pesanan tidak dipecah. Gudang yang memegang semua barang dari stok yang sudah ditetapkan didahulukan: provinsi pembeli, lalu pulau, lalu gudang pilihan, gudang utama, stok terbanyak, nama. Tanpa gudang seperti itu, pesanan masuk ke gudang pilihan atau gudang utama.
- Penyesuaian, opname, dan stok awal masuk `audit_log` (trigger `audit_manual_trg` pada `stock_movement`, FR-USR-04).

## Event
- Diterbitkan: `inventory.changed`, `stock.resync_requested`.
- Dikonsumsi: `listing.mapped`, `listing.unmapped`, `store.sync_mode_changed`, `channel_warehouse.changed`, `channel_warehouse.mapping_changed`.

## Job (antrean `stock.push`, kecuali disebut lain)
| Job | Pemicu |
|---|---|
| `stock.mark_dirty` | `inventory.changed` |
| `inventory.stock_alert` (antrean `notify`) | `inventory.changed` |
| `stock.push` | scheduler `stock.dirty_flush` (batch 50 kunci per tenant) |
| `stock.listing_mapped` | `listing.mapped` |
| `stock.listing_unmapped` | `listing.unmapped` |
| `stock.store_resync` | `stock.resync_requested`, `store.sync_mode_changed`, `channel_warehouse.changed`, `channel_warehouse.mapping_changed` |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/warehouses`, `/v1/warehouses/{id}` | `inventory:read` |
| POST | `/v1/warehouses`, `/v1/warehouses/{id}/default` | `settings:warehouse` |
| PATCH, DELETE | `/v1/warehouses/{id}` | `settings:warehouse` |
| GET | `/v1/inventory`, `/v1/inventory/summary`, `/v1/inventory/movements` | `inventory:read` |
| POST | `/v1/inventory/adjustments`, `/v1/inventory/initial-stock` | `inventory:adjust` |
| PUT | `/v1/inventory/{variantId}/warehouses/{warehouseId}` | `inventory:adjust` |
| GET | `/v1/inventory/restock`, `/v1/inventory/restock/export` | `inventory:read` |
| POST | `/v1/inventory/resync` | `settings:store` |
| GET, POST | `/v1/stock-allocation-rules` | `settings:store` |
| GET, PATCH, DELETE | `/v1/stock-allocation-rules/{id}` | `settings:store` |

## Keputusan khusus modul
- Gudang pertama (`UTAMA`) dibuat modul identity saat bisnis mendaftar; gudang lain lewat `WarehouseAdminService`. Transfer stok antar gudang (FR-STK-09) menyusul; sementara ini dua penyesuaian.
- Logika push ada di `stock-plan.ts` sebagai fungsi murni dengan uji unit; service hanya memuat data, memanggil marketplace, dan mencatat.
- Deteksi perubahan stok di luar OmniSeller (FR-MIG-07, webhook TikTok Shop tipe 71) menyusul. Peringatan stok minimum (FR-STK-07) berupa notifikasi in-app `stock.critical` dan bagian stok di email ringkasan harian (modul reporting); WhatsApp menyusul bersama pengaturan notifikasi. Purchase order dari daftar perlu restock menyusul bersama modul pembelian (FR-STK-16).
