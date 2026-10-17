# Audit dan integrasi commerce Indonesia

Diperbarui 17 Oktober 2026. Cakupan: seller Shopee dan Tokopedia & Shop, serta creator/affiliate partner Indonesia. Negara lain tetap backlog. Checkpoint audit lama berada pada riwayat Git `834f22d`; status di bawah mengikuti implementasi Pusat Commerce.

**Pusat Commerce sudah menyediakan 580 operasi executable lokal**, di samping alur seller khusus yang sudah ada. Angka ini bukan klaim seluruh fitur platform selesai atau aplikasi memperoleh semua izin. Sebanyak 168 entri katalog memakai alur khusus atau dinonaktifkan karena kontrak, principal, wilayah atau pengelolaan platform belum sesuai. Katalog selalu menampilkan alasan dan menolak eksekusinya di server.

| Platform | Katalog default | Executable di Pusat Commerce | Entri memakai alur khusus atau dinonaktifkan |
|---|---:|---:|---:|
| Shopee default | 428 | 307 | 121 |
| Unduhan OBS LIVE Shopee | 1 | 1 | 0 |
| Tokopedia & Shop default | 317 | 270 | 47 |
| Alur tambahan video besar Tokopedia & Shop | 2 | 2 | 0 |

Matriks [per operasi](IMPLEMENTASI-COMMERCE-OPERASI.csv) berisi 748 baris dengan method/path, principal, izin role, scope/program, transport, sumber dan alasan. Ini dihasilkan dari registry serta kebijakan aplikasi yang sama dengan endpoint katalog, bukan dihitung dari jumlah string URL pada kode. [Inventaris kelompok](AUDIT-INTEGRATOR-FITUR.csv) dan inventaris endpoint historis mengukur hal yang berbeda.

## Koneksi dan kredensial

| Akun | Pengelola integrator | Tenant | Status |
|---|---|---|---|
| Shopee seller/AMS | Aplikasi partner, Partner ID/Key, redirect/push, izin modul/program Indonesia | Consent toko di Shopee | Koneksi seller, refresh dan operasi AMS seller tersedia lokal; akses program nyata belum diuji |
| Shopee creator Video/LIVE | Aplikasi dengan program Video/Livestream Management dan user OAuth resmi | Consent user dan pilihan program | Signature `user_id`, refresh, media dan operasi Video/LIVE tersedia; negara user belum dapat diverifikasi provider (`regionVerified=false`). Affiliate publisher tetap terpisah dan belum terverifikasi |
| Tokopedia & Shop seller | App Key/Secret, Service ID, redirect/webhook dan scope | Consent seller | Grant satu kali disegel, identitas/scopes seller diperiksa, refresh dan disconnect dipagari |
| Tokopedia & Shop creator | Aplikasi berizin `creator.*`, akses Creator API/program | Consent creator khusus | Profil, operasi bisnis/media/analitik, refresh dan pencabutan webhook lokal tersedia; akses nyata belum dimiliki |
| Affiliate partner/TAP | Aplikasi berizin `partner.*`, Service ID dan program TAP | Consent partner dan aset kategori Indonesia | Operasi partner memakai principal/aset tersendiri; cipher tetap privat; akses nyata belum dimiliki |

Kredensial aplikasi dikelola integrator melalui environment. Token hasil consent tenant disimpan terenkripsi. Formulir universal API key per tenant tidak menggantikan OAuth/consent platform. Mode tenant membawa aplikasi developer sendiri belum tersedia. API key OmniSeller juga bukan kredensial marketplace. Satu kandidat scope yang cocok hanya pemeriksaan awal; izin akhir, program dan pasar ditentukan marketplace.

## Fitur yang ditambahkan

Inbox `/commerce/pesan` menyediakan pencarian/buat percakapan, pesan berpaginasi, delapan jenis balasan, mark-read eksplisit dan media dari receipt terikat pengguna/toko. Pesan yang tidak terlihat tidak masuk hasil/cache. Shopee Chat tetap tidak tersedia tanpa kontrak autentikasi yang terverifikasi.

Pusat `/commerce` menyediakan katalog berpencarian dan kelompok, akun sesuai izin, formulir kontrak bertingkat dalam modal, konfirmasi perubahan, antrean, hasil, pagination dan unduhan privat. Select dapat dicari, uang memakai Rupiah dan tanggal/jam mengikuti zona bisnis. UI diuji mulai lebar 320 piksel. Operasi meliputi affiliate seller/creator/partner, kolaborasi, campaign, sample, showcase/link, media, promosi, keuangan, layanan pelanggan, engagement, analitik, kesehatan toko dan operasi seller khusus yang kontraknya aman.

Stok, harga dan alur inti pesanan/pengiriman/retur tetap memakai modul pemilik. Perubahan baru meminta pull ulang melalui event agar fakta lokal mengikuti platform. Hasil membedakan pembacaan, diterima API, ditolak dan belum pasti; sukses HTTP tidak membuktikan pekerjaan bisnis selesai. Penolakan batch tidak dilaporkan sebagai sukses; array respons iklan dan daftar gagal spesifik AMS/Video dibaca sebelum acknowledgment. Timestamp penjadwalan Video mengikuti satuan milidetik yang disebut sumber.

File diunggah multipart ke penyimpanan privat dengan signature MIME, batas ukuran, binding tenant/operasi/akun/field file dan TTL satu jam. API memakai spool disk dan streaming; video besar memakai chunk dengan batas memori. Persiapan video besar TikTok sampai 500 MiB tidak mempublikasikan konten; mapping resource besar ke field publikasi creator belum terbukti. Upload chat mendukung satu chunk kecil sampai 100 MiB. Video seller/creator Shopee mengikuti protokol yang berbeda dan ditinjau; kredensial OBS hanya tersedia melalui artifact privat dengan izin tulis tambahan. Unduh laporan/PDF melewati izin domain dan keuangan yang sesuai; token/URL sesi dan buyer PII tidak masuk log/ekspor.

## Tindak lanjut temuan audit

| Temuan | Implementasi sekarang | Batas yang tersisa |
|---|---|---|
| INT-01, cakupan modul | Registry dan UI executable untuk seller/creator/partner, izin domain, outbox, hasil, file dan matriks per operasi | Entri dinonaktifkan harus mengikuti alasan masing-masing; bukan klaim seluruh Seller Center dapat diakses API |
| INT-02, scope runtime | Pemeriksaan TikTok per method/path/principal sebelum HTTP termasuk multipart; scope metadata untuk 390 versi | Marketplace tetap otoritas kecukupan scope/program; FBT memiliki preflight onboarding tambahan |
| INT-03, creator revocation | Webhook tipe 20 ditandatangani, `creator_open_id`, waktu, worker revocation dan pagar staged grant | Semantik timestamp satu detik konservatif; perlu pengujian akun nyata |
| INT-04, seller code satu kali | Staged grant terenkripsi, retry discovery dari grant sama, callback terikat pemohon dan fresh role/status | App Store tanpa state sudah ditangkap sebelum login, grant disegel, identitas toko ditampilkan sebelum binding; tenant/pengguna/sesi/consent, role dan kuota diperiksa kembali |
| INT-05, presisi Shopee | ID int64 desimal persis, numeric JSON tanpa pembulatan, respons tidak aman ditolak | Sandbox nyata belum tersedia |
| INT-06, seller identity | user_type, open_id, scopes, identitas refresh dan generasi koneksi diperiksa | Akun lama tanpa identitas lengkap memerlukan consent ulang |
| INT-11, ack stok Shopee | Model/lokasi/jumlah harus diakui tepat; kosong, duplikat dan parsial ditolak | Konfirmasi stok nyata mengikuti alur pemilik dan akun uji |
| INT-07, regional/order rights | Registry dan payload per kontrak, account requirements, penolakan operasi luar ID dan validasi kategori terbaru tetap ada | Horizon+, Imported Goods dan hak/biaya khusus tetap membutuhkan fixture/sandbox program; bukan dasar klaim laba/settlement akurat |
| INT-08, label principal | UI koneksi creator/partner menyebut platform; katalog membedakan seller/creator/partner serta alasan tidak tersedia | Shopee Video/LIVE memakai user OAuth dan program tersendiri; negara akun tidak diklaim terverifikasi; publisher affiliate tetap belum didukung |
| INT-09, hasil bisnis | Status antrean/diterima/ditolak/belum pasti, follow-up pull modul pemilik | Mengubah master lokal tidak otomatis menerbitkan seluruh field ke marketplace |
| INT-10, operasi khusus | Mapping/mirror, health dan API event yang aman memiliki kontrak pada katalog; perubahan subscription aplikasi tidak dapat dijalankan tenant | Instalasi App Store dan pacing adaptif aplikasi/principal/endpoint sudah tersedia; entitlement yang tidak dipublikasikan serta event di luar consumer yang ada tetap perlu bukti/implementasi khusus |

Empat operasi TikTok yang baru diverifikasi mencakup mapper ID Tokopedia (GET dengan body JSON yang diizinkan hanya pada endpoint tepat), daftar percakapan affiliate seller, kinerja creator produk campaign TAP dan dua dokumen PDF retur. Empat operasi lainnya tetap terblokir karena metadata scope tidak dipublikasikan. Shopee menambah 37 review schema per sumber/hash untuk produk, variasi, promosi, booking dan logistik; encoding GET/region/program yang belum terbukti tidak ditebak.

Pacing Redis berbagi bucket aplikasi/principal/method/endpoint, menurunkan laju setelah throttling, menghormati `Retry-After` dan pulih bertahap. HTTP refresh/discovery serta chunk upload juga melewati gate. Feedback tidak membawa body/query/token, dibatasi satu detik dan tidak memicu pengiriman ulang perubahan yang belum pasti.

Penolakan token creator/partner saat operasi aktif juga memagari credential dengan perbandingan token dalam lock; akun lama ditandai perlu terhubung ulang, sedangkan grant baru yang muncul saat HTTP berjalan tetap dipertahankan.

Pemeriksaan keamanan tambahan menutup kebocoran data keuangan ke role katalog/affiliate, menyaring biaya/laba kembali setelah role berubah, mensyaratkan kode sukses numerik TikTok dan HTTP sukses, memeriksa penolakan per item, menjaga replay idempoten setelah input file kedaluwarsa, menolak cursor terlalu panjang tanpa memotongnya serta membatasi pembacaan respons/file.

## Bukti dan batas penyelesaian

Snapshot resmi Tokopedia & Shop dibaca lengkap secara lokal: 973 entri navigasi, 942 detail termasuk versi, 390 metadata API dan 317 operasi default; tidak ada detail yang hilang dari pengambilan ini. Tree SHA-256 `b1005604b13fc9052c89812176caaa07da58b69b4c1a0c8223cc7c363a7b6ec7`. Compiler menyimpan hash isi dan metadata. Snapshot sekunder Shopee dipin ke commit `300344af94cf347268b50847baf14b9c28aaf1ae`: 428 endpoint, 28 modul; semua method eksplisit berhasil dibaca dari Markdown. Portal resmi Shopee tetap belum dapat diverifikasi langsung dari lingkungan ini.

Dokumentasi hanya menjadi data masukan, tidak ada kode pihak ketiga yang dijalankan. Pengguna telah mengonfirmasi belum mempunyai Creator API/beta/TAP dan meminta pengembangan lokal. Pengujian memakai database dengan role aplikasi, transport tiruan bertanda tangan dan browser; tidak ada perubahan pada toko nyata. Persetujuan aplikasi/program, scope akun sebenarnya, sandbox dan review produksi tetap pekerjaan terpisah. Lazada, Blibli, Shopify dan WooCommerce belum mempunyai connector aktif pada pekerjaan ini.

Rujukan: [status implementasi](IMPLEMENTASI-MARKETPLACE.md), [ADR-048](backend/docs/adr/0048-commerce-operation-workspace.md), [ADR-049](backend/docs/adr/0049-commerce-contract-completion.md), [modul commerce](backend/src/modules/commerce/README.md), [sumber Shopee](AUDIT-INTEGRASI-SHOPEE.md), [sumber Tokopedia & Shop](AUDIT-INTEGRASI-TIKTOKSHOP.md).
