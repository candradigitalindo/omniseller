# ADR-050 — Aplikasi marketplace milik tenant

Tanggal: 17 Oktober 2026. Status: diterapkan untuk pengembangan lokal.

## Masalah

Koneksi dan token sudah terisolasi per tenant, tetapi identitas aplikasi Shopee/Tokopedia & Shop hanya berasal dari environment integrator. Tenant yang mempunyai aplikasi developer sendiri tidak dapat mengisi key melalui UI. Mengganti sumber key hanya pada tautan OAuth akan meninggalkan exchange, refresh, commerce dan webhook menggunakan identitas aplikasi berbeda.

## Keputusan

`marketplace_application` menyimpan satu aplikasi per tenant/channel (migrasi 0042), dengan RLS, row version dan audit tanpa key/secret. Shopee memerlukan Partner ID/Key serta lingkungan produksi/sandbox. Tokopedia & Shop memerlukan App Key/Secret dan Service ID; akun uji mengikuti izin Partner Center. URL API tidak dapat diisi tenant. Pengaturan tersedia bagi izin dinamis `settings:store` dengan cakupan seluruh toko/gudang, melalui GET/PUT/DELETE `/v1/marketplace-applications` dan modal Toko Terhubung.

Partner Key/App Secret disegel AES-256-GCM; AAD mencakup tenant, channel dan record ID. `MARKETPLACE_APP_ENCRYPTION_KEY` adalah kunci infrastruktur 32 byte base64 yang dibagikan api/webhook/worker, disimpan terpisah dari database dan dipertahankan bersama cadangannya. Lokal/test dapat menurunkannya melalui HKDF dengan domain terpisah dari material TOTP; worker hanya menerima hasil derivasi. Produksi memerlukan kunci khusus untuk mengaktifkan pengaturan tenant. API membangun tautan dari ID publik dan tidak membuka secret; worker/webhook membuka secret untuk tugas masing-masing. Token OAuth tetap menggunakan TokenVault/DEK tenant dan hanya tersedia bagi worker/scheduler.

`ConnectorRegistry.forTenant` memilih konfigurasi tenant untuk seller/creator OAuth, exchange/discovery, refresh dan semua panggilan gateway. Tanpa record tenant, environment lama menjadi aplikasi bawaan opsional. Penghapusan membersihkan key dan menonaktifkan record sehingga tidak beralih diam-diam ke bawaan. PUT memakai expectedVersion dan DELETE If-Match. Advisory lock per tenant/channel juga dipakai saat memulai otorisasi. Perubahan/penghapusan ditolak selama ada toko/akun terhubung atau otorisasi pending/exchanging/verifying; pemilik memutus koneksi lalu mengotorisasi ulang setelah perubahan. Batas ini menghindari token lama dipakai dengan key baru tanpa menambahkan migrasi token antaridentitas aplikasi.

Webhook tenant memakai `/webhooks/{channel}/apps/{applicationId}`. Lookup SECURITY DEFINER hanya mengembalikan metadata routing, diikuti pembacaan konfigurasi di `withTenantTx`. Verifikasi memakai secret aplikasi tujuan; setelah resolve toko/akun, tenant pemilik harus sama. Event ID diberi namespace application ID, inbox menyimpan FK komposit aplikasi, dan revocation fence disaring menurut aplikasi. Receiver lama mengabaikan toko yang memakai aplikasi tenant; worker mengabaikan inbox aplikasi yang sudah berganti. Tidak ada HTTP marketplace pada proses API atau transaksi yang menahan koneksi selama HTTP.

Redirect TikTok tenant menyertakan `application_id` untuk menangkap pemasangan App Store tanpa state sebelum login. Receipt dan hash klaim kode terikat aplikasi; inspect/confirm menolak tenant lain. Legacy hash kode dipertahankan untuk aplikasi bawaan. Consent sesi, grant satu kali, preview identitas dan pilihan toko tetap berlaku. Callback OAuth dengan state tetap dipakai untuk otorisasi biasa.

UI tidak menyimpan secret pada browser persistence atau query/mutation cache dan mengosongkan input setelah berhasil. Respons API hanya menyertakan ID publik, status secret, revision dan alamat callback. Audit/ekspor tidak memuat key/secret/ciphertext. Metadata ekspor disediakan oleh modul pemilik; purge mengikuti urutan FK yang dihitung database.

## Konsekuensi dan validasi

Kredensial berlaku segera setelah disimpan tanpa restart. Tenant masih membutuhkan aplikasi developer yang disetujui untuk programnya dan OAuth akun sebenarnya. Satu aplikasi per channel tidak menjamin akses seller/creator/TAP sekaligus. Shopee Chat tetap mengikuti pembatasan ISV platform; konfigurasi tenant tidak membuka izin yang ditutup.

Tes transport bertanda tangan tanpa global app key memeriksa dua identitas aplikasi Shopee, OAuth creator, TikTok Service ID, exchange/refresh, webhook kedua platform, penolakan routing lintas tenant, ciphertext/AAD lintas tenant, revision dan active-connection guard, serta instalasi App Store sampai binding pilihan toko. Schema/RLS/grant/purge, regresi alur lama, UI dan browser responsif diverifikasi terpisah. Pengujian nyata menunggu key dan akses program yang sah; tidak ada perubahan toko nyata dalam pekerjaan ini.
