# Audit integrasi TikTok Shop / Tokopedia & Shop

**Seluruh fitur TikTok Shop belum tersedia di OmniSeller.** Alur seller inti sudah memiliki kode,
backend dan halaman, tetapi keberadaan connector tidak berarti seluruh API, izin, market, program
affiliate, ataupun kemampuan Partner Center sudah didukung.

## Sumber dan arti cakupan

Berangkat dari [About the Partner Center Console](https://partner.tiktokshop.com/docv2/page/about-partner-center-console),
audit mengakses dokumentasi publik resmi secara langsung pada 16 Oktober 2026 UTC. Halaman tersebut
adalah pengantar console untuk berbagai jenis partner, bukan daftar fitur wajib bagi setiap ERP.
Tautan navigasi mencakup Partner Guide, Developer Guide, API Reference, Webhooks, Terms and Policies,
serta Changelog. Materi TSP, CAP/MCN dan TAP tidak otomatis menjadi fitur ERP seller OmniSeller.

Navigasi resmi yang diambil memuat **973 entri: 104 direktori dan 869 dokumen**, termasuk **317 operasi
API Reference dalam 19 modul**. Isi seluruh dokumen leaf dan daftar versi API diambil; API overview
dibedakan dari endpoint, dan dua endpoint token berada di dalam panduan otorisasi. Rincian jumlah
versi dan pencocokan method/path kode ada di [ringkasan hasil generator](AUDIT-TIKTOKSHOP-RINGKASAN.md).
Ada **390 dokumen versi API**, ditambah dua endpoint token. Kode merujuk **37 dari 317 operasi katalog**
dan kedua endpoint token (39 kombinasi method/path); **280 operasi katalog belum memiliki referensi**.
Empat API baru tidak menyediakan body markdown; kontraknya diambil dari metadata dan contoh cURL
resmi, tanpa menebak arti kode numerik metode HTTP. Metadata publik empat API tersebut juga belum
mencantumkan scope; kolomnya tetap ditandai perlu verifikasi melalui Console/dukungan platform.
Katalog publik ini tidak membuktikan semua API terbatas/privat atau fitur yang hanya terlihat setelah login.

Artefak yang bisa ditinjau:

- [Inventaris dokumen dan hierarki](AUDIT-TIKTOKSHOP-DOKUMEN.csv), termasuk versi pembaruan dan URL resmi.
- [Endpoint per versi dan scope resmi](AUDIT-TIKTOKSHOP-ENDPOINTS.csv).
- [Referensi method/path kode](AUDIT-TIKTOKSHOP-KODE.csv), dengan berkas dan nomor baris sumber.
- [Persyaratan app review](AUDIT-TIKTOKSHOP-REVIEW.csv), termasuk penerapan berdasarkan market dan scope.

Referensi endpoint bukan persentase fitur lengkap. Inventaris seluruh isi juga bukan pernyataan bahwa
setiap ketentuan hukum, review, dan kontrak operasi telah dipenuhi. Tinjauan mendalam audit ini berfokus
pada alur seller aplikasi, onboarding/otorisasi, scope, versi, rate limit, app review dan perubahan Indonesia.
Keputusan kompatibilitas tiap field/operasi lain tetap memerlukan pengujian kontrak tersendiri.

## Pemetaan ke fitur aplikasi

| Area | Status aplikasi | Bukti dan batasnya |
|---|---|---|
| Otorisasi seller | Ada alur; parsial terhadap seluruh metode platform | [Connector](backend/packages/connectors/tiktokshop/src/connector.ts), [channel](backend/src/modules/channel/README.md), [UI toko](frontend/src/features/stores). Link/state, token, refresh dan cabut koneksi internal ada; pemasangan langsung dari App Store belum didukung. |
| Produk dan listing | Parsial | [Katalog](backend/packages/connectors/tiktokshop/src/catalog.ts), [salin listing](backend/src/modules/listing-copy/README.md), [UI](frontend/src/features/listing-copy). Tarik listing/varian, aktif/nonaktif, kategori/atribut/merek, gambar dan pembuatan salinan ada. Bukan seluruh CRUD produk, partial edit, penghapusan, aturan harga otomatis/massal, kualitas listing atau global products. |
| Stok dan gudang | Ada alur inti; parsial | [Inventory adapter](backend/packages/connectors/tiktokshop/src/inventory.ts), [modul stok](backend/src/modules/inventory/README.md), [UI stok](frontend/src/features/stock). Sinkron stok/pemetaan gudang tersedia; bukan seluruh Logistics atau FBT. |
| Pesanan | Ada alur inti; parsial | [Order adapter](backend/packages/connectors/tiktokshop/src/orders.ts), [modul](backend/src/modules/orders/README.md), [UI](frontend/src/features/orders). Tarik daftar/detail, pembatalan dan status tersedia; bukan seluruh operasi Order dan skenario program regional. |
| Pengiriman | Ada alur inti; parsial | [Fulfillment adapter](backend/packages/connectors/tiktokshop/src/fulfillment.ts), [modul](backend/src/modules/fulfillment/README.md), [UI](frontend/src/features/shipping). Slot serah terima, ship package, label dan tracking; belum seluruh split/combine/reroute, seller shipping atau pembelian label regional. |
| Retur/refund | Parsial | [Adapter](backend/packages/connectors/tiktokshop/src/returns.ts), [modul](backend/src/modules/returns/README.md), [UI](frontend/src/features/returns). Search, eligibility, bukti, approve/reject dan permintaan batal ada; bukan seluruh batch return, replacement, reverse package dan negosiasi. |
| Webhook/Event | Parsial | [Subscription dan parser](backend/packages/connectors/tiktokshop/src/webhooks.ts) menangani sembilan topik; bukan seluruh event resmi. Tokopedia mirror status change tipe 35 belum tercakup. |
| Seller API | Belum ditemukan referensi ke tiga operasi modul Seller | Informasi toko saat ini berasal dari grant/Get Authorized Shops; itu tidak mencakup seluruh Seller API. |
| FBT | Parsial | Deteksi region FBT dan daftar gudang tersedia saat menghubungkan toko; belum alur merchant onboarding, inbound, stok FBT, retur/claim dan UI FBT lengkap. |
| Promotion | Belum ditemukan integrasi | Belum ada adapter/alur diskon, aktivitas promosi dan flash sale TikTok. |
| Finance | Belum ditemukan integrasi | Belum ada settlement, payout, biaya dan rekonsiliasi transaksi/order/SKU TikTok. Pembayaran langganan aplikasi lewat Xendit adalah alur berbeda. |
| Analytics | Belum ditemukan integrasi API TikTok | Laporan internal penjualan/restock/kinerja tim bukan integrasi seluruh analitik toko, produk, LIVE atau video dari TikTok. |
| Customer service/engagement | Belum ditemukan integrasi | Belum ada chat/conversation, pengiriman pesan, session dan campaign pelanggan TikTok. |
| Affiliate creator/partner/seller | Fondasi koneksi creator/partner diuji lokal; operasi bisnis belum tersedia | [Akun terpisah](backend/src/modules/affiliate-accounts/README.md), [UI](frontend/src/features/affiliate-accounts), [ADR-047](backend/docs/adr/0047-affiliate-account-principals.md). Otorisasi, scope/profil/aset kategori ID, refresh/disconnect tersedia. Kolaborasi, open/target collaboration, sample, komisi, link dan performa tetap backlog. Adapter AMS Shopee terpisah. |
| Supply chain/Tools | Belum ditemukan integrasi | Confirm Package Shipment (Supply chain) dan Upload File Init (Tools) belum ada. Pemetaan ID produk Tokopedia/TikTok berada di Affiliate creator versi 202606 dan 202607, juga belum ada; principal dan scope mengikuti masing-masing versi/operasi. |
| Partner Center | Proses eksternal; belum dibuktikan selesai | Registrasi, legalitas, app/scopes, review, publikasi, akun sandbox, dashboard/log/testing tool dikelola di portal. Tidak semuanya perlu disalin menjadi halaman OmniSeller. |

## Temuan yang perlu diprioritaskan untuk Indonesia

1. **Atribut Imported Goods, efektif 27 Oktober 2026.** [Changelog resmi](https://partner.tiktokshop.com/docv2/page/dmo81egx)
   menyebut attribute `102254`, Yes `1000058` / No `1000059`, wajib untuk kategori selain digital pada
   seller lokal Indonesia. [Get Attributes dan normalisasinya](backend/packages/connectors/tiktokshop/src/products.ts)
   sudah dinamis; tes lokal atribut wajib dan penolakan draf yang stale sudah tersedia pada checkpoint harga/produk.
   Sandbox Indonesia masih perlu diverifikasi; refresh kategori dan pilihan seller tetap wajib sebelum publish.
2. **Horizon+ dan rincian biaya.** [Perubahan resmi](https://partner.tiktokshop.com/docv2/page/u62dh98s)
   menyebut `order_rights`, `distance_shipping_fee` dan `distance_fee_amount`/`distance_fee`. Adapter order
   kini membaca `sub_total`, harga baris, shipping fee dan total, tanpa memetakan field baru tersebut.
   Tandai parsial; verifikasi makna harga, ongkir dan laporan untuk pesanan Horizon+ dengan fixture dan
   order sandbox yang sesuai sebelum mengklaim rekonsiliasi/keuntungan sudah benar.
3. **Pemasangan via App Store.** [Seller authorization guide](https://partner.tiktokshop.com/docv2/page/seller-authorization-guide)
   membedakan link otorisasi dan pemasangan public app di App Store. [README channel](backend/src/modules/channel/README.md)
   menyatakan alur tanpa state dari App Store belum didukung. Butuh desain pengaitan tenant yang aman;
   jangan menghilangkan pemeriksaan state/tenant yang sudah ada untuk melewati masalah ini.
4. **Rate limit adaptif.** [Panduan resmi](https://partner.tiktokshop.com/docv2/page/rate-limits)
   menyatakan kuota dinamis dan bergantung jenis API/beban. Manifest sekarang memakai 10 request/detik
   per toko. Pembatas Redis, klasifikasi 429/`36009002` dan retry tersedia, tetapi pembatas app/endpoint
   serta penyesuaian kapasitas adaptif belum lengkap. Angka manifest bukan jaminan kuota platform.
5. **Scope dan principal.** [Access scope](https://partner.tiktokshop.com/docv2/page/access-scope)
   serta metadata per API harus cocok dengan scope aplikasi dan `granted_scopes` toko. Token seller
   sudah dibaca beserta scope, dan connector menolak `user_type` selain seller; itu belum memberikan
   akses creator/affiliate partner. Periksa entitlement sebelum membuka modul baru bagi tenant/toko.
6. **Versi API dan perubahan Tokopedia.** [Versioning](https://partner.tiktokshop.com/docv2/page/api-versioning)
   berlaku per API; versi berbeda bisa digunakan bersama setelah diuji. Versi bukan default belum tentu
   pensiun. [Penghentian Tokopedia Open API lama](https://partner.tiktokshop.com/docv2/page/k1156vkq)
   dan [one-pager Indonesia](https://partner.tiktokshop.com/docv2/page/id-market-tokopedia-shop-open-api-integration-one-pager)
   perlu menjadi acuan; app tidak boleh menganggap setiap API global berlaku di Indonesia. Branding
   seller saat ini sudah menggunakan Tokopedia & Shop, tetapi event/mapping platform belum lengkap.

## Onboarding dan gerbang rilis

[Developer onboarding](https://partner.tiktokshop.com/docv2/page/developer-onboarding) membedakan seller
developer (custom app untuk toko sendiri) dan ISV (public app untuk seller lain). OmniSeller banyak tenant
memerlukan jalur, target market dan scope yang sesuai. Email seller yang sama dapat mengarahkan akun
ke jalur seller developer menurut panduan; gunakan identitas usaha sebenarnya dan verifikasi di portal.
Tidak ada akun partner yang didaftarkan atau diubah oleh audit ini.

[App review requirements](https://partner.tiktokshop.com/docv2/page/app-review-requirements) bergantung
market, app type dan fitur yang ditawarkan. ERP-001 sampai ERP-004 memiliki alur kode yang relevan,
tetapi belum diverifikasi reviewer/sandbox. Domain produk yang dapat diakses, akun review, demo nyata,
callback, HTTPS, privasi/retensi data dan scope harus dibuktikan. [Konfigurasi website](website/site.json)
masih memuat placeholder identitas/domain; tersedianya template legal tidak membuktikan siap diajukan.

Fitur baru dinyatakan selesai setelah kontrak resmi, izin principal/market, tenant/toko, worker/outbox,
API/DTO, UI, retry/idempotensi/hasil parsial dan tes yang relevan terpenuhi, lalu diuji memakai akun
sandbox yang berizin. Tes lokal dengan respons tiruan tidak menggantikan sandbox atau persetujuan review.

## Validasi audit

`pnpm --filter @omniseller/connector-tiktokshop test` lulus **57 tes dalam tiga berkas**. Ini menguji
perilaku connector yang sudah ada, bukan semua API platform. `pnpm lint` lulus, inventaris dapat
digenerasi ulang dengan hasil identik, dan snapshot yang checksum-nya berubah ditolak. Pengecekan
independen mencocokkan 392 baris method/path dengan kontrak resmi, 37 referensi kode, 94 aturan review
dan tautan bukti; empat scope yang tidak tercantum tetap belum terverifikasi. Audit hanya menambah inventaris, alat
pemetaan dan dokumentasi; tidak mengubah perilaku aplikasi atau menambahkan menu/adapter semu.
[README connector](backend/packages/connectors/tiktokshop/README.md) memuat format snapshot dan cara
mengulang inventaris. Tidak ada klaim seluruh fitur selesai, sandbox lulus, public app terbit atau
persetujuan marketplace diterima.

## Implementasi sesudah audit
17 Oktober 2026: perubahan harga reguler per listing kini memiliki backend/worker/UI/riwayat dan tes lokal. Sebanyak 35/317 operasi katalog dirujuk kode (ditambah dua endpoint token); 282 belum. Worker publish kini membaca aturan kategori terbaru untuk menolak draf yang kehilangan atribut wajib. Provenance katalog tetap snapshot resmi audit 16 Oktober. Rincian dan modul yang masih terbuka ada pada [status implementasi](IMPLEMENTASI-MARKETPLACE.md).

Kontrak Authorization overview, Creator authorization guide, Partner authorization guide,
Get Creator Profile 202508 dan Get Authorized Category Assets 202405 dibaca langsung dari sumber
publik resmi pada 17 Oktober 2026. Ini menambahkan dua operasi katalog yang dirujuk kode, tanpa
mengubah snapshot navigasi 16 Oktober. Pengguna mengonfirmasi belum ada akses Creator API/beta/TAP;
seluruh verifikasi koneksi baru memakai server simulasi lokal dan bukan bukti persetujuan platform.

Audit ulang model integrator 17 Oktober 2026 tersedia di [audit lintas platform](AUDIT-INTEGRATOR-COMMERCE.md).
Navigasi resmi diambil ulang pukul 10.40 WIB dengan checksum identik; 14 dokumen publik dibaca ulang.
Temuan tambahan mencakup webhook creator deauthorization tipe 20, capability/scope per operasi,
validasi token seller, serta kelengkapan showcase/konten/mapping creator. Koneksi dan penayangan
profil/aset belum berarti operasi bisnis creator/TAP/CAP tersedia. [Matriks](AUDIT-INTEGRATOR-FITUR.csv)
dan [provenance](backend/docs/audits/2026-10-17-integrator-sources.json) menyimpan rincian pemeriksaan.
