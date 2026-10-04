# Modul orders

## Tanggung jawab
Pesanan dari semua toko dalam satu antrean (PRD 6.4: FR-ORD-01 sampai 10, 12, 13, 14, 15; FR-INT-04, 05, FR-WHS-06, 07, 09, 10, FR-RET-04, FR-MFS-03, FR-MIG-04, 05; backend doc 8.14, 8.21):
- pesanan masuk dari webhook, polling, dan impor 90 hari;
- pesanan manual dari WhatsApp, Instagram, atau toko offline;
- status terpadu dan reservasi stok;
- alokasi dan pindah gudang;
- masalah otomatis, aksi penjual, tag, dan riwayat aktivitas.

## Tabel yang dimiliki
- `order`, `order_external_ref`, `order_item`, `order_event`, `order_problem`, `tag`, `order_tag`, `pick_wave`.
- Data modul lain dibaca lewat service pemiliknya:
  - stok lewat `InventoryService.orderMovementsIn`, `stockIn`, `allocateIn`, dan `variantsIn`;
  - listing lewat `ListingsService`;
  - toko, gudang marketplace, dan saluran manual lewat `StoresService`;
  - zona waktu bisnis lewat `TenantsService`.
- Nomor pesanan manual diambil dari `document_sequence` (`nextDocumentNumber`), dan Idempotency-Key dicatat di `idempotency_record` (`claimIdempotencyKey`).

## Service publik
- `OrdersService` (api):
  - `list` (filter `tagId`), `summary`, `get` (dengan `warehouseFixed`), `accept`, `pack`;
  - `cancelReasons` dan `requestCancel` (pesanan manual: alasan OmniSeller, dibatalkan seketika);
  - `setNote`, `resolveProblem`, `requestSync`, `changeWarehouse`.

  Error: `order.not_found`, `order.not_cancellable`, validasi alasan batal (422), `order_problem.not_found`, `store.not_found`, `store.manual`, `store.read_only`, `order.warehouse_fixed`, `order.status_invalid`.
- `ManualOrdersService` (api dan worker, di `OrdersModule`; backend doc 8.21): `create` (dengan Idempotency-Key), `update`, `markPaid`, `ship`, `complete`; `shipIn` (kirim di transaksi pemanggil untuk pesanan yang sudah dikunci, dipakai serah terima kurir, 8.24). Error: `order.not_manual`, `order.unpaid`, `order.has_problems`, `order.no_address`, `order.no_warehouse`, `idempotency.key_reused`, dan validasi baris, diskon, serta telepon penerima.
- `TagsService` (api): `list`, `create`, `update`, `remove`, `assign`. Error: `tag.not_found`, `tag.duplicate`, `tag.limit`, tag tidak dikenal (422).
- `OrderIntakeService` (api dan worker, di dalam transaksi pemanggil): `applyIn` (satu snapshot marketplace; alokasi otomatis untuk toko yang mengaktifkannya), `createIn` (pesanan yang dibuat OmniSeller), `moveWarehouseIn`, `stepIn`, `settleIn`, `attachListingIn`, `recheckStockIn`; untuk modul fulfillment: `advanceIn` (langkah penjual bila status masih sesuai), `recordIn` (riwayat), `setShippingIn` (resi dan kurir).
- `OrdersService` untuk pindai, kemas, dan serah terima (backend doc 8.24, di transaksi pemanggil): `byCodeIn` (pesanan dari nomor pesanan atau resi, persis atau huruf besar, dalam cakupan), `visibleManyIn`, `packRefusalIn` dan `packIn` (aturan "Tandai dikemas" untuk satu pesanan yang dikunci; penolakan 409 dengan kode yang sama), `lockIn` (mengunci pesanan urut id, tanpa cek cakupan), `manualAwaitingIn` (pesanan manual satu gudang yang dikemas dan menunggu kurir).
- `OrdersService` untuk modul lain: `requireVisible` (semua id harus terlihat pemanggil, atau 404), `readIn`, `idsByExternalIn`, `refsIn` (nomor pesanan dan toko), `tagsIn` (nama tag per pesanan, untuk label dan daftar kemas, 8.22), `visibleIn` (satu pesanan dalam cakupan, di transaksi pemanggil), `openInWarehouseIn` (pesanan yang belum dikirim dari satu gudang, untuk penghapusan gudang), `statusCountsIn` (pesanan satu toko per status sejak suatu waktu, mode paralel 8.19); untuk dasbor (backend doc 8.16, di transaksi dan cakupan pemanggil): `summaryIn`, `urgentIn`, `salesIn`, `salesByDayIn`, `topProductsIn`, `grossProfitIn`; untuk laporan penjualan dan email harian (8.20, filter `SalesFilter` toko dan marketplace): `salesBucketsIn` (per hari, minggu, atau bulan di zona waktu bisnis), `salesByIn` (per marketplace, toko, atau provinsi pembeli), `salesByHourIn`, `itemSalesIn` (per varian atau kategori), `unitsSoldIn`, `cancellationsIn` (dibayar lalu dibatalkan), `shippedIn` (menurut `shipped_at`); untuk perlu restock: `unitsByStockIn` (unit terjual pesanan penjual per varian dan gudang); untuk ekspor data (8.18): `exportSheets` (`pesanan.csv`, `item_pesanan.csv`).
- Untuk toko yang diputus (FR-INT-07, backend doc 8.23): `OrdersService.releaseDisconnectedStore` (job `order.store_disconnected`), `storeOrderIdsIn` dan `deleteOrdersIn` (modul retention: stok yang masih ditahan dilepas, lalu pesanan dihapus beserta baris, riwayat, masalah, referensi, dan tagnya), `OrderIntakeService.releaseForDisconnectIn`.
- Hanya worker: `OrderSyncService` (`ingest`, `refresh`, `pull`, `cancel`, `attachListing`, `recheckStock`); marketplace selalu lewat `MarketplaceGateway`. `OrderAlertsService`: `alertDue` (peringatan batas kirim, FR-SHP-10) dan `notifyNewOrders` (ringkasan pesanan baru, FR-NTF-01).

## Aturan
- Satu pesanan per toko dan id marketplace (`order_external_ref`); notifikasi ganda dan balapan dua webhook tidak pernah membuat pesanan ganda.
- Id pesanan dari waktu pesanan dibuat (`newIdAt`), jadi urutan id sama dengan urutan waktu pesanan.
- Status hanya maju. Snapshot yang lebih tua dari `external_updated_at` diabaikan; fakta yang melompati langkah penjual berjalan di `withStatusSource(tx, "marketplace")`.
- Stok mengikuti status: `unpaid` sampai `ready_to_ship` menahan unit yang belum dibatalkan, status terkirim mengeluarkan hanya unit yang ditahan, `cancelled` melepasnya. Pesanan marketplace dan baris tanpa varian atau gudang tidak menyentuh stok.
- Gudang baris dari marketplace (Shopee `product_location_id`, TikTok Shop `warehouse_id`) lewat pemetaan `channel_warehouse`; tanpa pemetaan menjadi masalah `unmapped_warehouse`.
- Masalah dibuka dan ditutup otomatis; yang ditutup penjual tidak dibuka lagi. `new` dengan masalah terbuka menjadi `problem`.
- Toko `read_only` tetap menerima pesanan dan menahan stok, tetapi aksi penjual ditolak (mode paralel, FR-MIG-05).
- **Toko yang diputus** (FR-INT-07): pesanan terbukanya melepas stok yang ditahan (riwayat `store_disconnected`, status tetap), dan tidak menahannya lagi: pemetaan listing (`attachListingIn`) dan cek ulang stok (`recheckStockIn`) melewati toko yang diputus. Pesanan terbuka itu tidak tampil di antrean, penghitung tab, dan daftar mendesak dasbor (`hiddenStoreIds` di `OrderListFilter`), kecuali difilter `storeId` toko itu; laporan penjualan tetap menghitung riwayatnya.
- Telepon dan alamat pembeli hanya untuk peran dengan `order:accept`, `shipment:print`, atau `order:write`. Data pembeli tidak pernah masuk log; connector menyamarkannya di log sinkron.
- **Pesanan manual** ada di toko berkanal `manual` dan berjalan lewat setiap langkah penjual (`pathTo`).
  - Uangnya sama artinya dengan pesanan marketplace: total baris, subtotal, diskon, ongkir, total.
  - Status awal `new` untuk COD dan yang sudah dibayar, `unpaid` untuk lainnya.
  - Nomornya `MN-YYMM-NNNN`.
  - Tidak ada notifikasi "pesanan baru" untuknya.
- **Pindah gudang** hanya sebelum dikemas, dan hanya bila gudangnya tidak ditetapkan marketplace: pesanan manual, atau toko dengan paling banyak satu gudang penjual aktif (`warehouseFixed`).

## Event
- Diterbitkan: `order.pull_requested` (tarik ulang atau lanjutan), `order.cancel_requested`, `order.status_changed` (setiap langkah status, dari `stepIn`; dikonsumsi modul fulfillment).
- Dikonsumsi: `store.connected` (impor 90 hari), `store.disconnected` (stok pesanan terbuka dilepas), `listing.mapped` (pasang varian, reservasi), `inventory.changed` (cek ulang stok kurang); webhook `order.status_changed` dan `order.tracking_updated` (baca ulang pesanan).

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `order.pull` | `mp.poll` | `store.connected`, `order.pull_requested`, jadwal `mp.poll.orders` (5 menit) |
| `order.cancel` | `mp.outbound` | `order.cancel_requested` |
| `order.listing_mapped` | `order.ingest` | `listing.mapped` |
| `order.stock_recheck` | `order.ingest` | `inventory.changed` |
| `order.sla_alert` | `notify` | jadwal `order.sla_scan` (5 menit, per tenant dengan pesanan jatuh tempo) |
| `order.new_notice` | `notify` | jadwal `order.new_scan` (5 menit, per tenant dengan pesanan bertanda `notify_new`) |
| `order.store_disconnected` | `order.ingest` | `store.disconnected` (200 pesanan per transaksi) |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/orders`, `/v1/orders/summary`, `/v1/orders/{id}` | `order:read` |
| POST | `/v1/orders/accept` | `order:accept` |
| POST | `/v1/orders/pack` | `shipment:pack` |
| GET | `/v1/orders/{id}/cancel-reasons` | `order:cancel` |
| POST | `/v1/orders/{id}/cancel` | `order:cancel` |
| PUT | `/v1/orders/{id}/note` | `order:tag` |
| POST | `/v1/orders/{id}/problems/{problemId}/resolve` | `order:accept` |
| POST | `/v1/orders/sync` | `settings:store` |
| POST | `/v1/orders/manual` (Idempotency-Key) | `order:write` |
| PATCH | `/v1/orders/{id}` (pesanan manual) | `order:write` |
| POST | `/v1/orders/{id}/pay`, `/v1/orders/{id}/complete` | `order:write` |
| POST | `/v1/orders/{id}/ship` | `shipment:handover` |
| PUT | `/v1/orders/{id}/warehouse` | `order:accept` |
| POST | `/v1/orders/tags` | `order:tag` |
| GET | `/v1/tags` | `order:read` |
| POST, PATCH, DELETE | `/v1/tags`, `/v1/tags/{id}` | `order:tag` |

## Keputusan khusus modul
- Shopee dan TikTok Shop tidak punya API "terima pesanan": "Terima" adalah langkah internal. Mengatur pengiriman, label, dan resi ada di modul fulfillment; resi ditulis ke pesanan lewat `setShippingIn`.
- Notifikasi pesanan baru (backend doc 8.17): `order.notify_new` diisi saat pesanan penjual pertama kali perlu diproses (masuk `new` setelah impor 90 hari tokonya selesai, atau `unpaid` menjadi `new`); setiap 5 menit satu ringkasan per pengguna dengan `order:accept`, per toko di cakupannya. Toko baca saja tidak diumumkan.
- Penjualan di dasbor: pesanan yang bukan `unpaid` dan bukan `cancelled`, menurut `ordered_at`.
- Peringatan batas kirim: sekali per tingkat (`order.sla_alert_level`: `warning` pada 6 jam, `overdue` setelah lewat) untuk pesanan penjual yang masih harus dikirim, ke pengguna dengan `shipment:arrange` sesuai cakupannya; toko baca saja tidak diperingatkan.
- Menjawab permintaan batal pembeli (Shopee `handle_buyer_cancellation`, TikTok Shop Approve/Reject Cancellation) menyusul.
- Alokasi otomatis untuk pesanan marketplace dihitung sekali saat pesanan masuk. Alamat pengirim di label marketplace tetap alamat toko di marketplace.
- Pesanan manual tidak bisa diubah barangnya: batalkan lalu buat baru. Pesanan tautan untuk pembeli (FR-ORD-21) menyusul.
- Ambang nilai tidak wajar Rp10.000.000 masih konstanta; menjadi pengaturan bisnis nanti.
