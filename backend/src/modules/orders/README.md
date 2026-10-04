# Modul orders

## Tanggung jawab
Pesanan dari semua toko dalam satu antrean (PRD 6.4: FR-ORD-01, 02, 03, 05, 06, 07, 08, 10, 13, 14, 15; FR-INT-04, 05, FR-WHS-06, 09, 10, FR-RET-04, FR-MFS-03, FR-MIG-04, 05; backend doc 8.14): masuknya pesanan dari webhook, polling, dan impor 90 hari; status terpadu; reservasi stok; masalah otomatis; aksi penjual; riwayat aktivitas.

## Tabel yang dimiliki
- `order`, `order_external_ref`, `order_item`, `order_event`, `order_problem`, `tag`, `order_tag`, `pick_wave`.
- Stok lewat `InventoryService.orderMovementsIn` dan `stockIn`, listing lewat `ListingsService`, toko dan gudang marketplace lewat `StoresService`.

## Service publik
- `OrdersService` (api): `list`, `summary`, `get`, `accept`, `pack`, `cancelReasons`, `requestCancel`, `setNote`, `resolveProblem`, `requestSync`. Error: `order.not_found`, `order.not_cancellable`, validasi alasan batal (422), `order_problem.not_found`, `store.not_found`.
- `OrderIntakeService` (api dan worker, di dalam transaksi pemanggil): `applyIn` (satu snapshot marketplace), `stepIn`, `settleIn`, `attachListingIn`, `recheckStockIn`; untuk modul fulfillment: `advanceIn` (langkah penjual bila status masih sesuai), `recordIn` (riwayat), `setShippingIn` (resi dan kurir).
- `OrdersService` untuk modul lain: `requireVisible` (semua id harus terlihat pemanggil, atau 404), `readIn`, `idsByExternalIn`, `refsIn` (nomor pesanan dan toko), `statusCountsIn` (pesanan satu toko per status sejak suatu waktu, mode paralel 8.19); untuk dasbor (backend doc 8.16, di transaksi dan cakupan pemanggil): `summaryIn`, `urgentIn`, `salesIn`, `salesByDayIn`, `topProductsIn`, `grossProfitIn`; untuk ekspor data (8.18): `exportSheets` (`pesanan.csv`, `item_pesanan.csv`).
- Hanya worker: `OrderSyncService` (`ingest`, `refresh`, `pull`, `cancel`, `attachListing`, `recheckStock`); marketplace selalu lewat `MarketplaceGateway`. `OrderAlertsService`: `alertDue` (peringatan batas kirim, FR-SHP-10) dan `notifyNewOrders` (ringkasan pesanan baru, FR-NTF-01).

## Aturan
- Satu pesanan per toko dan id marketplace (`order_external_ref`); notifikasi ganda dan balapan dua webhook tidak pernah membuat pesanan ganda.
- Id pesanan dari waktu pesanan dibuat (`newIdAt`), jadi urutan id sama dengan urutan waktu pesanan.
- Status hanya maju. Snapshot yang lebih tua dari `external_updated_at` diabaikan; fakta yang melompati langkah penjual berjalan di `withStatusSource(tx, "marketplace")`.
- Stok mengikuti status: `unpaid` sampai `ready_to_ship` menahan unit yang belum dibatalkan, status terkirim mengeluarkan hanya unit yang ditahan, `cancelled` melepasnya. Pesanan marketplace dan baris tanpa varian atau gudang tidak menyentuh stok.
- Gudang baris dari marketplace (Shopee `product_location_id`, TikTok Shop `warehouse_id`) lewat pemetaan `channel_warehouse`; tanpa pemetaan menjadi masalah `unmapped_warehouse`.
- Masalah dibuka dan ditutup otomatis; yang ditutup penjual tidak dibuka lagi. `new` dengan masalah terbuka menjadi `problem`.
- Toko `read_only` tetap menerima pesanan dan menahan stok, tetapi aksi penjual ditolak (mode paralel, FR-MIG-05).
- Telepon dan alamat pembeli hanya untuk peran dengan `order:accept`, `shipment:print`, atau `order:write`. Data pembeli tidak pernah masuk log; connector menyamarkannya di log sinkron.

## Event
- Diterbitkan: `order.pull_requested` (tarik ulang atau lanjutan), `order.cancel_requested`, `order.status_changed` (setiap langkah status, dari `stepIn`; dikonsumsi modul fulfillment).
- Dikonsumsi: `store.connected` (impor 90 hari), `listing.mapped` (pasang varian, reservasi), `inventory.changed` (cek ulang stok kurang); webhook `order.status_changed` dan `order.tracking_updated` (baca ulang pesanan).

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `order.pull` | `mp.poll` | `store.connected`, `order.pull_requested`, jadwal `mp.poll.orders` (5 menit) |
| `order.cancel` | `mp.outbound` | `order.cancel_requested` |
| `order.listing_mapped` | `order.ingest` | `listing.mapped` |
| `order.stock_recheck` | `order.ingest` | `inventory.changed` |
| `order.sla_alert` | `notify` | jadwal `order.sla_scan` (5 menit, per tenant dengan pesanan jatuh tempo) |
| `order.new_notice` | `notify` | jadwal `order.new_scan` (5 menit, per tenant dengan pesanan bertanda `notify_new`) |

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

## Keputusan khusus modul
- Shopee dan TikTok Shop tidak punya API "terima pesanan": "Terima" adalah langkah internal. Mengatur pengiriman, label, dan resi ada di modul fulfillment; resi ditulis ke pesanan lewat `setShippingIn`.
- Notifikasi pesanan baru (backend doc 8.17): `order.notify_new` diisi saat pesanan penjual pertama kali perlu diproses (masuk `new` setelah impor 90 hari tokonya selesai, atau `unpaid` menjadi `new`); setiap 5 menit satu ringkasan per pengguna dengan `order:accept`, per toko di cakupannya. Toko baca saja tidak diumumkan.
- Penjualan di dasbor: pesanan yang bukan `unpaid` dan bukan `cancelled`, menurut `ordered_at`.
- Peringatan batas kirim: sekali per tingkat (`order.sla_alert_level`: `warning` pada 6 jam, `overdue` setelah lewat) untuk pesanan penjual yang masih harus dikirim, ke pengguna dengan `shipment:arrange` sesuai cakupannya; toko baca saja tidak diperingatkan.
- Menjawab permintaan batal pembeli (Shopee `handle_buyer_cancellation`, TikTok Shop Approve/Reject Cancellation), tag pesanan (FR-ORD-04), dan pesanan manual (FR-ORD-09) menyusul.
- Ambang nilai tidak wajar Rp10.000.000 masih konstanta; menjadi pengaturan bisnis nanti.
