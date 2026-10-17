# ADR-048 — Operasi commerce melalui kontrak statis dan worker

Tanggal: 17 Oktober 2026. Status: diterapkan untuk pengembangan lokal Indonesia.

## Masalah

OmniSeller mempunyai alur seller inti dan koneksi creator/partner, tetapi belum menyediakan banyak operasi promosi, affiliate, keuangan, media, layanan pelanggan, analitik dan kesehatan toko. API key atau token yang valid tidak membuktikan izin setiap operasi. Proxy API bebas juga tidak dapat menjaga principal, izin domain, stok, log privat dan hasil perubahan yang belum pasti.

## Keputusan

Pusat Commerce memakai registry statis yang diturunkan dari snapshot dokumentasi dengan provenance/hash. Registry menetapkan method/path, principal, scope atau program aplikasi, input bertingkat, format waktu/uang, pagination, transport dan alasan operasi dinonaktifkan. Tidak ada URL atau parameter kredensial bebas dari tenant. Kontrak yang belum jelas, principal yang belum didukung dan operasi di luar cakupan Indonesia tetap terlihat dengan alasan, tetapi tidak dapat dijalankan. Jumlah kontrak executable tidak menyatakan akses program atau keberhasilan sandbox.

API mengotorisasi pengguna, principal tenant, role dinamis dan scope toko, lalu menulis permintaan idempoten serta outbox. Worker memuat ulang seluruh izin/koneksi/status bisnis sebelum HTTP dan sebelum menyimpan hasil. Respons generik tidak membuktikan filter gudang; role dengan pembatasan gudang ditolak. Data keuangan memerlukan izin keuangan tambahan, termasuk unduh laporan. Biaya/laba disaring lagi pada setiap pembacaan hasil berdasarkan izin saat itu.

Perubahan stok/harga menggunakan modul pemilik yang sudah ada. Operasi baru yang mengubah produk, pesanan, pengiriman atau retur meminta pull ulang melalui event modul pemilik; pusat ini tidak menulis fakta lokal milik modul tersebut. HTTP tidak berjalan dalam transaksi database. Tanda dispatch persisten dan claim CAS mencegah pengiriman ulang perubahan ketika hasilnya tidak pasti. Penolakan eksplisit menjadi `failed`; respons rusak, timeout setelah dispatch, crash atau kegagalan sebagian menjadi `uncertain`. Pembacaan dapat dicoba ulang terbatas. Pengulangan satu kali sesudah penolakan autentikasi eksplisit oleh gateway berbeda dari retry sesudah hasil jaringan tidak diketahui.

File disimpan privat dengan binding tenant/principal/operasi dan TTL satu jam. Unggahan API memakai spool disk privat, pemeriksaan signature byte dan batas MIME, lalu penyimpanan streaming; video besar dikirim dengan protokol chunk dan URL tujuan asal API yang diverifikasi. URL sesi/token unggah tidak keluar melalui hasil publik. Persiapan aset video besar tidak menyatakan konten telah dipublikasikan; binding resource creator yang belum dibuktikan tetap menjadi batas. Unduhan menyimpan artifact privat, bukan URL provider atau base64 di hasil. Input/hasil cache dibersihkan setelah 24 jam; audit dan ekspor hanya metadata, tanpa byte, token, cipher atau buyer PII.

TikTok memerlukan kode sukses numerik eksplisit, HTTP sukses dan pemeriksaan field kegagalan batch yang berasal dari kontrak operasi. Satu kandidat scope yang sesuai principal hanya merupakan pemeriksaan awal; marketplace tetap menentukan kecukupan izin/program. Shopee menggunakan program aplikasi, ID desimal int64 persis dan pengakuan stok per model/lokasi/jumlah. Seller grant disegel setelah pertukaran satu kali; callback, refresh dan commit terikat pengguna/identitas/role terbaru. Webhook pencabutan creator membatalkan kredensial serta staged grant tanpa menghapus riwayat atau menghidupkan akun kembali.

## Konsekuensi dan validasi

UI menyediakan pencarian, pengelompokan, modal bertahap, konfirmasi perubahan, status antrean, hasil dan pagination. Select dapat dicari; uang ditampilkan Rupiah dan waktu mengikuti zona bisnis. Persetujuan aplikasi Shopee, Creator API dan TAP nyata tetap prasyarat pengujian sandbox; pengguna mengizinkan pengembangan lokal tanpa akses tersebut.

Matriks [operasi](../../../IMPLEMENTASI-COMMERCE-OPERASI.csv) dihasilkan dari registry dan kebijakan aplikasi yang sama dengan endpoint katalog (`node tools/audit-commerce.mjs`, sesudah `pnpm build`). Pengujian mencakup transport bertanda tangan, hasil parsial, role/tenant/scope, pencabutan akses saat HTTP berjalan, file privat, idempotensi, lifecycle grant, database dengan role aplikasi dan browser mobile. Daftar bukti serta batas yang masih terbuka terdapat pada [implementasi marketplace](../../../IMPLEMENTASI-MARKETPLACE.md).
