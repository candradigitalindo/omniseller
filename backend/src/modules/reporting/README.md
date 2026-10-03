# Modul reporting

## Tanggung jawab
Dasbor utama (PRD FR-RPT-01, layar L01, backend doc 8.16): penjualan hari ini, 7 hari, atau 30 hari dibanding periode sebelumnya di zona waktu bisnis, pesanan per status dan yang mendesak, grafik 30 hari per marketplace, produk terlaris, laba kotor dari HPP, stok kritis, kesehatan toko, dan daftar "Perlu tindakan". Laporan lain dan laporan terjadwal menyusul.

## Tabel yang dimiliki
- Tidak ada. Semua angka dibaca dalam satu transaksi lewat service modul pemiliknya: `OrdersService` (`summaryIn`, `urgentIn`, `salesIn`, `salesByDayIn`, `topProductsIn`, `grossProfitIn`), `InventoryService` (`criticalIn`, `variantsIn`), `ListingsService.unmappedCountIn`, `StoresService.list`, `TenantsService.timezone`.

## Service publik
- `DashboardService.get(ctx, { range, storeId })`.

## Aturan
- Periode dihitung di `tenant.timezone` (`Asia/Jakarta` bila tidak diubah): `today` sampai sekarang dibanding kemarin sampai jam yang sama; `7d` dan `30d` mencakup hari ini (`rangeWindows` di `dashboard-plan.ts`).
- Penjualan adalah pesanan yang bukan `unpaid` dan bukan `cancelled`, menurut waktu pesan.
- Semua angka di dalam cakupan toko dan gudang pemanggil; `storeId` di luar cakupan memberi 404.
- Bagian tanpa izin bernilai `null`: penjualan, grafik, dan terlaris `report:read`; laba kotor `finance:read`; stok kritis `inventory:read`; listing belum terpetakan `catalog:read`.
- Keputusan murni (periode, persen perubahan, deret grafik, kesehatan toko, daftar tugas) ada di `dashboard-plan.ts` dengan uji unit; service hanya memuat data.

## Event
- Tidak ada.

## Job
- Menyusul: `report.scheduled_email`.

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/dashboard?range=today\|7d\|30d&storeId=` | `order:read` (bagian lain per izin) |

## Keputusan khusus modul
- Belum di-cache. DOKUMEN-TEKNOLOGI 7.2 menyiapkan cache 30 detik per pengguna bila beban menuntut; kuncinya harus memuat pengguna karena isi bergantung pada izin dan cakupan.
- Laba kotor belum memotong biaya marketplace dan ongkir; itu datang bersama modul keuangan.
