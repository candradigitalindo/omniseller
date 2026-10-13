# Modul automation

## Tanggung jawab
Aturan proses pesanan otomatis (PRD FR-ORD-19 dan FR-CMP-06, layar L55, backend doc 8.37), mulai paket Growth (fitur `auto_process`): pesanan marketplace baru diperiksa terhadap aturan aktif sesuai urutan, dan aturan pertama yang cocok memprosesnya (pindah gudang, beri tag, terima, atur pickup atau drop-off) sekali, sebagai sistem, dalam hitungan detik setelah masuk. Aturan juga bisa mengatur kirim pada jam tertentu (`arrangeAt`: pesanan diterima segera, permintaan atur kirim dikirim pada jam itu untuk semua yang menunggu) dan mencetak label otomatis ke agen cetak begitu labelnya siap (`print`, FR-SHP-18; dijalankan modul fulfillment).

## Tabel yang dimiliki
- `order_rule` (migrasi 0028, diaudit lewat `audit_trg`): `name` unik tanpa huruf besar, `priority` (1 diperiksa lebih dulu), `active`, `conditions` dan `actions` (JSON, `OrderRuleConditions` dan `OrderRuleActions` dengan `arrangeAt` dan `print` di `db/schema/automation.ts`), `created_by`.
- `order_rule_schedule` (migrasi 0029; tidak diaudit, tidak diekspor): pesanan yang menunggu jam atur kirim aturannya: `order_id` (unik per tenant, CASCADE), `rule_id` (SET NULL), `method`, `due_at`, `print` (instruksi cetak yang diteruskan ke pengiriman), `attempts`, `claimed_at`. Ditulis worker saja (`ScheduleRepository`).
- Lewat service modul pemilik: pesanan lewat `OrdersService` (`autoCandidateIn`, `changeWarehouse`, `accept`, `recordAutoRunIn`), tag lewat `TagsService` (`liveIn`, `assign`), atur kirim lewat `FulfillmentService.arrange` (dengan instruksi cetak) dan `shipmentsOf`, agen cetak lewat `PrintService.agentIn` (saat menyimpan) dan `DevicesService.getIn` (saat berjalan), zona waktu lewat `TenantsService.profileIn`, jam operasional lewat `CourierCalendarService.businessHoursIn` (campaign), paket lewat `TenantsService` (`planIn`, `requireFeatureIn`), rujukan toko lewat `StoresService.stockTargetsIn`, gudang lewat `InventoryService.warehousesIn`.

## Service publik
- `OrderRulesService` (api dan worker):
  - `list(ctx)`: aturan yang dikelola pemanggil, urut diperiksa;
  - `create(ctx, input)`, `update(ctx, id, patch, ifMatch?)`, `reorder(ctx, ids)`: hanya selagi paket punya `auto_process` (422 `billing.feature_unavailable`);
  - `remove(ctx, id)`: di paket apa pun;
  - `activeIn(tx)` dan `allIn(tx)` (mesin), `viewsIn` (daftar dengan `pending`: pesanan yang menunggu jam aturan itu), dan `exportSheets()` (`aturan_otomatis.csv`, termasuk `jam_atur`, `cetak_ke_agen`, `cetak_format`, `cetak_daftar_kemas`).
  - Error: `order_rule.not_found` (404), `order_rule.duplicate` (409), `order_rule.limit` (422, paling banyak 50), `order_rule.permission_not_held` (403), `row.stale` (409), validasi dengan `errors[].path` (`actions`, `actions.arrangeAt`, `actions.print`, `actions.print.deviceId`, `conditions.maxTotal`, `conditions.storeIds.<i>`, `conditions.warehouseIds.<i>`, `actions.warehouseId`, `actions.tagIds.<i>`, `ids`).
- `AutoProcessService` (worker, job `order.auto_process`): `run(ctx, orderId, now?)` menjalankan aturan pertama yang cocok dalam satu transaksi (kunci advisory per pesanan; layanan tombol menjadi savepoint); null bila tidak ada yang bertindak.
- `AutoArrangeService` (worker, job `order.auto_arrange`): `arrangeDue(ctx, until, now?)` mengklaim baris `order_rule_schedule` yang jatuh tempo (100 per putaran, masa klaim 2 menit, paling banyak 3 percobaan) dan mengatur kirim lewat `FulfillmentService.arrange`, dengan riwayat `auto_arrange`. `scheduler/auto-arrange-scan.ts` mengantrekannya per bisnis per menit.
- `automation-plan.ts` (murni): `ruleMatches`, `firstMatch`, `openAt`, `needsHours`, `normalizeConditions`, `normalizeActions`, `actionsProblem`, `conditionsProblem`, `actionPermissions`, `scheduledArrange` (jam berikutnya yang buka dan cukup jauh dari batas kirim, atau `now: deadline | no_slot`), `printIntent`, `SCHEDULE_GRACE_MS`, `SCHEDULE_MARGIN_MS`, `AUTO_PRINT_VALID_MS`, `MAX_ORDER_RULES`. `auto-process.service.ts` juga mengekspor `factsOf` (pesanan sebagai fakta aturan).

## Aturan
- Kondisi semua harus terpenuhi; kosong berarti apa saja. Kurir dibandingkan seperti cut-off (`sameCourier`), SKU tanpa huruf besar terhadap SKU produk dan SKU marketplace, jenis paket menurut unit terbuka, total kedua ujung termasuk, jam operasional di zona waktu bisnis (tanpa jam yang diatur berarti selalu buka).
- Hanya pesanan marketplace yang dikirim penjual, masih `new` (bukan `problem`, jadi tanpa masalah terbuka termasuk `watchlist`), dari toko `live` yang bisa dipakai, dan belum pernah diproses aturan. Pesanan impor 90 hari, pesanan manual, dan pesanan yang dikirim marketplace tidak memicu event.
- Tindakan memakai layanan tombolnya dengan konteks sistem dan berurutan: gudang (bila berbeda), tag yang masih ada, lalu atur kirim (menerima sekaligus) atau terima. Penolakan dicatat dan tindakan berikutnya tetap dicoba; error lain menggagalkan job agar diulang.
- Riwayat pesanan: langkah-langkahnya dengan pelaku `system` (`actorOf(ctx)`), lalu `auto_processed` `{ruleId, rule, done, refused, arrangeAt?, arrangeNow?}`, sekali per pesanan. Laporan kinerja tim tidak menghitungnya.
- Jam tertentu: pesanan diterima segera (`done: ["accept", "schedule"]`) dan menunggu di `order_rule_schedule`; jam yang jatuh kurang dari 90 menit sebelum batas kirim (marketplace atau cut-off kurir) atau di luar hari buka diatur segera (`arrangeNow`). Pada jamnya, pesanan yang sudah diatur orang, dibatalkan, dikirim marketplace, paket tanpa fitur, atau aturan yang dimatikan atau dihapus dilewati dengan alasannya (`auto_arrange {status: skipped}`); penolakan marketplace `refused`. Mematikan aturan menghentikan gelombangnya tanpa menghapus baris.
- Cetak otomatis: agen diperiksa saat berjalan (bukan agen cetak, dicabut, atau gudang lain: `refused {action: "print"}`), lalu instruksinya ikut pengiriman (`shipment.auto_print`) atau jadwalnya; mencetaknya urusan fulfillment (`AutoPrintService`, riwayat `auto_print`).
- Yang menyimpan aturan memegang izin tombolnya (`actionPermissions`; `shipment:print` untuk cetak), untuk tindakan lama dan baru, juga saat mematikan dan mengurutkan. Pengguna bercakupan toko atau gudang hanya mengelola aturan yang menyebut toko dan gudangnya saja. Agen cetak yang terikat satu gudang hanya untuk aturan yang menjaga pesanan di gudang itu (422 `actions.print.deviceId`); agen yang dicabut tidak mengubah aturan, cetak otomatisnya ditolak sampai aturannya diubah.

## Event
- Dikonsumsi: `order.new_arrived` (modul orders).

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `order.auto_process` | `order.ingest` | `order.new_arrived`; id `order.auto_process\|<order_id>` |
| `order.auto_arrange` | `order.ingest` | jadwal `order.auto_arrange_scan` (setiap menit); id `order.auto_arrange\|<tenant_id>\|m<slot>` |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET, POST | `/v1/order-rules` | `order:accept` (POST 201) |
| PATCH, DELETE | `/v1/order-rules/{id}` | `order:accept` (DELETE 204) |
| PUT | `/v1/order-rules/priority` | `order:accept` |
Menyimpan juga butuh izin tindakannya: `order:tag` untuk tag, `shipment:arrange` untuk atur kirim, `shipment:print` untuk cetak otomatis. `GET` menyebut `pending` per aturan.

## Keputusan khusus modul
- Modul sendiri karena memakai orders, fulfillment, campaign, channel, dan identity; fulfillment mengimpor orders, jadi mesinnya tidak bisa tinggal di orders.
- Aturan berhenti di paket tanpa `auto_process` (tidak seperti peran kustom yang tetap dipakai pemegangnya): aturan yang terus berjalan setelah uji coba Growth berakhir akan memberi fiturnya gratis.
- Event terpisah dari `order.status_changed`: aturan hanya untuk pesanan yang baru masuk ke tangan penjual, sekali, dan job per pesanan tanpa membaca setiap perubahan status.
- Tag dan gudang yang dihapus tidak menghapus aturannya: tindakannya ditolak dan tercatat, dan layar menampilkan aturannya tanpa nama itu. Agen cetak yang dicabut sama: aturannya tetap, cetaknya ditolak.
- `arrangeAt` adalah saat permintaan atur kirim dikirim, bukan jam pickup: marketplace yang menentukan slot kurir. Satu permintaan untuk semua pesanan yang menunggu membuat satu gelombang pickup, dan pesanan diterima lebih dulu agar bisa dikemas sambil menunggu.
- `order_rule_schedule` tidak diaudit dan tidak diekspor, seperti `print_job`: baris operasional sesaat yang hilang bersama pesanannya. Klaim dengan masa dan batas percobaan, bukan kunci advisory, agar satu batch yang gagal tidak menahan koneksi dan berhenti sendiri.
- Cetak otomatis ada di fulfillment, bukan di sini: label baru ada setelah `label.fetch`, dan dokumen serta pekerjaan cetaknya milik fulfillment; automation hanya menitipkan instruksinya.
