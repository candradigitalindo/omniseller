# Audit ulang OmniSeller sebagai integrator commerce

Tanggal: **17 Oktober 2026, WIB**. Basis kode: `328f872a3baca9db36db5d30741e69761bd5ac0c`.
Cakupan: Shopee serta TikTok Shop / Tokopedia & Shop, seller, creator, dan affiliate partner Indonesia.

**Integrasi belum mencakup seluruh fitur commerce.** Alur seller inti dan fondasi akun TikTok
creator/partner tersedia sebagian. Kunci aplikasi, koneksi berhasil, dan role tenant tidak dengan
sendirinya memberi akses ke seluruh API. Menu Akun Creator & Partner sekarang khusus TikTok Shop;
AMS Shopee yang tersedia adalah fitur seller, bukan koneksi akun creator Shopee.

## Model koneksi yang sesuai dokumentasi

| Platform / pemilik data | Yang disiapkan pengelola OmniSeller | Yang dilakukan tenant | Status aplikasi |
|---|---|---|---|
| Shopee seller | Aplikasi partner/ISV, Partner ID/Key, redirect/push URL, izin modul dan target market | Pilih Hubungkan, masuk ke Shopee, izinkan akses toko; hubungkan ulang bila izin dicabut | Ada alur seller; izin nyata dan sandbox belum diverifikasi |
| Shopee AMS seller | Izin Affiliate Marketing Solution Management dan aplikasi yang memenuhi syarat | Otorisasi toko serta memenuhi akses/persetujuan AMS Seller Center | Baru baca produk Open Campaign |
| Shopee creator/affiliate publisher | Kontrak dan onboarding program creator Indonesia masih harus diperoleh | Mekanisme credential/consent mengikuti dokumen program yang terverifikasi | Belum ada connector atau koneksi creator; jangan menyamakan dengan AMS seller |
| TikTok seller | Aplikasi ISV/public yang sesuai, App Key/Secret, Service ID, scope dan redirect/webhook | Login marketplace dan consent melalui tautan seller | Ada alur link; instalasi dimulai dari App Store belum ditangani |
| TikTok creator | App Key/Secret, scope `creator.*`, akses program/beta jika diperlukan | Consent creator melalui tautan khusus; scope yang ditolak tetap tidak tersedia | Koneksi, profil Indonesia, refresh dan disconnect lokal ada; operasi bisnis belum lengkap |
| TikTok affiliate partner/TAP | App Key/Secret, Service ID, scope `partner.*`, kategori aset dan akses TAP | Consent partner melalui tautan partner; pilih/otorisasikan aset yang didukung | Koneksi dan aset kategori Indonesia ada; operasi bisnis partner belum ada |

Kredensial aplikasi di atas milik aplikasi integrator yang terdaftar. Token hasil consent milik
koneksi tenant dan disimpan terenkripsi. Identitas seller, creator, dan partner tetap terpisah;
`shop_cipher` seller tidak dapat menggantikan cipher aset partner. Satu konfigurasi aplikasi tidak
membuktikan seluruh program sudah disetujui. Jenis aplikasi dan kombinasi scope harus diperiksa di Console.

Untuk SaaS banyak tenant, formulir universal “masukkan API key” tidak cocok dengan alur otorisasi
Shopee seller dan TikTok yang diperiksa. Pengalaman tenant cukup memilih platform/jenis akun,
menyetujui akses di platform, lalu melihat fitur yang diizinkan. Metode API key per tenant baru
ditambahkan bila kontrak platform/program memang mensyaratkannya. Membawa aplikasi developer milik
tenant sendiri juga merupakan mode tersendiri yang **belum didukung** registry global saat ini.
API key OmniSeller untuk klien internal tidak menggantikan kredensial marketplace.

Bukti implementasi: [registry](backend/src/modules/channel/connector-registry.ts),
[otorisasi seller](backend/src/modules/channel/store-authorization.service.ts),
[otorisasi creator/partner](backend/packages/connectors/tiktokshop/src/accounts.ts),
[pengamanan token](backend/src/modules/affiliate-accounts/README.md).
Sumber resmi: [seller](https://partner.tiktokshop.com/docv2/page/seller-authorization-guide),
[creator](https://partner.tiktokshop.com/docv2/page/creator-authorization-guide),
[partner](https://partner.tiktokshop.com/docv2/page/partner-authorization-guide),
[token/user type](https://partner.tiktokshop.com/docv2/page/authorization-overview-202407),
[scope](https://partner.tiktokshop.com/docv2/page/access-scope).
Kontrak Shopee masih memakai [snapshot sekunder yang dipin](AUDIT-INTEGRASI-SHOPEE.md).

## Hasil pemeriksaan seluruh kelompok fitur

[Matriks fitur](AUDIT-INTEGRATOR-FITUR.csv) mencakup seluruh **28 modul Shopee dan 19 modul TikTok**
dalam inventaris, dua endpoint token TikTok di luar API Reference, serta dua area Shopee yang tidak
tercakup katalog: creator/publisher dan chat. Ada 50 baris; jumlahnya bukan jumlah fitur siap pakai.
Inventaris per operasi tetap tersedia di [Shopee](AUDIT-SHOPEE-ENDPOINTS.csv) dan
[TikTok](AUDIT-TIKTOKSHOP-ENDPOINTS.csv), lengkap dengan URL, versi/scope yang diketahui dan bukti kode.

| Kelompok | Shopee | TikTok Shop / Tokopedia & Shop |
|---|---|---|
| Otorisasi dan toko | Seller, profil, token, pemetaan gudang; parsial | Seller serta creator/partner terpisah; App Store dan lifecycle belum lengkap |
| Produk, variasi, media | Tarik, salin/publish, gambar, aktif/nonaktif; edit lengkap/hapus/video belum ada | Tarik, salin/publish, gambar, aktif/nonaktif; partial edit/hapus/global product/kualitas belum lengkap |
| Harga dan stok | Harga reguler per listing, stok dan pemetaan; aturan harga/bulk belum ada | Harga reguler per listing, stok dan pemetaan; aturan harga/bulk belum ada |
| Pesanan | Sinkron, batal dan tanggapan batal; sisa operasi Order belum ada | Daftar/detail/batal; Horizon+ dan sisa operasi belum lengkap |
| Pengiriman dan retur | Alur inti, label, tracking, keputusan retur; First Mile/FBS/SBS belum lengkap | Alur inti, label, tracking, keputusan retur; split/combine/replacement/FBT belum lengkap |
| Promosi | Discount, Voucher, Add-On, Bundle, Flash Sale, Follow Prize, Top Picks belum terintegrasi | Promotion belum terintegrasi |
| Keuangan | Payment/escrow/fee/payout/rekonsiliasi belum terintegrasi | Finance/statement/transaksi/settlement belum terintegrasi |
| Chat dan pelanggan | Chat belum ada; kelengkapan kontrak/izin belum dapat dibuktikan | Customer service dan Customer engagement belum terintegrasi |
| Analitik, video, LIVE, iklan | Modul Video/Livestream/Ads belum ada | Analytics serta operasi konten creator belum lengkap; API iklan terpisah perlu audit sendiri |
| Affiliate seller | AMS baca produk: 1 dari 36 endpoint snapshot | 0 dari 44 operasi Affiliate seller dirujuk |
| Creator | Connector creator/publisher Shopee belum ada | Profil: 1 dari 26 operasi Affiliate creator dirujuk; sample, showcase, link, konten dan performa belum lengkap |
| Affiliate partner | Program/API creator-partner terpisah belum diverifikasi | 0 dari 15 operasi Affiliate partner dirujuk; aset otorisasi berada di modul Authorization |
| Health, event, program khusus | AccountHealth belum ada; Push parsial; Merchant/GlobalProduct/FBS/SBS perlu izin/market | Event parsial; Supply chain dan Tools/Upload File Init belum ada; mapping produk Tokopedia berada di Affiliate creator; FBT hanya deteksi/daftar gudang |

Angka yang dapat dibuktikan dari inventaris:

- Shopee: **46/428 endpoint** punya referensi kode, **382 belum**. Dari 428 baris,
  **143 metode HTTP belum terverifikasi** pada snapshot. Ini bukan ukuran seluruh katalog resmi saat ini.
- TikTok: **37/317 operasi katalog** punya referensi kode, **280 belum**, ditambah kedua endpoint token
  yang dirujuk. Ada 390 baris versi katalog + 2 token, dan 39 kombinasi method/path kode.
- Semua angka mengukur referensi kode. Hasil tersebut tidak mengukur persentase fitur selesai,
  keberlakuan di Indonesia, izin aplikasi, atau keberhasilan akun nyata.

## Ketepatan integrasi yang harus diperbaiki

Temuan berikut berasal dari inspeksi kode; perilaku akun nyata belum diuji. Prioritas P1 berarti
perlu ditangani sebelum menyatakan alur terkait siap digunakan. P2 adalah kelengkapan/kejelasan
lanjutan. Tabel ini adalah daftar pekerjaan terbuka, bukan klaim perbaikan sudah diterapkan.

| ID / prioritas | Temuan dan bukti | Perbaikan dan bukti penerimaan yang diperlukan |
|---|---|---|
| INT-01 / P1 | Scope per operasi belum menjadi capability aplikasi. [Manifest](backend/packages/connectors/core/src/types.ts#L744) hanya metadata umum; [gateway](backend/src/modules/channel/marketplace-gateway.ts) belum menerima kebutuhan scope operasi; [AMS](backend/src/modules/affiliate/affiliate.service.ts#L40) memeriksa kanal/region/status, belum membuktikan entitlement AMS. | Capability per platform, jenis akun, market, scope yang diberikan, program dan status implementasi. API/worker memeriksanya, UI menjelaskan alasan tidak tersedia. Izin tenant dan scope marketplace diuji terpisah; scope belum diketahui tidak dianggap disetujui. |
| INT-02 / P1 | Pencabutan izin creator TikTok tipe 20 belum ada pada [parser](backend/packages/connectors/tiktokshop/src/webhooks.ts); routing [receiver](backend/src/modules/sync/webhook-receiver.service.ts) berbasis toko. [Dokumen resmi](https://partner.tiktokshop.com/docv2/page/20-creator-deauthorization) membawa `creator_open_id`, bukan `shop_id`. | Routing akun creator yang aman lintas tenant/app, simpan/dedup event, batalkan akses/token lewat worker. Uji signature, replay, akun asing, pencabutan bersamaan dengan refresh, serta reotorisasi yang lebih baru. |
| INT-03 / P1 | [Seller connect](backend/src/modules/channel/store-connect.service.ts#L75) menukar kode sebelum token disimpan; pembacaan profil dilakukan lebih dahulu. TikTok bahkan memanggil Get Authorized Shops di [exchangeCode](backend/packages/connectors/tiktokshop/src/connector.ts#L165). Kegagalan/crash setelah kode sekali pakai dapat kehilangan grant. | Pisahkan pertukaran dari discovery, stage grant terenkripsi segera, lease dan lanjutkan retry dari grant. Terapkan pola pemulihan yang sudah ada pada akun creator. Uji crash sesudah exchange dan sebelum/sesudah discovery. |
| INT-04 / P1 | Callback seller [memeriksa tenant/state/status/expiry](backend/src/modules/channel/store-authorization.service.ts#L133), belum membandingkan `requestedBy` dengan pengguna callback. Worker mengatribusi pemohon lama dan perlu pemeriksaan izin terbaru seperti jalur creator. | Ikat pemohon dan cek izin/cakupan terkini sebelum pekerjaan serta commit. Uji dua pengguna tenant yang sama, pencabutan role saat antrean berjalan, closure dan reotorisasi. State/tenant yang sudah ada tetap dipertahankan. |
| INT-05 / P1 | Sejumlah Shopee ID dikonversi dengan `Number(...)`: [stok](backend/packages/connectors/shopee/src/inventory.ts#L34), [aktif/nonaktif](backend/packages/connectors/shopee/src/catalog.ts#L274), [cancel item](backend/packages/connectors/shopee/src/orders.ts#L388), [variasi](backend/packages/connectors/shopee/src/products.ts#L608), [token](backend/packages/connectors/shopee/src/connector.ts#L179). | Pertahankan ID desimal persis pada payload dan pencocokan respons. Uji ID valid int64 `9007199254740993`; konversi saat ini menghasilkan `9007199254740992`. Audit juga helper logistik yang mengirim string untuk ID besar agar tipe sesuai kontrak, bukan sekadar tidak membulatkan. |
| INT-06 / P1 | TikTok seller [exchange](backend/packages/connectors/tiktokshop/src/connector.ts#L158) menerima `user_type` yang hilang; [refresh](backend/packages/connectors/tiktokshop/src/connector.ts#L191) hanya menormalisasi token. Pemeriksaan identitas/principal/scope belum seketat akun creator/partner. | Validasi kontrak token seller, identitas yang diharapkan dan scope setiap refresh; scope berubah memengaruhi kemampuan fitur. Uji salah jenis akun, field wajib hilang dan principal berubah tanpa menampilkan token. |
| INT-11 / P1 | [Hasil stok Shopee](backend/packages/connectors/shopee/src/inventory.ts#L86) dianggap `ok: true` ketika tidak ada top-level error/failure, meskipun respons tidak menyertakan pengakuan keberhasilan model. | Tuntut bukti hasil sesuai kontrak per model/lokasi atau baca ulang untuk konfirmasi. Uji respons kosong/rusak, keberhasilan sebagian, model hilang dan nilai yang berubah; jangan tandai sinkron hanya karena tidak ada pesan error. |
| INT-07 / P1 | Horizon+ field biaya/hak pesanan belum lengkap; Imported Goods Indonesia memiliki perubahan 27 Oktober. [Audit platform](AUDIT-INTEGRASI-TIKTOKSHOP.md) mencatat kontraknya; publish sudah membaca ulang aturan kategori, belum bukti sandbox kasus regional. | Fixture per skenario Indonesia, normalisasi biaya/order rights, validasi pilihan seller sebelum publish, lalu akun uji berizin. Jangan mengklaim laba/settlement akurat hanya dari subtotal internal. |
| INT-08 / P2 | UI “Akun Creator & Partner” generik, tetapi [service](backend/src/modules/affiliate-accounts/accounts.service.ts#L116) hanya TikTok. PRD 11.2 pernah menampilkan matriks “Ya” tanpa label target, termasuk connector yang belum ada. | Label platform/jenis akun dan status kemampuan dengan jelas. Label matriks PRD dikoreksi pada audit ini; UI dan seluruh caption produk masih memerlukan perubahan tersendiri. |
| INT-09 / P2 | Ubah master produk pada [ProductsService](backend/src/modules/catalog/products.service.ts#L375) mengubah data lokal; [UI produk](frontend/src/features/products/product-detail.tsx#L116) tidak membuktikan perubahan listing marketplace. | Bedakan “tersimpan di master”, “menunggu sinkronisasi”, “diterima”, “terkonfirmasi”, “ditolak sebagian”. Tentukan field master yang boleh dipublikasikan; sukses lokal tidak boleh ditampilkan sebagai sukses marketplace. |
| INT-10 / P2 | App Store initiated install, limit adaptif per app/endpoint, mapping/mirror Tokopedia dan sebagian event belum selesai. Referensi fixed 10 request/detik adalah pengaturan lokal. | Implementasikan masing-masing kontrak, pembatas app+akun+operasi dan hasil parsial. Uji install yang aman, 429/backoff, pagination, duplikasi dan perubahan versi. |

## Batas peran integrator dan kriteria selesai

OmniSeller mengirim tindakan yang diizinkan dan menampilkan hasil commerce. Status pesanan,
fulfillment, retur, campaign, komisi dan settlement mengikuti fakta yang dikembalikan platform.
Data lokal tetap diperlukan untuk pemetaan SKU, draf, antrean, deduplikasi, audit dan laporan.
Master produk, gudang dan rencana alokasi stok juga sudah menjadi bagian PRD; perubahan lokal perlu
status publikasi tersendiri. Penjelasan “integrator” tidak otomatis menghapus fungsi tersebut.
Mode `read_only` dan aktivasi sinkronisasi harus tetap dihormati; stok yang belum ditetapkan tidak
didorong. Laporan penjualan internal dan tagihan SaaS Xendit tidak dihitung sebagai Finance API marketplace.

Untuk setiap operasi, catat platform/versi/method/path, principal, market, scope/program, request dan
response, pagination, limit, error, idempotensi serta event terkait. Setelah kontraknya jelas,
lengkapi connector, service tenant, worker/outbox, API, UI, role, penyimpanan/ekspor jika relevan,
pengujian kontrak/isolasi, dan konfirmasi hasil marketplace. Pisahkan status **dibuat**, **lulus uji lokal**,
**izin tersedia**, **lulus sandbox**, dan **siap produksi**. Fitur yang hanya ada di Seller Center
atau tidak tersedia melalui API ditandai keterbatasan platform setelah ada bukti resmi.

Urutan tindak lanjut: INT-01 sampai INT-06 dan INT-11, kemudian operasi seller/creator/partner affiliate,
promosi dan keuangan, lalu chat/analitik/health serta operasi khusus Indonesia. Program/country yang
belum terverifikasi tetap dalam matriks untuk investigasi; negara lain tetap backlog. Lazada, Blibli,
Shopify dan WooCommerce belum diaudit ulang pada pekerjaan ini dan belum mempunyai connector aktif.

## Provenance dan validasi audit

- Navigasi resmi TikTok diambil ulang **17 Oktober 2026 pukul 10.40 WIB**: 973 entri, 104 direktori,
  869 dokumen. SHA-256 `b1005604b13fc9052c89812176caaa07da58b69b4c1a0c8223cc7c363a7b6ec7`
  sama persis dengan snapshot terdahulu. Ini memverifikasi navigasi; isi 869 dokumen tidak seluruhnya
  dibaca ulang pada revisi ini.
- Sebanyak 14 dokumen publik dibaca ulang untuk onboarding, tiga principal, scope, token, profil/aset,
  App Store, deauthorization creator, Indonesia/Horizon+, shoppable photos dan CAP affiliate orders.
  [URL, tanggal pengambilan dan checksum](backend/docs/audits/2026-10-17-integrator-sources.json)
  disimpan. Ketentuan suatu operasi baru tetap harus diperiksa market/scope-nya; tampil di katalog
  tidak membuktikan berlaku di Indonesia. CAP juga tidak boleh otomatis dianggap TAP.
- Portal resmi Shopee dan portal affiliate Indonesia kembali gagal dibaca melalui proxy (tunnel HTTP 403;
  bukan bukti akun ditolak oleh Shopee). Baseline tetap
  snapshot 15 Mei 2026 pada commit `300344af94cf347268b50847baf14b9c28aaf1ae`. Metode auth creator
  Shopee dan kontrak yang belum tersedia tidak ditebak.
- Matriks dicocokkan dengan semua kelompok/angka pada CSV sumber dan referensi berkas kode, serta
  reproduksi pembulatan ID di Node 24. Audit ini mengubah dokumentasi saja. Hasil tes checkpoint
  sebelumnya berada di [ledger implementasi](IMPLEMENTASI-MARKETPLACE.md); suite aplikasi dan
  sandbox tidak dijalankan ulang untuk perubahan dokumentasi ini. Akses Creator API/TAP masih belum ada.

Kesimpulan status: pengembangan integrator sudah memiliki fondasi, tetapi **kesetaraan seluruh fitur
commerce serta creator belum tercapai**, dan belum dapat dibuktikan hanya dengan memasukkan API key.
