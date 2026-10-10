# Modul automation

## Tanggung jawab
Aturan proses pesanan otomatis (PRD FR-ORD-19 dan FR-CMP-06, layar L55, backend doc 8.37), mulai paket Growth (fitur `auto_process`): pesanan marketplace baru diperiksa terhadap aturan aktif sesuai urutan, dan aturan pertama yang cocok memprosesnya (pindah gudang, beri tag, terima, atur pickup atau drop-off) sekali, sebagai sistem, dalam hitungan detik setelah masuk.

## Tabel yang dimiliki
- `order_rule` (migrasi 0028, diaudit lewat `audit_trg`): `name` unik tanpa huruf besar, `priority` (1 diperiksa lebih dulu), `active`, `conditions` dan `actions` (JSON, `OrderRuleConditions` dan `OrderRuleActions` di `db/schema/automation.ts`), `created_by`.
- Lewat service modul pemilik: pesanan lewat `OrdersService` (`autoCandidateIn`, `changeWarehouse`, `accept`, `recordAutoRunIn`), tag lewat `TagsService` (`liveIn`, `assign`), atur kirim lewat `FulfillmentService.arrange`, jam operasional lewat `CourierCalendarService.businessHoursIn` (campaign), paket lewat `TenantsService` (`planIn`, `requireFeatureIn`), rujukan toko lewat `StoresService.stockTargetsIn`, gudang lewat `InventoryService.warehousesIn`.

## Service publik
- `OrderRulesService` (api dan worker):
  - `list(ctx)`: aturan yang dikelola pemanggil, urut diperiksa;
  - `create(ctx, input)`, `update(ctx, id, patch, ifMatch?)`, `reorder(ctx, ids)`: hanya selagi paket punya `auto_process` (422 `billing.feature_unavailable`);
  - `remove(ctx, id)`: di paket apa pun;
  - `activeIn(tx)` (mesin) dan `exportSheets()` (`aturan_otomatis.csv`).
  - Error: `order_rule.not_found` (404), `order_rule.duplicate` (409), `order_rule.limit` (422, paling banyak 50), `order_rule.permission_not_held` (403), `row.stale` (409), validasi dengan `errors[].path` (`actions`, `conditions.maxTotal`, `conditions.storeIds.<i>`, `conditions.warehouseIds.<i>`, `actions.warehouseId`, `actions.tagIds.<i>`, `ids`).
- `AutoProcessService` (worker, job `order.auto_process`): `run(ctx, orderId, now?)` menjalankan aturan pertama yang cocok; null bila tidak ada yang bertindak.
- `automation-plan.ts` (murni): `ruleMatches`, `firstMatch`, `openAt`, `needsHours`, `normalizeConditions`, `normalizeActions`, `actionsProblem`, `conditionsProblem`, `actionPermissions`, `MAX_ORDER_RULES`. `auto-process.service.ts` juga mengekspor `factsOf` (pesanan sebagai fakta aturan).

## Aturan
- Kondisi semua harus terpenuhi; kosong berarti apa saja. Kurir dibandingkan seperti cut-off (`sameCourier`), SKU tanpa huruf besar terhadap SKU produk dan SKU marketplace, jenis paket menurut unit terbuka, total kedua ujung termasuk, jam operasional di zona waktu bisnis (tanpa jam yang diatur berarti selalu buka).
- Hanya pesanan marketplace yang dikirim penjual, masih `new` (bukan `problem`, jadi tanpa masalah terbuka termasuk `watchlist`), dari toko `live` yang bisa dipakai, dan belum pernah diproses aturan. Pesanan impor 90 hari, pesanan manual, dan pesanan yang dikirim marketplace tidak memicu event.
- Tindakan memakai layanan tombolnya dengan konteks sistem dan berurutan: gudang (bila berbeda), tag yang masih ada, lalu atur kirim (menerima sekaligus) atau terima. Penolakan dicatat dan tindakan berikutnya tetap dicoba; error lain menggagalkan job agar diulang.
- Riwayat pesanan: langkah-langkahnya dengan pelaku `system` (`actorOf(ctx)`), lalu `auto_processed` `{ruleId, rule, done, refused}`. Laporan kinerja tim tidak menghitungnya.
- Yang menyimpan aturan memegang izin tombolnya (`actionPermissions`), untuk tindakan lama dan baru, juga saat mematikan dan mengurutkan. Pengguna bercakupan toko atau gudang hanya mengelola aturan yang menyebut toko dan gudangnya saja.

## Event
- Dikonsumsi: `order.new_arrived` (modul orders).

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `order.auto_process` | `order.ingest` | `order.new_arrived`; id `order.auto_process\|<order_id>` |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET, POST | `/v1/order-rules` | `order:accept` (POST 201) |
| PATCH, DELETE | `/v1/order-rules/{id}` | `order:accept` (DELETE 204) |
| PUT | `/v1/order-rules/priority` | `order:accept` |
Menyimpan juga butuh izin tindakannya: `order:tag` untuk tag, `shipment:arrange` untuk atur kirim.

## Keputusan khusus modul
- Modul sendiri karena memakai orders, fulfillment, campaign, channel, dan identity; fulfillment mengimpor orders, jadi mesinnya tidak bisa tinggal di orders.
- Aturan berhenti di paket tanpa `auto_process` (tidak seperti peran kustom yang tetap dipakai pemegangnya): aturan yang terus berjalan setelah uji coba Growth berakhir akan memberi fiturnya gratis.
- Event terpisah dari `order.status_changed`: aturan hanya untuk pesanan yang baru masuk ke tangan penjual, sekali, dan job per pesanan tanpa membaca setiap perubahan status.
- Tag dan gudang yang dihapus tidak menghapus aturannya: tindakannya ditolak dan tercatat, dan layar menampilkan aturannya tanpa nama itu.
