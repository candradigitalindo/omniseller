# ADR-049 — Creator Shopee, inbox, instalasi App Store dan pacing adaptif

Tanggal: 17 Oktober 2026. Status: diterapkan untuk pengembangan lokal Indonesia.

## Masalah

Pusat Commerce sudah mengelola operasi seller dan akun creator/partner TikTok, tetapi belum menangani user OAuth Shopee, beberapa kontrak bertingkat/media, inbox bisnis, dan callback instalasi App Store tanpa state. Batas laju tetap per toko juga belum menanggapi throttling per aplikasi/endpoint. Menebak kontrak, memakai token seller sebagai creator atau langsung mengikat kode instalasi ke bisnis yang sedang login akan menghasilkan integrasi yang salah.

## Keputusan

Principal akun memiliki `channel`, `program` dan `regionVerified` (migrasi 0039). TikTok mempertahankan verifikasi profil/aset Indonesia. Shopee memakai alur user OAuth resmi, `user_id` int64 persis dan grant terpisah dari toko; program Video/LIVE dipilih untuk membatasi operasi, bukan dijadikan scope OAuth buatan. Dokumentasi tidak menyediakan verifikasi negara user Shopee, sehingga region ID merupakan target yang dideklarasikan dan UI selalu menampilkan `regionVerified=false`. Identitas unik mencakup platform/jenis akun/ID eksternal, bukan program; satu user tidak memiliki dua refresh token yang saling merotasi. Commit dan revocation memeriksa generasi/waktu serta channel.

Kontrak Shopee yang bertingkat ditinjau per sumber/hash dan diuji untuk cabang wajib, array, kondisi serta cursor. Video seller dan creator memakai protokol masing-masing; URL sesi tetap privat. Operasi LIVE normal menyembunyikan push key/URL. Kredensial OBS hanya dapat diunduh sebagai artifact privat berumur terbatas dengan tambahan izin `affiliate:write`, tanpa byte pada hasil, riwayat, audit atau log. Nilai `region` CN/KR pada dua endpoint First Mile merupakan negara asal; pengecualian sempit hanya berlaku untuk toko ID dengan persyaratan cross-border yang sesuai.

Kontrak TikTok membedakan scope per principal dan setiap HTTP, enum lengkap serta encoding query per endpoint. Satu mapper Tokopedia mengharuskan GET dengan body JSON; transport Node hanya membolehkannya pada method/path yang ditinjau. Unggah dokumen retur menerima dua field PDF dengan binding tersendiri. Migrasi 0041 menambahkan `commerce_file.field_name`; file multi-field tanpa nama atau tertukar ditolak. Baris lama tanpa nama hanya diterima ketika operasi memiliki satu field file.

Modul `commerce-inbox` adalah antarmuka bisnis di atas `CommerceService`, tanpa tabel pesan atau akses token baru. Pencarian percakapan/pesan, delapan jenis balasan dan mark-read eksplisit memakai outbox, idempotensi, izin/cakupan toko dan pemeriksaan ulang worker. Pesan tak terlihat dibuang sebelum cache/proyeksi. Media hanya menggunakan receipt unggahan sukses yang terikat pengguna/toko dan target chat. Hasil diterima API tidak menyatakan pesan sudah terkirim. Shopee Chat tetap tidak tersedia sampai kontrak autentikasinya terverifikasi.

Callback App Store resmi tanpa state ditangkap oleh server web sebelum login, segera dibersihkan dari URL dan disimpan terenkripsi dengan receipt HttpOnly berumur sepuluh menit. Kode tidak ditulis ke request log/referrer. Pengguna melihat bisnis aktif dan memberikan consent; nonce terikat sesi/pengguna/tenant. Worker menukar kode sekali dan menyiapkan daftar identitas toko terverifikasi tanpa membuat toko. Pilihan toko dan konfirmasi kedua baru meminta `store.installation_connect`; job melanjutkan grant yang sama. Role/status bisnis diperiksa kembali, kuota dihitung dengan lock tenant sebelum setiap toko baru, dan kegagalan parsial ditampilkan. Alur state OAuth yang sudah ada tetap berlaku untuk koneksi yang dimulai di aplikasi.

Pacing Redis mempertahankan bucket toko dan porsi pekerjaan latar, lalu menambah bucket aplikasi/principal/method/endpoint yang berbagi keadaan antarproses. HTTP 429 dan kode bisnis throttling menurunkan laju, cooldown eksponensial dibatasi 60 detik kecuali `Retry-After` resmi lebih lama; pemulihan bertahap setelah sepuluh menit stabil. Resource ID dinormalisasi menggunakan template endpoint terverifikasi. Feedback tidak mengandung query/body/token dan dibatasi satu detik; kegagalannya tidak mengganti hasil HTTP. Pacing tidak mengulang perubahan yang hasilnya belum pasti dan tidak mengklaim mengetahui entitlement akun yang tidak dipublikasikan.

## Konsekuensi dan validasi

Kontrak yang bisa dijalankan lokal bertambah menjadi 580 dari 748 entri, termasuk tiga alur tambahan file. Katalog default tetap 428 Shopee dan 317 TikTok. Angka ini terpisah dari alur khusus seller yang sudah ada, persetujuan aplikasi/program dan pengujian akun nyata. Kontrak tanpa scope/encoding/binding yang dapat dibuktikan tetap dinonaktifkan dengan alasan; negara lain berada di backlog.

Validasi mencakup signature user OAuth dan media, data int64, scope per HTTP, real-role RLS/grants, pencabutan saat proses berjalan, file PDF per field, OBS privat, kode instalasi satu kali, pilihan toko sebelum binding, balapan kuota, limiter Redis antarinstance serta browser 320–1440 piksel. Bukti dan batas terbaru dicatat di [implementasi marketplace](../../../IMPLEMENTASI-MARKETPLACE.md) dan [audit commerce](../../../AUDIT-INTEGRATOR-COMMERCE.md).
