# Modul inventory

## Tanggung jawab
Gudang, stok, pergerakan stok, aturan alokasi, dan push stok ke marketplace (PRD 6.3, 6.3.1: FR-STK-01 sampai 06, FR-WHS-04, 05, 09, FR-MFS-02, FR-MIG-05; backend doc 8.13 dan 9.4). Stock opname, transfer, pembelian, dan cadangan kampanye menyusul.

## Tabel yang dimiliki
- `warehouse`, `inventory`, `stock_movement`, `stock_allocation_rule`, `listing_stock_state`, `stock_count`, `stock_count_line`, `stock_transfer`, `stock_transfer_line`, `campaign_stock_hold`.
- Membaca listing lewat `ListingsService` (catalog), toko dan gudang marketplace lewat `StoresService` (channel), dan varian lewat view `catalog_variant_v` yang diekspor catalog.

## Modul Nest
- `InventoryModule` (`inventory-core.module.ts`, api dan worker): `WarehousesService`, `InventoryService`, `InventoryRepository`. Tidak mengimpor catalog atau channel, karena channel bergantung padanya.
- `InventoryStockModule` (api dan worker): `StockOverviewService`, `InitialStockService`, `AllocationRulesService`.
- `InventoryWorkerModule` (worker): `StockPushService`, `StockTriggersService`.
- `InventoryHttpModule` (api): `WarehousesController`, `InventoryController`, `StockRulesController`.

## Service publik
- `WarehousesService`: `list(ctx)`, `visibleIn(tx, ctx)` (cakupan gudang pengguna), `activeIn(tx)`, `findActiveIn(tx, id)`.
- `InventoryService`: `adjust(ctx, {lines, reason, note})`, `establishIn(tx, ctx, lines, meta)` (stok awal, nanti opname), `orderMovementsIn(tx, ctx, moves)` (reservasi, pelepasan, dan pengiriman pesanan; kunci baris berurutan, kekurangan stok fisik dilaporkan), `stockIn`, `pickInfoIn(tx, pairs)` (lokasi rak dan nama varian untuk pick list dan urutan label, modul fulfillment), `setLocation`, `movements`, `summary`, `warehousesIn`. Error: validasi 422 (`lines.<i>.variantId`, `lines.<i>.warehouseId`, `lines.<i>.quantity` untuk stok fisik di bawah nol, `lines.<i>` untuk baris ganda).
- `StockOverviewService.list`: daftar stok dengan status push per toko.
- `InitialStockService.fromStore(ctx, storeId, dryRun)`. Error: `store.not_found`, `store.orders_importing` (impor pesanan toko belum selesai).
- `AllocationRulesService`: `list`, `get`, `create`, `update` (`If-Match`), `remove`, `requestResync`. Error: `store.not_found`, `channel_warehouse.not_found`, `stock_rule.not_found`, `stock_rule.duplicate`, `store.not_live`, `row.stale`.
- Hanya worker: `StockPushService.push(ctx, marks)`, `StockTriggersService` (`markPairs`, `listingMapped`, `listingUnmapped`, `resyncStore`).

## Aturan
- Jumlah stok hanya berubah lewat `apply_stock_movement()` dan `confirm_stock()`, dan setiap perubahan menulis `inventory.changed` di transaksi yang sama.
- Stok yang belum pernah ditetapkan (`stock_set_at` kosong) tidak didorong. Penyesuaian, stok awal, dan konfirmasi menetapkannya; mutasi pesanan tidak.
- Penyesuaian: semua baris atau tidak sama sekali, alasan wajib, catatan wajib untuk `other`.
- Stok awal dari toko hanya mengisi stok yang belum pernah ditetapkan; `on_hand` = stok marketplace + `reserved` + `buffer`.
- Push: toko `read_only`, tidak aktif, atau dengan gudang penjual belum dipetakan tidak pernah dikirimi; gudang yang dikelola marketplace tidak pernah dikirimi; setiap listing dikirim utuh dengan semua lokasinya; satu gudang fisik tidak ditampilkan dua kali dalam satu listing; nilai yang sudah diterima marketplace tidak dikirim lagi kecuali dipaksa (mode `live`, pemetaan, dorong ulang).
- Kegagalan sementara diulang BullMQ; penolakan marketplace dicatat di `listing_stock_state` dan dicoba lagi saat stoknya berubah.

## Event
- Diterbitkan: `inventory.changed`, `stock.resync_requested`.
- Dikonsumsi: `listing.mapped`, `listing.unmapped`, `store.sync_mode_changed`, `channel_warehouse.changed`, `channel_warehouse.mapping_changed`.

## Job (antrean `stock.push`)
| Job | Pemicu |
|---|---|
| `stock.mark_dirty` | `inventory.changed` |
| `stock.push` | scheduler `stock.dirty_flush` (batch 50 kunci per tenant) |
| `stock.listing_mapped` | `listing.mapped` |
| `stock.listing_unmapped` | `listing.unmapped` |
| `stock.store_resync` | `stock.resync_requested`, `store.sync_mode_changed`, `channel_warehouse.changed`, `channel_warehouse.mapping_changed` |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/warehouses` | `inventory:read` |
| GET | `/v1/inventory`, `/v1/inventory/summary`, `/v1/inventory/movements` | `inventory:read` |
| POST | `/v1/inventory/adjustments`, `/v1/inventory/initial-stock` | `inventory:adjust` |
| PUT | `/v1/inventory/{variantId}/warehouses/{warehouseId}` | `inventory:adjust` |
| POST | `/v1/inventory/resync` | `settings:store` |
| GET, POST | `/v1/stock-allocation-rules` | `settings:store` |
| GET, PATCH, DELETE | `/v1/stock-allocation-rules/{id}` | `settings:store` |

## Keputusan khusus modul
- Gudang pertama (`UTAMA`) dibuat modul identity saat bisnis mendaftar; pembuatan dan pengubahan gudang menyusul.
- Logika push ada di `stock-plan.ts` sebagai fungsi murni dengan uji unit; service hanya memuat data, memanggil marketplace, dan mencatat.
- Deteksi perubahan stok di luar OmniSeller (FR-MIG-07, webhook TikTok Shop tipe 71) dan peringatan stok minimum (FR-STK-07) menyusul.
