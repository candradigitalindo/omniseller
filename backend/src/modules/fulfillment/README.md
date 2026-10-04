# Modul fulfillment

## Tanggung jawab
Pengiriman pesanan (PRD 6.5: FR-SHP-01, 02, 03, 06, 07, 16; FR-ORD-08, FR-WHS-08; backend doc 8.15, 8.21, 8.22):
- atur pickup atau drop-off lewat API marketplace, satuan maupun massal;
- label per paket;
- label banyak pesanan dalam satu PDF (thermal 100 x 150 mm atau A4 isi empat) mengikuti urutan pick list, termasuk label pesanan manual yang digambar OmniSeller dengan pengirim dari gudang pesanan;
- pick list per gudang urut rak;
- daftar kemas per pesanan, bersama label atau sendiri;
- template label kustom: strip di bawah label marketplace berisi SKU, varian, rak, catatan, dan tag;
- pelacakan paket dari marketplace;
- pengiriman yang mengikuti status pesanannya.

## Tabel yang dimiliki
- `shipment` (termasuk kolom `tracking_*`), `shipment_package`, `document_job`, `label_template`; `print_job` menyusul bersama agen cetak.
- Pesanan lewat `OrdersService` (`requireVisible`, `readIn`, `accept`, `idsByExternalIn`, `tagsIn`) dan `OrderIntakeService` (`advanceIn`, `recordIn`, `setShippingIn`); lokasi rak dan nama varian lewat `InventoryService.pickInfoIn`; nama gudang lewat `WarehousesService`; nama toko dan toko yang bisa dipakai lewat `StoresService` (`namesIn`, `stockTargetsIn`); berkas lewat `FilesService`.

## Service publik
- `FulfillmentService` (api dan worker): `arrange`, `requestLabels`, `shipmentsOf`, `requestDocument` (jenis, format, template, daftar kemas), `document`, `pickList`, `tracking`, `requestTracking`, `exportSheets` (`pengiriman.csv` ekspor data penuh, backend doc 8.18; nomor pesanan lewat `OrdersService.refsIn`).
- `LabelTemplateService` (api dan worker): `get`, `set`, `preview`, `optionsIn`.
- `PickListBuilder` (api dan worker): `buildIn`.
- Hanya worker: `FulfillmentWorkerService` (`arrange`, `fetchLabels`, `followOrder`, `labelsForOrders`, `pullTracking`) dan `DocumentRenderService` (`render`). Marketplace selalu lewat `MarketplaceGateway`, di luar transaksi.

## Aturan
- Atur kirim untuk pesanan `new` (diterima dulu), `ready_to_pack`, dan `packed`; ditolak per pesanan dengan alasan (`arrangeRefusal` di `shipping-plan.ts`). Satu pengiriman hidup per pesanan (indeks unik parsial).
- Pesanan manual tidak diatur lewat marketplace dan tidak punya baris `shipment`; atur kirim menolaknya dengan `order.manual`.
  - Labelnya digambar saat dokumen label diminta (`renderManualLabel` di `pdf.ts`), selama pesanan sudah dibayar atau COD, tidak bermasalah, punya alamat, dan belum selesai (`manualLabelRefusal`).
  - Isi label: nomor, kurir dan resi, tagihan COD, penerima, pengirim dari gudang (kontak, telepon, alamat), isi paket, berat, dan catatan pembeli. Nama bisnis dibaca lewat `TenantsService`.
- Shopee diatur per kanal logistik dan gudang dengan `mass_ship_order` (50 paket); TikTok Shop per paket dengan Ship Package. Pickup memakai alamat dan slot yang disarankan marketplace; drop-off tanpa isian. Kanal yang butuh isian lain (cabang, nama pengirim, resi penjual, kurir sendiri) diserahkan ke Seller Center dengan pesan yang jelas.
- Penolakan marketplace disimpan di `shipment.last_error`; pengiriman tetap `pending` dan boleh diatur lagi.
- Label hanya disimpan lewat `FilesService` (privat, kedaluwarsa 30 hari): isinya nama, telepon, dan alamat pembeli. Isi dan URL label tidak pernah masuk log.
- `label.fetch` gagal dengan sengaja (`LabelsPendingError`) selama resi atau label belum ada; BullMQ mengulang dengan backoff. Jangan ditangkap.
- Pengiriman mengikuti pesanan lewat `order.status_changed` dan `shipmentStepFor`; modul ini menulis pesanan hanya lewat `OrderIntakeService`.
- Dokumen kosong tidak dibuat: dokumen tanpa isi gagal dengan alasan dan daftar pesanan yang tertinggal.
- **Pelacakan** (backend doc 8.22) hanya untuk dilihat; tidak pernah mengubah status pesanan atau pengiriman.
  - Yang dilacak: pesanan marketplace yang dikirim penjual, sejak `shipped`, dari toko yang terhubung (toko baca saja juga).
  - Tahap pesanan dari gabungan paketnya (`combineParcels`): tahap yang perlu perhatian lebih dulu, lalu paket yang paling tertinggal.
  - Kejadian disimpan paling banyak 100, terbaru dulu. Deskripsinya bisa menyebut penerima, jadi tidak pernah masuk log.
  - Pesanan yang dikirim lewat Seller Center mendapat pengiriman adopsi saat pertama kali dilacak.
  - Pesanan manual mendapat tahap dari statusnya, tanpa kejadian.
  - Pembacaan adalah pekerjaan latar (`MarketplaceGateway.call(..., { background: true })`): paling banyak 30% batas laju toko, di antrean `mp.track`. Gangguan sementara menghentikan pembacaan toko itu; pesanan yang belum terbaca tidak diubah dan ikut pemindaian berikutnya. Hanya penolakan marketplace untuk satu pesanan yang disimpan sebagai `tracking_error`.
  - Paket yang dibaca job lain dalam 10 menit terakhir (sesudah status pesanan terakhir berubah) tidak dibaca lagi.
- **Template kustom** hanya menambah strip 30 mm di bawah label marketplace; label diskalakan ke ruang di atasnya dan tidak pernah ditimpa. Label pesanan manual tidak mendapat strip.
- **Daftar kemas** memuat nama pembeli dan kota tujuan, tanpa alamat lengkap. Daftar kemas sendiri hanya untuk pesanan yang masih harus dikemas (aturan pick list).

## Event
- Diterbitkan: `shipment.arrange_requested`, `shipment.label_requested`, `shipment.tracking_requested`, `document.requested`.
- Dikonsumsi: `order.status_changed` (milik `orders`); webhook `order.tracking_updated` dan `shipment.document_ready` (Shopee kode 4 dan 15).

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `shipment.arrange` | `mp.outbound` | `shipment.arrange_requested` |
| `label.fetch` | `mp.outbound` | `shipment.label_requested` (setelah atur kirim, push Shopee, atau `POST /v1/shipments/labels`) |
| `document.render` | `pdf` | `document.requested` |
| `shipment.follow_order` | `order.ingest` | `order.status_changed` |
| `shipment.tracking_pull` | `mp.track` | `shipment.tracking_requested` ("Perbarui"), jadwal `shipment.tracking_scan` (30 menit, per 50 pesanan) |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| POST | `/v1/shipments/arrange` | `shipment:arrange` |
| POST | `/v1/shipments/labels` | `shipment:print` |
| GET | `/v1/orders/{id}/shipments` | `order:read` |
| POST, GET | `/v1/documents`, `/v1/documents/{id}` | `shipment:print` |
| POST | `/v1/pick-lists` | `shipment:print` |
| GET | `/v1/orders/{id}/tracking` | `order:read` |
| POST | `/v1/orders/{id}/tracking/refresh` (202) | `order:read` |
| GET | `/v1/label-template`, `/v1/label-template/preview` | `shipment:print` |
| PUT | `/v1/label-template` | `settings:warehouse` |

## Keputusan khusus modul
- PDF dibuat dengan pdf-lib dan Noto Sans (`assets/fonts`), tanpa browser (ADR-038 di DOKUMEN-TEKNOLOGI). Manifest serah terima dan verifikasi scan (FR-SHP-04, 05) menyusul, begitu juga gelombang ambil (FR-ORD-20), agen cetak (`print_job`), penanganan gagal kirim dan RTO (FR-SHP-13), serta pelacakan pesanan manual lewat API ekspedisi.
- Pesanan yang diatur di Seller Center diadopsi saat penjual menekan "Atur kirim" atau "Ambil label", atau saat paketnya pertama kali dilacak setelah dikirim.
- Shopee tidak punya push pelacakan, jadi pelacakan dibaca lewat pemindaian setiap 30 menit: paket dalam perjalanan dibaca ulang setelah 3 jam, dan paket yang baru terkirim dibaca sekali lagi untuk kejadian terakhirnya. "Perbarui" paling sering sekali per 10 menit per pesanan.
- Dokumen Batch Ship Packages TikTok Shop tidak bisa dibaca dari portal saat implementasi, sehingga paket TikTok Shop dikirim satu per satu.
