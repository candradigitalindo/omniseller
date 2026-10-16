# Modul fulfillment

## Tanggung jawab
Pengiriman pesanan (PRD 6.5: FR-SHP-01, 02, 03, 04, 05, 06, 07, 16, 17; FR-ORD-08, FR-WHS-08; backend doc 8.15, 8.21, 8.22, 8.24):
- atur pickup atau drop-off lewat API marketplace, satuan maupun massal;
- label per paket;
- label banyak pesanan dalam satu PDF (thermal 100 x 150 mm atau A4 isi empat) mengikuti urutan pick list, termasuk label pesanan manual yang digambar OmniSeller dengan pengirim dari gudang pesanan;
- pick list per gudang urut rak;
- daftar kemas per pesanan, bersama label atau sendiri;
- template label kustom: strip di bawah label marketplace berisi SKU, varian, rak, catatan, dan tag;
- pelacakan paket dari marketplace;
- label barcode internal varian (FR-PRD-12, backend doc 8.23): EAN-13, EAN-8, atau Code 128 pada label 50 x 30, 40 x 30, atau A4 3 x 10;
- pengiriman yang mengikuti status pesanannya;
- agen cetak lokal dan pekerjaan cetaknya (FR-SHP-17, backend doc 8.24): pasang, printer label dan A4, antrean, cetak percobaan, scan untuk cetak;
- kemas dengan scan (FR-SHP-04): isi paket dicocokkan dengan pesanan sebelum dikemas;
- serah terima kurir (FR-SHP-05): manifest per gudang dan kurir, pindai resi, serahkan, manifest PDF;
- cetak label otomatis untuk aturan otomatis (FR-SHP-18, backend doc 8.37): label yang siap dicetak ke agen aturan, satu dokumen per agen dan tata letak.

## Tabel yang dimiliki
- `shipment` (termasuk kolom `tracking_*` dan `auto_print`: instruksi cetak aturan otomatis), `shipment_package`, `document_job`, `label_template`, `print_job`, `handover`, `handover_item`.
- Baris `device` milik `identity`: dibaca dan ditulis lewat `DevicesService` (`createIn`, `getIn`, `activeIn`, `updateIn`, `revokeIn`, `reportIn`).
- Pesanan lewat `OrdersService` (`requireVisible`, `readIn`, `accept`, `idsByExternalIn`, `tagsIn`) dan `OrderIntakeService` (`advanceIn`, `recordIn`, `setShippingIn`); lokasi rak dan nama varian lewat `InventoryService.pickInfoIn`; nama gudang lewat `WarehousesService`; nama toko dan toko yang bisa dipakai lewat `StoresService` (`namesIn`, `stockTargetsIn`); berkas lewat `FilesService`.

## Service publik
- `FulfillmentService` (api dan worker): `arrange` (dengan `{ autoPrint }` dari aturan otomatis), `requestLabels`, `shipmentsOf`, `requestDocument` (jenis, format, template, daftar kemas), `document`, `pickList`, `tracking`, `requestTracking`, `exportSheets` (`pengiriman.csv` ekspor data penuh, backend doc 8.18; nomor pesanan lewat `OrdersService.refsIn`).
- `LabelTemplateService` (api dan worker): `get`, `set`, `preview`, `optionsIn`.
- `FulfillmentService.requestBarcodeLabels` (dokumen `barcode_labels`) dan `deleteForOrdersIn` (modul retention: pengiriman dihapus, label dan dokumen PDF pesanan itu kedaluwarsa seketika lewat `FilesService.expireIn`).
- `FulfillmentService.anonymizeIn` (modul retention, masa simpan data pembeli, backend doc 8.34): keterangan kejadian pelacakan dikosongkan (waktu, tahap, dan lokasi tetap), label pengiriman, label paket, dan dokumen cetak pesanan itu kedaluwarsa.
- `PickListBuilder` (api dan worker): `buildIn` (bagian per gudang, yang tertinggal, dan `orderIds` pesanan yang barangnya diambil).
- Hanya worker: `FulfillmentWorkerService` (`arrange`, `fetchLabels`, `followOrder`, `labelsForOrders`, `pullTracking`), `DocumentRenderService` (`render`; juga manifest serah terima dan halaman uji agen), dan `AutoPrintService` (`printDue`: job `shipment.auto_print`). Marketplace selalu lewat `MarketplaceGateway`, di luar transaksi.
- `PrintService` (api dan worker): `queueIn` (pekerjaan untuk sebuah dokumen), `agentIn` (agen cetak yang boleh dipakai pemanggil), `push` (setelah commit), `printDocument`, `list`, `get`, `retry`, `cancel`, `cancelForDeviceIn`, `documentFinishedIn` (worker), dan rute agen `pending`, `take`, `report`, `agentStatus`.
- `PrintAgentsService` (api): `list`, `get`, `create`, `update`, `revoke`, `testPrint`.
- `ScanService` (api): `orderIn` (pesanan dari nomor pesanan atau resi), `labelRefusalIn`, `printLabelIn`, `scanToPrint`.
- `PackingService` (api): `lookup`, `complete`. `HandoverService` (api): `open`, `couriers`, `scan`, `removeItem`, `complete`, `cancel`, `manifest`, `list`, `get`, `exportSheets` (`serah_terima.csv`).

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
- Dokumen yang selesai menulis riwayat pesanannya atas nama peminta: `label_printed`, `pick_list_printed`, dan `packing_list_printed` (daftar kemas sendiri, atau bersama label untuk pesanan yang labelnya tercetak). Laporan kinerja tim menghitungnya (backend doc 8.35).
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
- **Label barcode** (`renderBarcodeLabels`): barcode varian, atau SKU-nya bila tidak punya; simbol dari `common/barcode.ts` digambar sebagai persegi panjang selebar kelipatan titik printer 203 dpi (`moduleWidth`). Batang di bawah dua titik dicatat di `result.dense`; kode di luar ASCII dan varian yang dihapus masuk `missing` dengan `variantId`. Paling banyak 2.000 label per dokumen.

- **Agen cetak.** Token sekali tampil, hanya hash yang disimpan; dicabut, bukan dihapus. Pengguna dengan cakupan gudang hanya memakai agen gudangnya dan agen tanpa gudang. Printer pekerjaan: yang diminta, lalu printer agen untuk kertasnya (`paperOf`: label atau A4), lalu printer bawaan komputer.
- **Pekerjaan cetak.** Dibuat bersama dokumennya dan menunggu worker; worker memasang berkas lalu mendorong `print.job` setelah commit (`PrintService.push`). Agen mengambil berkas (`sent`), lalu melapor `printed` atau `failed`. Socket bisa terlewat: agen membaca daftar tertunda lewat REST. Pengguna bercakupan toko atau gudang melihat permintaannya sendiri dan pekerjaan sistem di agen yang melayani gudangnya (`visibleTo`), serta dokumen sistem yang semua pesanannya dalam cakupan.
- **Cetak otomatis** (backend doc 8.37). `arrange` menyimpan instruksi aturan di `shipment.auto_print` (`{deviceId, format, template, packingList, ruleId, until}`); `completeLabelsIn` menulis `shipment.print_due` bila ada; job `shipment.auto_print` (tunda 20 detik) mengunci semua pengiriman `label_ready` atau `packed` yang masih membawa instruksi dan mencetaknya dalam satu dokumen `labels` per agen dan tata letak lewat `requestDocumentIn` dan `PrintService.queueIn` (judul "Label N pesanan (otomatis)"), sebagai sistem. Dilewati atau ditolak dengan riwayat `auto_print`: sudah dicetak sejak diatur (`auto_print.already_printed`), lebih dari 12 jam (`auto_print.expired`), paket tanpa `auto_process`, agen dicabut atau gudang lain, atau alasan label biasa. Instruksi dikosongkan begitu diputuskan: paling banyak sekali per pengiriman.
- **Scan.** `ScanService.orderIn` mencari nomor pesanan, resi pesanan, resi pengiriman, dan resi paket, persis atau huruf besar, dalam cakupan pengguna; dua pesanan atau lebih: 409 `scan.ambiguous`. Penolakan label memakai kode dokumen label (`labelRefusal`).
- **Kemas dengan scan.** Server memeriksa ulang semua pindaian (`checkPacking`): jumlah per baris sama persis, tanpa kode asing; lalu `OrdersService.packIn` dengan aturan "Tandai dikemas". Label yang belum siap tidak membatalkan pengemasan. `seconds` dari stasiun (waktu sejak pesanan dipindai) disimpan di riwayat untuk menit kemas per pesanan (backend doc 8.35).
- **Serah terima.** Satu manifest terbuka per gudang dan kurir. Pindai memeriksa gudang, kurir (`courierMatches`), status (`handoverRefusal`), dan manifest terbuka lain; kunci pesanan mencegah satu paket di dua manifest. Selesai memeriksa ulang semua paket, lalu semua atau tidak sama sekali: pengiriman marketplace `handed_over`, pesanan manual dikirim. Kunci pengiriman dulu, baru pesanan. Manifest A4 tanpa data pembeli.

## Event
- Diterbitkan: `shipment.arrange_requested`, `shipment.label_requested`, `shipment.tracking_requested`, `document.requested`, `shipment.print_due` (label pengiriman beraturan cetak sudah tersimpan).
- Dikonsumsi: `order.status_changed` (milik `orders`); webhook `order.tracking_updated` dan `shipment.document_ready` (Shopee kode 4 dan 15).

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `shipment.arrange` | `mp.outbound` | `shipment.arrange_requested` |
| `label.fetch` | `mp.outbound` | `shipment.label_requested` (setelah atur kirim, push Shopee, atau `POST /v1/shipments/labels`) |
| `shipment.auto_print` | `order.ingest` | `shipment.print_due`; id `shipment.auto_print\|<shipment_id>`, tunda 20 detik |
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
| POST | `/v1/documents/barcode-labels` | `shipment:print` |
| POST | `/v1/pick-lists` | `shipment:print` |
| GET | `/v1/orders/{id}/tracking` | `order:read` |
| POST | `/v1/orders/{id}/tracking/refresh` (202) | `order:read` |
| GET | `/v1/label-template`, `/v1/label-template/preview` | `shipment:print` |
| PUT | `/v1/label-template` | `settings:warehouse` |
| GET | `/v1/print-agents`, `/v1/print-agents/{id}` | `shipment:print` |
| POST, PATCH, DELETE | `/v1/print-agents`, `/v1/print-agents/{id}` | `settings:warehouse` |
| POST | `/v1/print-agents/{id}/test-print` | `shipment:print` |
| GET, POST | `/v1/print-jobs`, `/v1/print-jobs/{id}`, `/v1/print-jobs/{id}/retry`, `/v1/print-jobs/{id}/cancel` | `shipment:print` |
| POST | `/v1/print-jobs/scan` | `shipment:print` |
| PUT, GET, POST | `/v1/agent/status`, `/v1/agent/print-jobs`, `/v1/agent/print-jobs/{id}/file`, `/v1/agent/print-jobs/{id}/result`, `/v1/agent/print-jobs/{id}/retry`, `/v1/agent/test-print` | token agen cetak (`Bearer`) |
| GET, POST | `/v1/packing/lookup`, `/v1/packing/orders/{id}/complete` | `shipment:pack` |
| GET, POST, DELETE | `/v1/handovers`, `/v1/handovers/couriers`, `/v1/handovers/{id}`, `.../scan`, `.../items/{itemId}`, `.../complete`, `.../cancel`, `.../manifest` | `shipment:handover` |

## Keputusan khusus modul
- PDF dibuat dengan pdf-lib dan Noto Sans (`assets/fonts`), tanpa browser (ADR-038 di DOKUMEN-TEKNOLOGI). Font dan penyesuaian teks (`embedFonts`, `clipText`, `wrapText`, `drawable`) ada di `common/pdf-text.ts`, dipakai bersama PDF tagihan (billing). Menyusul: gelombang ambil (FR-ORD-20), penanganan gagal kirim dan RTO (FR-SHP-13), pelacakan pesanan manual lewat API ekspedisi.
- Pesanan dengan beberapa paket tercatat sekali di manifest, dengan resi yang dipindai pertama.
- Manifest tidak mengubah status pesanan marketplace: "Dikirim" datang dari marketplace saat kurir memindai paket.
- Pesanan yang diatur di Seller Center diadopsi saat penjual menekan "Atur kirim" atau "Ambil label", atau saat paketnya pertama kali dilacak setelah dikirim.
- Shopee tidak punya push pelacakan, jadi pelacakan dibaca lewat pemindaian setiap 30 menit: paket dalam perjalanan dibaca ulang setelah 3 jam, dan paket yang baru terkirim dibaca sekali lagi untuk kejadian terakhirnya. "Perbarui" paling sering sekali per 10 menit per pesanan.
- Dokumen Batch Ship Packages TikTok Shop tidak bisa dibaca dari portal saat implementasi, sehingga paket TikTok Shop dikirim satu per satu.

## Desktop M51

Agen Electron ada di `print-agent/` (lihat `print-agent/README.md` dari root). Status perangkat menerima nama dan printer opsional, tidak menimpa pilihan saat heartbeat biasa. Halaman percobaan dan cetak ulang perangkat memakai rute Bearer sendiri; device id selalu dari konteks, dan pekerjaan perangkat lain ditolak 404. Push/daftar membawa `attempt` yang tetap pada unduhan ulang dan bertambah saat retry eksplisit. Agen menyertakannya dalam unduhan dan laporan: percobaan lama ditolak 409 `print_job.stale_attempt` sebelum perubahan status. Kolom `attempts` yang sudah ada menjadi sumber nomornya, tanpa migrasi baru.

SQLite desktop menyimpan hasil sebelum ACK; restart dalam jendela OS-call meminta pemeriksaan keluaran. `printed` berarti diterima spooler. Hasil gagal dari agen berupa kode aman, bukan isi PDF/URL atau data pembeli.
