# Audit integrasi Shopee Open Platform

**Kesimpulan: seluruh fitur Shopee belum tersedia di OmniSeller.** Menyebut connector Shopee aktif
berarti sejumlah alur sudah dibuat, bukan semua API, UI, app permission, region dan program Shopee.

Audit ini menanggapi [Introduction / developer-guide/4](https://open.shopee.com/developer-guide/4) dan
[get_open_campaign_added_product](https://open.shopee.com/documents/v2/v2.ams.get_open_campaign_added_product?module=127&type=1).
Introduction adalah pengantar platform; kontrak per operasi terdapat di dokumentasi API dan panduan
modul masing-masing.

## Sumber dan batas kepastian

- Portal resmi mengembalikan HTTP 403 dari alat di lingkungan ini. Browser pengguna yang terbuka tidak
  memberikan kemampuan membaca DOM kepada agent, sehingga tidak diklaim sudah membaca portal langsung.
- Sumber sekunder: [snapshot dokumentasi](https://github.com/nhutplus/marketplace-api-docs/tree/300344af94cf347268b50847baf14b9c28aaf1ae/shopee),
  dipin pada commit tersebut dan bertanggal crawl 15 Mei 2026. Metadata memuat URL resmi dan tanggalnya.
- Snapshot mencatat **428 endpoint, 28 modul, dan 48 panduan**. Ini bukan jumlah resmi seluruh API
  Shopee saat ini; Chat dan API terbatas dapat tidak tercakup. Tidak mengekstrapolasi snapshot menjadi
  jaminan semua fitur global berlaku untuk Indonesia atau satu jenis aplikasi.
- Audit memproses seluruh entri snapshot untuk inventaris. Tinjauan kontrak mendalam pada irisan ini
  berfokus pada AMS yang diminta serta panduan pendaftaran, aplikasi, otorisasi dan sandbox; entri lain
  masih membutuhkan peninjauan kontrak per operasi sebelum implementasi.
- Pada revisi ini **46 endpoint memiliki referensi kode, 382 belum memiliki referensi**. Angka 46
  mencakup adapter AMS baru; satu referensi bukan bukti fitur lengkap, UI tersedia, atau sandbox lulus.

Rincian: [seluruh endpoint](AUDIT-SHOPEE-ENDPOINTS.csv), [seluruh panduan dalam snapshot](AUDIT-SHOPEE-GUIDES.csv),
dan [ringkasan modul](AUDIT-SHOPEE-RINGKASAN.md). Kolom metode yang bertuliskan *Perlu verifikasi*
berarti snapshot tidak menampilkan metode secara eksplisit; nama operasi atau contoh payload tidak
dipakai untuk menebak metode HTTP.

## Kemampuan aplikasi yang sudah memiliki alur

| Area | Yang tersedia | Batasnya |
|---|---|---|
| Otorisasi | Hubungkan toko, callback/state, token dan refresh, cabut otorisasi | Kredensial dan app permission nyata belum diverifikasi dalam audit ini |
| Toko/gudang | Profil dan pemetaan gudang, deteksi stok fulfillment | Bukan seluruh Merchant/GlobalProduct/FBS/SBS API |
| Produk/stok | Tarik listing/varian, pemetaan, aktif/nonaktif, update stok | Harga reguler per listing kini dapat diminta/dikonfirmasi; aturan otomatis dan seluruh CRUD produk belum tersedia |
| Salin listing | Kategori, atribut, merek, upload gambar, buat item/variasi | Bukan seluruh Media/MediaSpace/Video atau CRUD produk marketplace |
| Pesanan | Sinkronisasi, pembatalan, tanggapan permintaan pembatalan | Bukan seluruh Order/Payment API |
| Pengiriman | Pickup/drop-off, resi, label, pelacakan dan alur kemas internal | First Mile dan semua skenario logistik regional belum tersedia |
| Retur | Tarik retur, rincian, keputusan yang didukung dan bukti sengketa | Bukan seluruh jenis negosiasi, bukti, banding dan reverse logistics |
| Push | Verifikasi, terima, simpan dan proses sejumlah jenis push | Bukan seluruh jenis push Shopee; sandbox mempunyai mekanisme uji tersendiri |

## Endpoint AMS yang diminta

API ini membaca produk yang sudah masuk Open Campaign, status kampanye, komisi dan periode promosi.
Snapshot menampilkan **GET** `/api/v2/ams/get_open_campaign_added_product`.

Adapter baca ditambahkan dengan query halaman 1–100, cursor, sorting komisi, pencarian nama atau
maksimal 50 item ID. ID int64 dipertahankan sebagai string; 1,11% disimpan sebagai 111 basis point.
Periode tanpa batas, perlindungan komisi dan waktu terminasi dipertahankan; cursor macet atau respons
rusak ditolak. Galat izin/aktivasi/syarat AMS tidak diperlakukan sebagai token kedaluwarsa.

**Statusnya masih parsial:** alur baca kini memiliki service tenant, job worker, API, cache hasil,
UI `/affiliate`, role dinamis, audit/ekspor dan tes isolasi. Kontrak resmi terbaru dan sandbox nyata
belum diverifikasi; pembuatan/perubahan campaign belum tersedia.
Sisa 35 endpoint AMS pada snapshot belum diimplementasikan, termasuk pengaturan kampanye terbuka,
kampanye terarah, dashboard performa dan laporan validasi/konversi.

Dokumen AMS mencantumkan izin **Affiliate Marketing Solution Management**, serta galat bila toko belum
memiliki akses AMS atau belum menyetujui syarat AMS di Seller Center. Partner ID/Key tidak dengan
sendirinya membuktikan izin tersebut. Periksa app permissions aktual di Console sebelum mengaktifkan
fitur bagi toko/tenant.

## Kelompok kekurangan yang harus ditutup

| Kelompok | Pekerjaan berikutnya |
|---|---|
| AMS/Affiliate | Operasi Open/Targeted Campaign, perubahan komisi, batch task, dashboard dan tagihan/konversi |
| Harga/promosi | Aturan harga otomatis/massal, Discount, Voucher, Add-On Deal, Bundle Deal, Flash Sale, Follow Prize, Top Picks dan kategori toko |
| Keuangan | Escrow, fee marketplace, payout/settlement, penyesuaian dan rekonsiliasi melalui Payment API |
| Chat dan kesehatan toko | Adapter Customer Service/Chat, penanganan data pembeli yang sesuai, Account Health dan batas app type |
| Media dan pemasaran | Video, livestream, media lengkap dan Ads dengan izin aplikasi yang sesuai |
| Operasional khusus | First Mile, FBS/SBS, Merchant/GlobalProduct, program cross-border dan fitur yang relevan bagi market Indonesia |
| Operasi yang belum tertutup pada modul aktif | Tinjau per endpoint Product, Order, Logistics, Returns, Shop dan Push pada CSV; domain yang sudah ada tidak berarti seluruh operasi domain selesai |

## Implikasi untuk pendaftaran aplikasi

Panduan pendaftaran snapshot membedakan penyedia layanan pihak ketiga/ISV dan seller yang membangun
software untuk tokonya sendiri. Untuk layanan banyak seller, gunakan kategori yang sesuai kebutuhan
OmniSeller dan identitas usaha sebenarnya. Ketentuan kelayakan serta dokumen harus dikonfirmasi ke
portal terkini; jangan mengarang nomor telepon, alamat, badan hukum, NIB/NPWP atau akun review.

Panduan App management menyatakan jenis aplikasi memiliki izin API/push berbeda; ERP, Customer Service,
Ads dan AMS harus dicocokkan dengan izin terbaru. Tabel ERP lama tidak boleh digunakan untuk menganggap
semua modul baru otomatis diizinkan. Website HTTPS, kebijakan, callback, webhook, dan akun review perlu
disiapkan sesuai persyaratan Console. Sandbox memakai test key/test account dan pengujian push yang
berbeda dari produksi; hasil simulator lokal tidak menjadi bukti lolos sandbox Shopee.

## Validasi dan gerbang selesai

Untuk menyatakan sebuah fitur selesai, verifikasi kontrak resmi terbaru, adapter, service/job/outbox,
izin dan scope tenant/toko, API/DTO, UI, kegagalan/ulang coba, audit/ekspor jika ada penyimpanan, serta
tes otomatis dan sandbox nyata. Untuk operasi tulis tambahkan idempotensi, hasil parsial/batch dan
aturan bisnis yang relevan. Fitur belum lengkap tetap ditandai parsial, tanpa menu atau endpoint semu.

Pada irisan ini, tes connector memakai transport tiruan dan payload sintetis, bukan credential toko
nyata. [README connector](backend/packages/connectors/shopee/README.md) memuat kontrak, perintah audit,
dan gerbang rilis; [ADR-044](backend/docs/adr/0044-shopee-coverage-and-ams-read-adapter.md) mencatat keputusan.

Validasi lokal 16 Oktober 2026: `pnpm typecheck`, `pnpm lint` dan `pnpm test --maxWorkers=1
--testTimeout=15000` dari `backend/` lulus. Total 600 tes pada 61 berkas: 414 tes unit aplikasi dan
186 tes paket, termasuk 104 tes connector Shopee (32 tes AMS baru). Inventaris diperiksa terhadap
428 entri snapshot dan referensi baris sumber; tidak ada path connector yang tidak tercakup snapshot.
Validasi pada audit awal belum mencakup UI AMS. Penambahan alur baca AMS 17 Oktober dicatat pada
IMPLEMENTASI-MARKETPLACE.md; sandbox/live dan kontrak resmi terkini tetap belum diverifikasi.

## Implementasi sesudah audit
17 Oktober 2026: perubahan harga reguler per listing untuk kedua marketplace telah ditambahkan beserta modal, worker, audit/ekspor dan tes lokal. Referensi kode kini 46/428 (382 tanpa referensi), tanpa mengubah tanggal/provenance snapshot. Baca [status implementasi seluruh modul](IMPLEMENTASI-MARKETPLACE.md); semua fitur Shopee tetap belum selesai dan sandbox nyata belum dijalankan.

Audit ulang integrator 17 Oktober 2026: [model otorisasi dan temuan](AUDIT-INTEGRATOR-COMMERCE.md),
[matriks seluruh modul](AUDIT-INTEGRATOR-FITUR.csv). Partner ID/Key milik aplikasi operator;
tenant seller tetap memberikan consent. AMS adalah fitur seller dan tidak menyediakan koneksi
creator/publisher Shopee. Sebanyak 143 metode HTTP pada snapshot masih perlu verifikasi.
Presisi ID, konfirmasi hasil stok dan ketahanan grant seller menjadi pekerjaan prioritas.
Portal resmi dan portal affiliate Indonesia gagal di proxy tunnel HTTP 403; ini bukan penolakan
akun oleh Shopee. Status audit tidak berubah menjadi terverifikasi live/sandbox.
