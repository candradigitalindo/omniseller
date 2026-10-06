# Modul inventory

## Tanggung jawab
Gudang, stok, pergerakan stok, aturan alokasi, dan push stok ke marketplace (PRD 6.3, 6.3.1: FR-STK-01 sampai 09, FR-WHS-04, 05, 09, FR-ORD-12, FR-MFS-02, FR-MIG-05; backend doc 8.13, 8.20, 8.21, 8.27, dan 9.4). Juga mengelola gudang fisik (tambah, ubah, gudang utama, hapus), memilih gudang untuk pesanan yang gudangnya tidak ditetapkan marketplace, stok opname (FR-STK-08), dan transfer stok antar gudang (FR-STK-09). Pembelian dan cadangan kampanye menyusul.

## Tabel yang dimiliki
- `warehouse`, `inventory`, `stock_movement`, `stock_allocation_rule`, `listing_stock_state`, `stock_count`, `stock_count_line`, `stock_transfer`, `stock_transfer_line`, `campaign_stock_hold`.
- Membaca listing lewat `ListingsService` (catalog), toko dan gudang marketplace lewat `StoresService` (channel), varian lewat view `catalog_variant_v` yang diekspor catalog, penjualan per varian dan gudang lewat `OrdersService.unitsByStockIn` (perlu restock), dan dokumen kartu stok lewat `OrdersService.ordersOfItemsIn` dan `ReturnsService.requestsOfItemsIn`.

## Modul Nest
- `InventoryModule` (`inventory-core.module.ts`, api dan worker): `WarehousesService`, `InventoryService`, `InventoryRepository`. Tidak mengimpor catalog atau channel, karena channel bergantung padanya.
- `InventoryStockModule` (api dan worker): `StockOverviewService`, `InitialStockService`, `AllocationRulesService`, `StockComparisonService`, `RestockService`, `WarehouseAdminService`, `StockOpsRepository`, `StockCountService`, `StockTransferService`, `StockHistoryService`. Mengimpor `OrdersModule`, `ReturnsModule` (dokumen kartu stok), `IdentityModule` (zona waktu nomor dokumen), dan `NotificationInboxModule`; orders dan returns mengimpor `InventoryModule` dari berkas lain, jadi tidak ada siklus. Worker memuatnya untuk menerapkan opname, dan ekspor data untuk lembar opname dan transfer.
- `InventoryWorkerModule` (worker): `StockPushService`, `StockTriggersService`, `StockAlertsService`.
- `InventoryHttpModule` (api): `WarehousesController`, `InventoryController`, `StockRulesController`, `StockCountsController`, `StockTransfersController`.

## Service publik
- `WarehousesService`:
  - baca: `list(ctx)`, `get(ctx, id)`, `visibleOneIn`, `visibleIn(tx, ctx)` (cakupan gudang pengguna), `activeIn(tx)`, `findActiveIn(tx, id)`;
  - tulis, untuk `WarehouseAdminService`: `codeTakenIn`, `insertIn`, `updateIn` (`If-Match`), `clearDefaultIn`;
  - ekspor: `codesIn(tx)` dan `exportSheets()` (`gudang.csv` dengan alamat per kolom, backend doc 8.18).

  `addressLine` menulis alamat dalam satu baris.
- `WarehouseAdminService` (backend doc 8.21): `create`, `update`, `makeDefault`, `remove`. Error: `warehouse.not_found`, `warehouse.code_taken`, `warehouse.is_default`, `warehouse.in_use`, `warehouse.has_orders`, `warehouse.has_open_documents` (opname atau transfer belum selesai), `warehouse.has_stock`, `row.stale`.
- `InventoryService.allocateIn(tx, {lines, buyerProvince, home, within})`: gudang terdekat yang memegang semua barang (FR-ORD-12). Keputusannya ada di `allocation-plan.ts` dengan uji unit; provinsi dan pulau di `common/region.ts`.
- `InventoryService`: `adjust(ctx, {lines, reason, note})`, `establishIn(tx, ctx, lines, meta)` (stok awal), `orderMovementsIn(tx, ctx, moves)` (reservasi, pelepasan, dan pengiriman pesanan; kunci baris berurutan, kekurangan stok fisik dilaporkan), `returnMovementsIn(tx, ctx, moves, note)` (barang retur diterima, modul returns: layak jual `return_restock` ke stok, rusak `return_quarantine` ke stok rusak; hanya yang layak jual memicu `inventory.changed`), `stockIn`, `pickInfoIn(tx, pairs)` (lokasi rak dan nama varian untuk pick list dan urutan label, modul fulfillment), `setLocation`, `movements`, `summary`, `warehousesIn`; dasbor (8.16): `criticalIn` (stok yang ditetapkan, habis atau di bawah minimum, dalam cakupan gudang), `variantsIn`; peringatan: `stockAlertsIn`; ekspor (8.18): `exportSheets()` (`stok.csv`, `mutasi_stok.csv`); `deleteStoreRulesIn(tx, storeId)` (aturan alokasi toko yang datanya dihapus, modul retention, 8.23). Error: validasi 422 (`lines.<i>.variantId`, `lines.<i>.warehouseId`, `lines.<i>.quantity` untuk stok fisik di bawah nol, `lines.<i>` untuk baris ganda).
- `InventoryService.countMovementsIn(tx, ctx, warehouseId, lines, {note, actorUserId})`: baris opname yang disetujui; stok bergerak sebesar `countApplyDelta` (selisih terhadap stok saat dihitung, tidak di bawah nol) sebagai `count_apply`, atau `confirm_stock` bila 0. `transferMovementsIn(tx, ctx, {direction, warehouseId, lines, note})`: `out` mengunci semua baris dan tidak menggerakkan apa pun bila satu saja tidak tersedia (mengembalikan baris yang kurang), `in` menambah stok fisik; keduanya tidak menetapkan stok.
- `StockCountService` (backend doc 8.27):
  - `create(ctx, {warehouseId, mode, variantIds, binPrefix, blind, note})`, `list`, `get` (dengan selisih unit dan nilai HPP bagi `finance:read`), `lines(ctx, id, {filter, q}, after, limit)`;
  - `record(ctx, id, entries)` (`set` atau `add`), `scan(ctx, id, code, qty)`;
  - `submit`, `reopen`, `requestApply(ctx, id, {zeroUncounted})`, `cancel`; worker: `apply(ctx, id)`; ekspor `exportSheets()` (`stok_opname.csv`, `stok_opname_baris.csv`).
  - Error: `stock_count.not_found`, `stock_count.open_exists`, `stock_count.too_large`, `stock_count.empty`, `stock_count.not_counting`, `stock_count.not_in_review`, `stock_count.apply_requested`, `stock_count.closed`, validasi (`warehouseId`, `variantIds.<i>`, `lines.<i>.variantId`, `code`, `filter` selama opname buta).
- `StockTransferService` (backend doc 8.27): `destinations`, `create(ctx, input, idempotencyKey)`, `list`, `get`, `update` (`If-Match`), `send`, `receive(ctx, id, {lines, note})`, `cancel`; ekspor `exportSheets()` (`transfer_stok.csv`, `transfer_stok_baris.csv`). Error: `stock_transfer.not_found`, `stock_transfer.not_draft`, `stock_transfer.not_sent`, `stock_transfer.closed`, `stock_transfer.origin_only`, `stock_transfer.destination_only` (403), `row.stale`, validasi (`fromWarehouseId`, `toWarehouseId`, `lines.<i>.variantId`, `lines.<i>.qty` dengan stok tersedia, `lines.<i>.receivedQty`).
- `StockOverviewService.list`: daftar stok dengan status push per toko.
- `StockHistoryService.documentsOf(ctx, movements)` (backend doc 8.13): dokumen asal tiap mutasi kartu stok, yaitu pesanan, retur, stok opname, atau transfer, dengan nomornya. Pesanan dan retur hanya untuk `order:read` dalam cakupan toko dan gudang.
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
- Stok yang belum pernah ditetapkan (`stock_set_at` kosong) tidak didorong. Penyesuaian, opname, stok awal, dan konfirmasi menetapkannya; mutasi pesanan, retur, dan transfer tidak.
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
  - Penghapusan lunak, hanya bila gudang bukan gudang utama, tidak dipakai toko (gudang bawaan atau pemetaan), tidak punya pesanan terbuka, tidak punya opname atau transfer yang belum selesai, dan tidak berisi stok.
  - Nama provinsi di alamat disimpan dalam bentuk baku.
  - Setiap perubahan diaudit.
- Alokasi: pesanan tidak dipecah. Gudang yang memegang semua barang dari stok yang sudah ditetapkan didahulukan: provinsi pembeli, lalu pulau, lalu gudang pilihan, gudang utama, stok terbanyak, nama. Tanpa gudang seperti itu, pesanan masuk ke gudang pilihan atau gudang utama.
- Penyesuaian, opname, dan stok awal masuk `audit_log` (trigger `audit_manual_trg` pada `stock_movement`, FR-USR-04).
- Stok opname (keputusan murni di `stock-ops-plan.ts` dengan uji unit):
  - Satu opname terbuka (`counting`, `review`) per gudang; paling banyak 20.000 baris, disusun per rak lalu SKU, dan id baris mengikuti urutan itu.
  - Opname buta (bawaan) menyembunyikan jumlah sistem, selisih, dan unit pesanan selama `counting`.
  - Baris menyimpan stok saat dihitung (`set`: saat itu; `add`: saat pertama dihitung). Menerapkan menggerakkan stok sebesar selisih terhadap angka itu, jadi penjualan dan barang masuk setelah dihitung tetap tercatat.
  - Mencatat jumlah: opname dikunci `FOR SHARE`, baris ditulis dengan satu `INSERT ... ON CONFLICT` per varian dalam urutan varian.
  - Persetujuan diterapkan worker 500 baris per transaksi (opname dikunci `FOR UPDATE`), 10.000 per job; baris yang sudah diterapkan (`applied_delta`) dilewati.
  - Layar hitung mengirim pindaian berkelompok (`add`), bukan satu permintaan per unit: batas laju 600 permintaan per menit berlaku per tenant.
  - Query `StockOpsRepository` membaca satu tabel dan tabel lain lewat kunci (`inArray` per 1.000 id), tanpa join dengan `catalog_variant_v`: join seperti itu salah rencana saat statistik belum mengejar impor besar. Baris opname menyimpan SKU, nama, barcode, dan raknya sendiri.
- Transfer stok:
  - Kirim hanya bila setiap baris tersedia di gudang asal (stok fisik dikurangi pesanan dan cadangan); unit yang tidak tiba hanya tercatat di baris, karena sudah keluar dari gudang asal.
  - Terlihat oleh pemegang salah satu gudangnya; gudang asal mengubah, mengirim, dan membatalkan, gudang tujuan menerima.

## Event
- Diterbitkan: `inventory.changed`, `stock.resync_requested`, `stock_count.apply_requested`.
- Dikonsumsi: `listing.mapped`, `listing.unmapped`, `store.sync_mode_changed`, `channel_warehouse.changed`, `channel_warehouse.mapping_changed`, `stock_count.apply_requested`.
- Notifikasi: `stock.critical`, `stock_count.review` (pemegang `inventory:adjust` di gudang itu), `stock_transfer.sent` (pemegang `inventory:transfer` di gudang tujuan).

## Job (antrean `stock.push`, kecuali disebut lain)
| Job | Pemicu |
|---|---|
| `stock.mark_dirty` | `inventory.changed` |
| `inventory.stock_alert` (antrean `notify`) | `inventory.changed` |
| `stock.push` | scheduler `stock.dirty_flush` (batch 50 kunci per tenant) |
| `stock.listing_mapped` | `listing.mapped` |
| `stock.listing_unmapped` | `listing.unmapped` |
| `stock.store_resync` | `stock.resync_requested`, `store.sync_mode_changed`, `channel_warehouse.changed`, `channel_warehouse.mapping_changed` |
| `stock_count.apply` (antrean `import`) | `stock_count.apply_requested` (persetujuan, permintaan ulang, lanjutan setiap 10.000 baris) |

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
| GET | `/v1/stock-counts`, `/v1/stock-counts/{id}`, `/v1/stock-counts/{id}/lines` | `inventory:read` |
| POST, PUT | `/v1/stock-counts`, `/v1/stock-counts/{id}/lines`, `/v1/stock-counts/{id}/scan`, `/v1/stock-counts/{id}/submit` | `inventory:count` |
| POST | `/v1/stock-counts/{id}/reopen`, `/v1/stock-counts/{id}/apply`, `/v1/stock-counts/{id}/cancel` | `inventory:adjust` |
| GET | `/v1/stock-transfers`, `/v1/stock-transfers/{id}` | `inventory:read` |
| GET, POST, PATCH | `/v1/stock-transfers/destinations`, `/v1/stock-transfers`, `/v1/stock-transfers/{id}`, `.../send`, `.../receive`, `.../cancel` | `inventory:transfer` |

## Keputusan khusus modul
- Gudang pertama (`UTAMA`) dibuat modul identity saat bisnis mendaftar; gudang lain lewat `WarehouseAdminService`.
- Unit transfer yang tidak tiba tidak dicatat sebagai penyesuaian `transfer_shortage` seperti rancangan awal: unit itu sudah keluar lewat `transfer_out`, dan penyesuaian akan mengurangi stok dua kali. Opname dimulai langsung di `counting` (tanpa `draft`).
- Logika push ada di `stock-plan.ts` sebagai fungsi murni dengan uji unit; service hanya memuat data, memanggil marketplace, dan mencatat.
- Deteksi perubahan stok di luar OmniSeller (FR-MIG-07, webhook TikTok Shop tipe 71) menyusul. Peringatan stok minimum (FR-STK-07) berupa notifikasi in-app `stock.critical` dan bagian stok di email ringkasan harian (modul reporting); WhatsApp menyusul bersama pengaturan notifikasi. Purchase order dari daftar perlu restock menyusul bersama modul pembelian (FR-STK-16).
