# Pembaruan UI OmniSeller — 16 Oktober 2026

Perubahan mengikuti permintaan desain modern, interaksi yang jelas, pencarian pilihan, format Indonesia, dan formulir melalui modal. Warna utama dan font OmniSeller dipertahankan.

## Cakupan

- Autentikasi: panel ilustrasi desktop, kartu responsif untuk masuk/lupa/reset sandi/2FA/undangan, pendaftaran tiga langkah (profil, akun, konfirmasi), indikator kekuatan serta lihat/sembunyikan sandi. Langkah pendaftaran mempertahankan isian dan tetap memerlukan persetujuan eksplisit.
- Dropdown bersama: pencarian label tanpa membedakan huruf besar/kecil, hasil kosong, opsi nonaktif, keyboard panah/Enter/Escape, dan pengembalian fokus. Nilai asinkron tidak berubah menjadi kosong.
- Input rupiah: tampilan `Rp 1.250.000`, payload angka mentah, dukungan tempel awalan Rp, pemeliharaan kursor saat mengedit, penolakan nominal pecahan dengan pesan inline. Harga/HPP produk, varian, pesanan manual, aturan pesanan dan draft salin listing memakai komponen yang sama.
- Tanggal/jam: `DD/MM/YYYY`, `JJ.mm` (24 jam), dan kombinasi keduanya; kalender/jam dalam modal dengan pencarian bulan dan validasi tanggal/rentang. Payload tetap ISO/HH:mm, serta konversi ke UTC tetap memakai zona waktu bisnis.
- Notifikasi: error formulir dengan ikon/pesan/tombol tutup bila tersedia, error data dengan coba lagi, toast semantik dengan tombol tutup dan posisi di atas navigasi ponsel.
- Loading: status fetch/simpan nyata setelah 450 ms; pesan tambahan setelah 8 detik, fallback rute, skeleton dan reduced motion. Tidak memakai progres persentase buatan.
- Pesanan manual: modal tiga langkah, header dan navigasi/total yang tetap terjangkau, kunci idempotensi tetap, serta konfirmasi keluar jika isian berubah. Tombol Lanjutkan tidak mengirim pesanan.

## Validasi lokal

| Pemeriksaan | Hasil |
| --- | --- |
| Build produksi, lint dan typecheck frontend | Lulus |
| Regresi unit/komponen | Run akhir lengkap lulus: 526 tes pada 83 berkas, dua worker dan timeout 15 detik. Run sebelumnya mengalami satu timeout stok saat bersamaan dengan browser; kasus tersebut serta seluruh suite kemudian lulus tanpa mengurangi assertion. |
| Pemeriksaan setelah revisi akhir | File autentikasi, format input, produk, feedback request, dan stok lulus pada pengulangan terfokus. Input jam juga menerima empat angka seperti 1430 dari keyboard numerik ponsel, dengan tampilan 14.30 dan nilai API 14:30. |
| Browser aplikasi | 10 alur lulus: signup/login/logout, error login, pembuatan pesanan manual, empat alur orders/COD, responsivitas autentikasi, select/kalender, dan konfirmasi keluar. Request pesanan manual dipastikan nol sebelum tombol Buat pesanan dan tepat satu sesudahnya. |
| Ukuran viewport | 320×568, 390×844, 768×1024, 1280×800, 844×390, dan 1920×1080 pada autentikasi; pesanan/modal juga diperiksa pada ponsel. |
| Axe pada autentikasi dan filter/kalender | Tidak ada pelanggaran WCAG 2 A/AA dan WCAG 2.1 AA pada dua skenario browser baru. |
| Axe halaman harian | Lulus: 33 rute harian diperiksa, tanpa pelanggaran serious/critical WCAG 2 A/AA. Batas waktu suite 180 detik untuk rangkaian banyak halaman; seluruh assertion tetap. |

Tangkapan layar final di filesystem lingkungan: `/workspace/ui-refresh-login-desktop-final.png`, `/workspace/ui-refresh-login-mobile-final.png`, `/workspace/ui-refresh-signup-small-final.png`, dan `/workspace/ui-refresh-signup-account-small.png`. Hasil visual mencakup panel desktop yang tidak terpotong serta tombol langkah yang terjangkau di ponsel kecil. Pada layar pendek, konten kartu/modal dapat digulir di dalam panel untuk menjaga akses ke semua isian; daftar transaksi dan laporan tetap dapat digulir sesuai kebutuhan.

Log berada di `/workspace/ui-refresh-frontend-complete.log`, `/workspace/ui-refresh-last-targeted.log`, `/workspace/ui-refresh-localized-final.log`, `/workspace/ui-refresh-clock-tests.log`, `/workspace/ui-refresh-browser-final.log`, `/workspace/ui-refresh-accessibility.log`, serta log build/lint/typecheck berawalan `ui-refresh-`. Log dan gambar tidak dimasukkan ke Git.

Validasi menggunakan Chromium dan API lokal dengan data uji. Safari/iOS, perangkat fisik, pembaca layar nyata dan QA staging belum dijalankan. Perubahan ini tidak mengubah kontrak backend, aturan harga/izin, impor produk, maupun keputusan PRD yang masih terbuka.


## Sidebar dan peran — 17 Oktober 2026

Sidebar kini memakai delapan kategori yang dapat dilipat: Beranda, Penjualan, Produk & Katalog, Stok & Gudang, Pengiriman, Laporan & Data, Tim & Akses, serta Bisnis & Integrasi. Kategori halaman aktif otomatis terbuka. Kategori kosong disembunyikan, dan menu mengikuti izin aktual pengguna, termasuk peran kustom. Rel ikon tetap bisa digulir; lembar Menu mobile memakai kategori yang sama.

Peran kustom mendukung buat, baca, ubah, hapus, pemberian kepada anggota, dan undangan di semua paket, termasuk Starter. Berlaku bagi tenant lama maupun baru; setiap tenant mengelola perannya sendiri. Tidak perlu membuat ulang data role. Peran bawaan dilindungi, izin di luar kewenangan pengelola tidak bisa diberikan, dan peran yang masih dipakai tidak bisa dihapus. Kuota anggota tetap mengikuti paket. Keputusan produk dan perubahan dari ketentuan Growth sebelumnya dicatat di [ADR-043](../backend/docs/adr/0043-tenant-roles-all-plans.md).

Editor dalam modal menyediakan pencarian izin berdasarkan nama atau modul, mempertahankan pilihan saat mencari, dan membatasi tinggi daftar. Sesi disegarkan setelah perubahan role/pemberian, ketika tab kembali fokus, serta tiap 60 detik selama halaman aktif. API memeriksa izin terbaru pada setiap permintaan.

Validasi lokal: build produksi frontend serta lint dan typecheck frontend/backend lulus; seluruh 529 tes frontend pada 84 berkas lulus, disertai 6 tes integrasi role, 41 tes identity/billing/isolasi tenant, 2 tes unit fitur paket, dan 12 tes situs lulus. Enam alur Chromium lulus, mencakup navigasi kategori dan rel ikon, menu mobile 320×568 dan 390×844, CRUD/undangan role Starter, serta regresi billing, gudang dan aturan otomatis. Axe tidak menemukan pelanggaran WCAG 2 A/AA atau WCAG 2.1 AA pada sidebar desktop/mobile dan modal role mobile.

Pratinjau desktop: `/workspace/sidebar-role-desktop.png`. Log verifikasi menggunakan awalan `/workspace/sidebar-role-`. Validasi memakai API lokal dan data uji; perubahan belum diterapkan ke produksi.
