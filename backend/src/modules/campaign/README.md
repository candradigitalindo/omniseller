# Modul campaign

## Tanggung jawab
Bagian pertama modul kampanye (PRD 6.14): cut-off kurir per gudang, hari libur kurir, dan jam operasional dengan periode khusus (FR-CMP-05, 06; layar L43; backend doc 8.31). Dari ketiganya setiap pesanan yang masih harus dikirim mendapat batas internal: cut-off kurir pertama yang masih terkejar. Kampanye, prakiraan, dan mode kampanye (FR-CMP-01 sampai 04, 07 sampai 09) menyusul di modul ini.

## Tabel yang dimiliki
- `courier_cutoff`, `courier_holiday`, `operating_hours` (migrasi 0021).
- Gudang lewat `InventoryService.warehousesIn` (cakupan pemanggil), zona waktu lewat `TenantsService.profileIn`. Batas internal pesanan ditulis modul orders (`OrderDeadlinesService`), bukan di sini.

## Service publik
- `CourierCalendarService` (api dan worker):
  - `calendarIn(tx, ctx)`: apa yang dipakai menghitung batas internal (cut-off aktif, libur dari 60 hari lalu sampai 32 hari ke depan, minggu biasa, periode khusus); `null` bila bisnis tidak punya cut-off aktif.
  - `cutoffs | addCutoff | updateCutoff (If-Match) | removeCutoff`, `holidays | addHoliday | removeHoliday`, `hours | setWeek | removeWeek | addPeriod | updatePeriod | removePeriod`, `exportSheets`.
  - Error: `courier_cutoff.not_found`, `courier_cutoff.duplicate`, `courier_holiday.not_found`, `courier_holiday.duplicate`, `operating_hours.not_found`, `operating_hours.overlap`, validasi `warehouseId`, `schedule`, `to`, `row.stale`.
- `cutoff-plan.ts` (murni): `sameCourier`, `cutoffFor`, `hoursOn`, `internalDeadline`, `internalSlaOf`, `weekProblem`, `addDays`, `weekdayOf`, `minutesOf`.

## Aturan
- Semua endpoint `settings:warehouse`; cut-off hanya untuk gudang dalam cakupan pemanggil (di luar cakupan 404).
- Nama kurir seperti dikirim marketplace. Pencocokan seperti serah terima: huruf dan angka saja, satu nama boleh mengawali yang lain; bila beberapa cocok, nama terpanjang menang. Satu cut-off per gudang dan kurir, bagaimanapun ditulis (`lower(btrim(courier))`).
- Hari kurir 0 = Minggu sampai 6 = Sabtu, 1 sampai 7 hari. Jadwal jam operasional tujuh hari dari Minggu, `null` berarti tutup, `close` setelah `open`.
- Periode khusus tidak bertabrakan tanggalnya; pemeriksaannya di bawah `pg_advisory_xact_lock(<tenant>:operating_hours)`.
- Batas internal: cut-off pertama pada atau setelah saat pesanan menjadi urusan penjual (`paid_at`, atau `ordered_at`), pada hari kurir datang, bukan libur kurir itu atau semua kurir, saat bisnis buka; jam tutup bila lebih awal dari cut-off; paling jauh 31 hari; tanpa cut-off yang cocok, kosong.
- Setiap perubahan menulis `courier_calendar.changed` di transaksi yang sama; modul orders menghitung ulang semua pesanan yang masih harus dikirim.

## Event
- Diterbitkan: `courier_calendar.changed` (`campaign.events.ts`). Dikonsumsi oleh `order.internal_deadlines` (modul orders).

## Job
- Tidak ada di modul ini; `order.internal_deadlines` ada di modul orders.

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET, POST | `/v1/courier-cutoffs` | `settings:warehouse` |
| PATCH (If-Match), DELETE | `/v1/courier-cutoffs/{id}` | `settings:warehouse` |
| GET, POST | `/v1/courier-holidays` | `settings:warehouse` |
| DELETE | `/v1/courier-holidays/{id}` | `settings:warehouse` |
| GET | `/v1/operating-hours` | `settings:warehouse` |
| PUT, DELETE | `/v1/operating-hours/week` | `settings:warehouse` |
| POST | `/v1/operating-hours/periods` | `settings:warehouse` |
| PATCH, DELETE | `/v1/operating-hours/periods/{id}` | `settings:warehouse` |

## Keputusan khusus modul
- Tabel `campaign` dan `campaign_plan` dari rencana 7.8.12 belum dibuat; `courier_cutoff` memakai `courier text` (nama), bukan `courier_code`, karena marketplace mengirim nama, bukan kode.
- Peringatan batas kirim (8.15) tetap memakai batas marketplace; peringatan khusus menjelang cut-off menyusul.
