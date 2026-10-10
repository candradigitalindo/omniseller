# Modul reporting

## Tanggung jawab
- Dasbor utama (PRD FR-RPT-01, layar L01, backend doc 8.16): penjualan hari ini, 7 hari, atau 30 hari dibanding periode sebelumnya di zona waktu bisnis, pesanan per status dan yang mendesak, grafik 30 hari per marketplace, produk terlaris, laba kotor dari HPP, stok kritis, kesehatan toko, dan daftar "Perlu tindakan".
- Laporan penjualan (PRD FR-RPT-02, layar L30, backend doc 8.20): periode bebas dengan pembanding, grafik per hari, minggu, atau bulan, rincian per marketplace, toko, produk, kategori, provinsi, dan jam, tingkat pembatalan, pesanan yang diserahkan ke kurir, dan CSV per bagian.
- Kinerja tim (PRD FR-RPT-10, layar L33, backend doc 8.35), mulai paket Growth: apa yang dikerjakan setiap anggota pada pesanan per hari, dari riwayat pesanan, dengan CSV.
- Ringkasan operasional harian lewat email (PRD FR-NTF-02, backend doc 8.20): pukul 07.00 waktu lokal bisnis, hanya di worker.

Laporan terjadwal menyusul.

## Tabel yang dimiliki
- `daily_digest`: satu baris per bisnis dan tanggal lokal ringkasan harian. Baris ini mencegah email terkirim dua kali.

Dasbor dan laporan tidak menulis apa pun. Semua angkanya dibaca dalam satu transaksi lewat service modul pemiliknya:
- `OrdersService`: `summaryIn`, `urgentIn`, `salesIn`, `salesByDayIn`, `topProductsIn`, `grossProfitIn`, `salesBucketsIn`, `salesByIn`, `salesByHourIn`, `itemSalesIn`, `unitsSoldIn`, `cancellationsIn`, `shippedIn`, `staffActionsIn`.
- `InventoryService`: `criticalIn`, `variantsIn`.
- `ListingsService.unmappedCountIn`.
- `StoresService`: `list`, `listIn`, `unmappedWarehousesIn`.
- `TenantsService`: `timezone`, `profile`, `requireFeatureIn` (fitur paket `staff_report`).
- `BusinessProfileService.legalTasksIn` dan `BillingService.taskIn`: tugas legalitas dan langganan (`billing_due`), hanya untuk `settings:billing`.
- `UsersService`: `recipientsIn`, `loadPrincipal`, `namesIn`.
- `NotificationPreferencesService.emailChoicesIn`.

## Service publik
- `DashboardService.get(ctx, { range, storeId })`.
- `SalesReportService.report(ctx, query)`.
- `SalesReportService.csv(ctx, query, section)`.
- `StaffReportService.report(ctx, {from, to})` dan `StaffReportService.csv(ctx, query, "users" | "days")`.
- `DigestService.run(ctx, date)` dan `DigestService.send(ctx, payload)`: worker saja, lewat `ReportingWorkerModule`.

## Aturan
- **Periode** dihitung di `tenant.timezone` (`Asia/Jakarta` bila tidak diubah).
  - Dasbor: `today` sampai sekarang dibanding kemarin sampai jam yang sama; `7d` dan `30d` mencakup hari ini (`rangeWindows` di `dashboard-plan.ts`).
  - Laporan penjualan: bulan ini sampai sekarang bila tanggal tidak diisi. Pembandingnya bulan kalender yang sama banyaknya bila periode tepat bulan penuh, selain itu jumlah hari yang sama sebelumnya. Periode yang masih berjalan dipotong di saat ini, dan pembandingnya di titik yang sama (`reportWindows` di `sales-report-plan.ts`).
- **Penjualan** adalah pesanan yang bukan `unpaid` dan bukan `cancelled`, menurut waktu pesan (PRD 13.2). Definisi ini sama di dasbor, laporan, dan email.
- **Tingkat pembatalan** adalah pesanan yang dibayar lalu dibatalkan, dibagi pesanan yang dibayar.
- **Pesanan dikirim** dihitung menurut `shipped_at`.
- **Minggu** dimulai Senin.
- **Cakupan.** Semua angka berada di dalam cakupan toko dan gudang pemanggil; `storeId` di luar cakupan memberi 404.
- **Bagian tanpa izin** bernilai `null` di dasbor dan tidak tampil di email:
  - penjualan, grafik, dan terlaris: `report:read`;
  - laba kotor: `finance:read`;
  - stok kritis: `inventory:read`;
  - listing belum terpetakan: `catalog:read`;
  - kesehatan toko di email: `settings:store`.
- **Kinerja tim** dihitung dari riwayat pesanan pengguna (`order_event` dengan `actor_type = 'user'`), bukan dari tabel sendiri, jadi hanya aksi di dalam OmniSeller yang tercatat. Arti setiap angka di backend doc 8.35; "pesanan diproses" dihitung sekali per pesanan untuk tim maupun anggota. Kemas dengan scan lebih dari 30 menit tidak masuk rata-rata menit per pesanan. Periode seperti laporan penjualan; izin `settings:user`; di Starter 422 `billing.feature_unavailable`.
- **Email harian.** Penerimanya pengguna aktif dengan `order:read` yang memilih email `digest.daily`. Pengguna yang belum memilih menerimanya bila memegang `report:read`. Isinya dihitung dengan izin dan cakupan penerima itu.
- **Keputusan murni** ada di berkas tersendiri dengan uji unit; service hanya memuat data:
  - `dashboard-plan.ts`: periode, persen perubahan, deret grafik, kesehatan toko, daftar tugas.
  - `sales-report-plan.ts`: periode dan pembanding, ember grafik, rata-rata, porsi, tingkat pembatalan.
  - `staff-report-plan.ts`: angka per kelompok, urutan anggota, baris CSV.

## Event
- `digest.email_requested` (`digest.events.ts`): satu event per penerima, ditulis bersama klaim `daily_digest`.

## Job
- `digest.daily` (antrean `notify`, dari scheduler `digest.scan`): mengklaim tanggal dan merencanakan email.
- `digest.email` (antrean `notify`, dari `digest.email_requested`): mengirim satu email.
- Menyusul: `report.scheduled_email`.

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/dashboard?range=today\|7d\|30d&storeId=` | `order:read` (bagian lain per izin) |
| GET | `/v1/reports/sales?from=&to=&granularity=day\|week\|month&storeId=&channel=&compare=` | `report:read` |
| GET | `/v1/reports/sales/export?...&section=series\|channels\|stores\|products\|categories\|regions\|hours` | `report:read` |
| GET | `/v1/reports/staff?from=&to=` | `settings:user`, paket dengan `staff_report` |
| GET | `/v1/reports/staff/export?from=&to=&section=users\|days` | `settings:user`, paket dengan `staff_report` |

## Keputusan khusus modul
- **Belum di-cache.** DOKUMEN-TEKNOLOGI 7.2 menyiapkan cache 30 detik per pengguna bila beban menuntut. Kuncinya harus memuat pengguna, karena isi bergantung pada izin dan cakupan.
- **Laba kotor** belum memotong biaya marketplace dan ongkir; itu datang bersama modul keuangan.
- **Ringkasan harian ada di modul ini, bukan di `notification`.** Ringkasan itu membaca pesanan, stok, dan toko, sedangkan modul-modul itu mengimpor `NotificationInboxModule`; meletakkannya di `notification` akan membuat siklus antar berkas modul.
- **Isi email dihitung saat direncanakan** dan dibawa di payload event, sehingga email yang diulang berisi angka yang sama.
