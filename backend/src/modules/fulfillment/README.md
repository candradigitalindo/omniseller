# Modul fulfillment

## Tanggung jawab
Pengiriman pesanan marketplace (PRD 6.5: FR-SHP-01, 02, 06; FR-ORD-08, FR-WHS-08; backend doc 8.15): atur pickup atau drop-off lewat API marketplace, satuan maupun massal; label per paket; label banyak pesanan dalam satu PDF (thermal 100 x 150 mm atau A4 isi empat) mengikuti urutan pick list; pick list per gudang urut rak; pengiriman yang mengikuti status pesanannya.

## Tabel yang dimiliki
- `shipment`, `shipment_package`, `document_job`; `print_job` menyusul bersama agen cetak.
- Pesanan lewat `OrdersService` (`requireVisible`, `readIn`, `accept`, `idsByExternalIn`) dan `OrderIntakeService` (`advanceIn`, `recordIn`, `setShippingIn`); lokasi rak dan nama varian lewat `InventoryService.pickInfoIn`; nama gudang lewat `WarehousesService`; berkas lewat `FilesService`.

## Service publik
- `FulfillmentService` (api): `arrange`, `requestLabels`, `shipmentsOf`, `requestDocument`, `document`, `pickList`.
- `PickListBuilder` (api dan worker): `buildIn`.
- Hanya worker: `FulfillmentWorkerService` (`arrange`, `fetchLabels`, `followOrder`, `labelsForOrders`) dan `DocumentRenderService` (`render`). Marketplace selalu lewat `MarketplaceGateway`, di luar transaksi.

## Aturan
- Atur kirim untuk pesanan `new` (diterima dulu), `ready_to_pack`, dan `packed`; ditolak per pesanan dengan alasan (`arrangeRefusal` di `shipping-plan.ts`). Satu pengiriman hidup per pesanan (indeks unik parsial).
- Shopee diatur per kanal logistik dan gudang dengan `mass_ship_order` (50 paket); TikTok Shop per paket dengan Ship Package. Pickup memakai alamat dan slot yang disarankan marketplace; drop-off tanpa isian. Kanal yang butuh isian lain (cabang, nama pengirim, resi penjual, kurir sendiri) diserahkan ke Seller Center dengan pesan yang jelas.
- Penolakan marketplace disimpan di `shipment.last_error`; pengiriman tetap `pending` dan boleh diatur lagi.
- Label hanya disimpan lewat `FilesService` (privat, kedaluwarsa 30 hari): isinya nama, telepon, dan alamat pembeli. Isi dan URL label tidak pernah masuk log.
- `label.fetch` gagal dengan sengaja (`LabelsPendingError`) selama resi atau label belum ada; BullMQ mengulang dengan backoff. Jangan ditangkap.
- Pengiriman mengikuti pesanan lewat `order.status_changed` dan `shipmentStepFor`; modul ini menulis pesanan hanya lewat `OrderIntakeService`.
- Dokumen kosong tidak dibuat: dokumen tanpa isi gagal dengan alasan dan daftar pesanan yang tertinggal.

## Event
- Diterbitkan: `shipment.arrange_requested`, `shipment.label_requested`, `document.requested`.
- Dikonsumsi: `order.status_changed` (milik `orders`); webhook `order.tracking_updated` dan `shipment.document_ready` (Shopee kode 4 dan 15).

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `shipment.arrange` | `mp.outbound` | `shipment.arrange_requested` |
| `label.fetch` | `mp.outbound` | `shipment.label_requested` (setelah atur kirim, push Shopee, atau `POST /v1/shipments/labels`) |
| `document.render` | `pdf` | `document.requested` |
| `shipment.follow_order` | `order.ingest` | `order.status_changed` |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| POST | `/v1/shipments/arrange` | `shipment:arrange` |
| POST | `/v1/shipments/labels` | `shipment:print` |
| GET | `/v1/orders/{id}/shipments` | `order:read` |
| POST, GET | `/v1/documents`, `/v1/documents/{id}` | `shipment:print` |
| POST | `/v1/pick-lists` | `shipment:print` |

## Keputusan khusus modul
- PDF dibuat dengan pdf-lib dan Noto Sans (`assets/fonts`), tanpa browser (ADR-038 di DOKUMEN-TEKNOLOGI). Packing list, label kustom, manifest serah terima, dan verifikasi scan (FR-SHP-03, 04, 05, 16) menyusul, begitu juga gelombang ambil (FR-ORD-20), agen cetak (`print_job`), dan pelacakan (FR-SHP-07).
- Pesanan yang diatur di Seller Center diadopsi saat penjual menekan "Atur kirim" atau "Ambil label"; OmniSeller tidak memantau semua pesanan untuk itu.
- Dokumen Batch Ship Packages TikTok Shop tidak bisa dibaca dari portal saat implementasi, sehingga paket TikTok Shop dikirim satu per satu.
