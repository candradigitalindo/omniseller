# Pusat commerce

Operasi seller Indonesia serta creator/affiliate partner menggunakan kontrak operasi yang ditinjau dari referensi marketplace. Registry berisi method/path, jenis akun, izin, field bertingkat, batas nilai, sumber dokumentasi, dan alasan penundaan. Operasi tanpa kontrak lengkap, program luar Indonesia, serta alur yang telah dimiliki modul lain tidak dapat dieksekusi melalui pusat ini. Status kontrak siap tidak membuktikan persetujuan aplikasi atau program marketplace.

## Alur

`POST /v1/commerce/requests` memerlukan pengguna bisnis, `Idempotency-Key`, principal milik tenant, izin commerce dan modul terkait. Perubahan memerlukan konfirmasi. Akses toko mengikuti store scope; respons generik tidak mengklaim filter gudang sehingga pengguna dengan warehouse scope terbatas tidak diizinkan. Creator/partner memakai `affiliate:account_read` untuk visibilitas dan `affiliate:write` untuk perubahan bisnis; pengelolaan koneksi tetap memakai izin tersendiri.

Permintaan disimpan di `commerce_operation`, diterbitkan melalui `commerce.requested`, dan dikerjakan `commerce.execute`. Worker memuat ulang izin pemohon, status bisnis, koneksi, scope API, jenis seller dan mode baca toko. HTTP berjalan melalui `MarketplaceGateway`; kredensial dan category asset cipher dipilih server. Metadata publik kategori dipilih melalui `input.categoryAssetId`. Tidak ada URL tujuan atau kredensial bebas dari browser.

Input melewati daftar field ketat secara rekursif di API dan connector. Uang memakai string/deskriptor resmi agar tidak kehilangan presisi; ID besar tetap string. Operasi stok dan harga menggunakan modul pemiliknya. Payload perubahan produk tidak boleh mengubah stok dan field harga memerlukan `price:write`. Perubahan produk baru menjadwalkan pull listing; perubahan operasional menjadwalkan pull pesanan/retur melalui event modul pemilik. Respons berhasil hanya berarti marketplace menerima permintaan; hasil akhir tetap mengikuti pembacaan marketplace.

Worker menyimpan penanda dispatch sebelum pengiriman perubahan. Kegagalan eksplisit API menjadi `failed`; timeout, respons tidak dapat dibaca atau hasil parsial menjadi `uncertain`. Perubahan tidak diulang otomatis. Retry pembacaan dibatasi lima percobaan dan lease lima menit. Pembaruan hasil memakai claim CAS sehingga worker lama tidak membuat follow-up baru. Izin dan bisnis diperiksa lagi setelah HTTP. Riwayat dapat dibaca dengan izin baca domain meskipun koneksi sudah terputus; cache yang lewat 24 jam tidak dikembalikan dan dibersihkan job berkala.

## Berkas privat

`POST /v1/commerce/files` menerima multipart `file`, `operationId`, `principalId`. Berkas masuk ke spool disk privat dengan nama acak; ukuran global dibatasi 500 MiB dan ukuran tiap fitur tetap mengikuti dokumentasi. Signature byte/MIME diperiksa dari prefix, lalu hashing dan penyimpanan melalui `FilesService` berjalan secara streaming. File sementara dibersihkan pada sukses, kegagalan, validasi DTO dan secara berkala setelah satu jam. Akun/operasi diikat pada `commerce_file`; izin diperiksa lagi setelah penyimpanan dan sebelum metadata dicatat. Input operasi membawa ID unggahan, tidak membawa byte/base64/URL. Worker memeriksa binding serta masa simpan metadata dan file sebelum mengirim multipart resmi. Unggahan kedaluwarsa satu jam.

Unduhan marketplace disimpan privat dan hasil permintaan hanya menyimpan metadata artifact. `GET /v1/commerce/requests/:id/download` memeriksa akses riwayat dan masa simpan, lalu mengirim attachment atau signed URL. Dokumen pengiriman juga memerlukan `shipment:print`. Tidak ada pengambilan URL balikan secara bebas.

Unggah video creator sederhana mengikuti batas 10 MB. Dua operasi persiapan aset besar memakai protokol init dan chunk resmi: creator hingga 500 MiB dan pesan pelanggan hingga 100 MiB. Worker membaca rentang maksimal 30 MiB dan mengirim chunk 20 MiB secara berurutan; tidak memuat seluruh video ke memori. Target endpoint ditentukan registry, redirect/origin/upload authentication yang tidak didokumentasikan ditolak, dan chunk dengan hasil tidak pasti tidak dikirim ulang. Izin pemohon serta status akun diperiksa lagi saat setiap bagian dibaca. Hasil berupa `resource_id` dan konteks target, **belum menerbitkan video atau mengirim pesan**. Binding chat `content.vid` memiliki contoh resmi; pemetaan resource besar ke field publikasi creator masih memerlukan bukti dokumentasi/sandbox dan tidak ditebak. Base endpoint init generik didelegasikan agar token/URL sesi privat tidak terekspos.

## Privasi dan ekspor

Input/hasil sementara, state lease dan byte tidak masuk audit. Sync log hanya mencatat metadata operasi/status/timing dan tidak merekam body, query pengguna, respons, cipher, token atau pesan galat provider. Hasil publik dibatasi field respons resmi, kedalaman, jumlah item dan ukuran; buyer PII dan kredensial disaring. Ekspor penuh memuat `operasi_commerce.csv` dan `berkas_commerce.csv` berupa metadata tanpa isi berkas atau hasil cache.

Pengujian mencakup whitelist bertingkat, presisi ID, batas array/cursor, izin tenant/domain, penolakan API versus hasil tidak pasti, signature creator/TAP, privacy log, multipart, artifact privat, serta alur API/outbox dengan database role aplikasi.
