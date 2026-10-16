# ADR-043 — Peran kustom tersedia bagi semua tenant di setiap paket

Tanggal: 17 Oktober 2026. Status: diterima atas permintaan pemilik produk.

## Konteks

PRD bagian 14 sebelumnya membatasi peran kustom mulai Growth. Pemilik produk meminta role dinamis dengan CRUD untuk semua tenant, disertai sidebar yang dikelompokkan berdasarkan kategori dan izin.

## Keputusan

Peran kustom menjadi fitur inti: buat, baca, ubah, hapus, pemberian ke anggota, dan undangan tersedia di Starter, Growth, Business, serta paket tenant lain. Pemeriksaan `custom_roles` dilepas dari service dan UI; kode fitur itu tidak lagi termasuk `PLAN_FEATURES` atau extras paket. Seed berulang membersihkan metadata paket bawaan, dan halaman harga menyebut peran kustom pada setiap paket. Tidak perlu migrasi skema atau backfill role: tenant lama langsung mendapat akses saat kode baru dijalankan.

Role tetap milik tenant pembuatnya dan semua operasi memakai `withTenantTx` serta RLS. Pengelolaan memerlukan `settings:user`; tidak boleh memberi izin yang tidak dimiliki. Role bawaan dilindungi, Owner aktif terakhir dipertahankan, dan penghapusan menolak pemegang atau undangan terbuka. Kuota pengguna tetap mengikuti paket.

Sidebar menggunakan delapan kategori bersama, dapat dilipat, menyembunyikan kategori kosong, dan menampilkan menu sesuai izin aktual. Kategori halaman aktif terbuka saat navigasi masuk. Izin API dibaca setiap permintaan; sesi UI disegarkan setelah perubahan role/pemberian, saat fokus kembali, dan setiap 60 detik selama aktif.

## Konsekuensi dan verifikasi

Keputusan ini menggantikan batas Growth untuk peran kustom di PRD 14 dan backend 8.33. Fitur berbayar lainnya tetap memeriksa paket. Pengujian integrasi mencakup CRUD dan undangan Starter, kuota pengguna, perubahan izin tanpa login ulang, delegasi, serta operasi lintas tenant. Pengujian UI mencakup pencarian izin tanpa kehilangan pilihan, kategori sesuai izin, navigasi, keyboard, dan layar mobile.
