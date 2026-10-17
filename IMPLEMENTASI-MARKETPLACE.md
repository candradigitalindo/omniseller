# Implementasi fitur marketplace Indonesia

Cakupan yang diminta: seller Shopee dan Tokopedia & Shop, serta creator/affiliate partner Indonesia.
Operasional negara lain tetap backlog. Semua tenant memakai isolasi dan role dinamis; kemampuan
marketplace tetap dibatasi app scope, principal, izin toko/akun dan program platform.

Dokumen ini melacak implementasi setelah audit, bukan menyatakan seluruh fitur selesai. Referensi
endpoint tidak sama dengan fitur yang dapat digunakan. Kunci marketplace di lingkungan pengembangan
masih kosong pada pemeriksaan 17 Oktober 2026; tidak ada panggilan tulis ke toko nyata.

| Area | Status pengembangan | Pekerjaan yang masih terbuka |
|---|---|---|
| Harga reguler listing | Backend, outbox/worker, riwayat, pembatalan antrean, audit, ekspor dan modal untuk kedua marketplace telah diuji lokal | Sandbox nyata; aturan harga otomatis per kanal dan perubahan massal belum tercakup |
| Aturan produk terbaru | Validasi ulang kategori dari marketplace sebelum membuat listing baru; draf lama tidak melewati atribut wajib yang baru | Verifikasi sandbox perubahan Imported Goods; seluruh edit produk belum tersedia |
| Produk/media | Tarik, salin/publish, status dan stok sudah ada; masih parsial | Edit/partial edit/hapus, metadata, video, kualitas listing, operasi massal sesuai scope Indonesia |
| Otorisasi | Seller serta koneksi creator/affiliate partner Indonesia melalui principal terpisah, scope/profil/kategori, refresh, nama, disconnect, audit/ekspor dan UI telah diuji lokal (ADR-047) | Instalasi App Store, akses Creator API/TAP, sandbox nyata dan review platform |
| AMS/Affiliate | Alur baca AMS Shopee: worker/API/cache/UI, pencarian, komisi/periode, audit, ekspor, role dinamis dan isolasi diuji lokal | Mutasi campaign/komisi, targeted/open collaboration, sample, link dan performa affiliate TikTok; kolaborasi, sample, link dan performa setelah fondasi koneksi principal |
| Promosi | Belum diimplementasikan | Discount, voucher, flash sale, add-on/bundle, kampanye dan hasil parsial; aturan bentrok dan waktu lokal |
| Keuangan | Belum ada integrasi settlement | Statement, fee, pembayaran marketplace, transaksi/order/SKU dan rekonsiliasi; bedakan dari langganan Xendit |
| Chat/engagement | Belum diimplementasikan | Conversation/message, attachment, webhook, atribusi petugas, perlindungan dan retensi data pembeli |
| Analitik/video/live/ads | Belum ada integrasi lengkap | API sesuai principal/market, laporan, izin dan UI; laporan internal bukan seluruh Analytics API |
| Pesanan/pengiriman/retur | Alur inti ada; parsial | Horizon+, seluruh cancellation/refund/replacement/batch, reverse logistics, split/combine dan logistik regional |
| Push/health/fulfillment khusus | Parsial | Event yang belum ditangani, mapping/mirror Tokopedia, Account Health, FBS/FBT/SBS/First Mile yang berlaku di Indonesia |
| Kesiapan operasional | Tes tiruan dan isolasi tersedia; scope nyata belum dibuktikan | Rate limit adaptif, legalitas/domain final, app review dan sandbox tiap alur; tidak mengarang kredensial atau identitas usaha |

Urutan dependensi: fondasi harga/produk dan otorisasi, lalu modul pemasaran/affiliate, promosi,
keuangan, komunikasi/analitik dan operasi khusus. Setiap modul harus mempunyai backend/worker,
API/DTO, UI yang fungsional, izin/cakupan, ekspor jika menyimpan data, dan tes yang relevan.

Validasi penambahan harga: 620 tes unit/paket backend, 34 tes skema/e2e/isolation terkait, 533 tes
frontend (17 tes terkait diulang setelah perbaikan izin/modal), build web, serta browser pada lebar 320/390/768/1440 piksel lulus. Validasi ulang kategori
diuji dengan mengubah atribut wajib setelah draf ditinjau dan memastikan API pembuatan produk
tidak dipanggil; suite salin listing 12 tes lulus. Ini belum pengujian akun sandbox marketplace.

Rujukan: [audit Shopee](AUDIT-INTEGRASI-SHOPEE.md), [audit Tokopedia & Shop](AUDIT-INTEGRASI-TIKTOKSHOP.md),
[kontrak harga](backend/docs/adr/0045-listing-price-requests.md).

Validasi alur baca AMS: 426 tes unit aplikasi dan 198 tes paket backend lulus; 33 tes integrasi
AMS/skema/isolasi/retensi, 58 tes UI terkait (3 AMS diulang setelah perbaikan modal), build web dan
4 tes browser AMS pada 320/390/768/1440 piksel lulus. Tidak ada pengujian sandbox nyata.

Fondasi akun creator/partner: pengguna mengonfirmasi belum memiliki akses Creator API/beta/TAP,
dan mengizinkan pengembangan lokal. Migrasi 0033 diterapkan hanya pada database lokal; tidak ada
kredensial atau operasi akun marketplace nyata. Koneksi berbeda dari operasi bisnis affiliate;
kolaborasi/campaign, sample, link, komisi dan performa belum dikerjakan oleh checkpoint ini.

Validasi checkpoint akun creator/partner: 426 tes unit aplikasi dan 212 tes paket backend,
45 tes integrasi akun/skema/privilege/isolasi, 5 tes penutupan bisnis, serta 541 tes frontend lulus.
Sembilan tes akun diulang setelah penguatan kondisi balapan, ikatan pemohon dan konfigurasi publik.
Typecheck/lint, build web, empat uji browser akun dengan axe pada 320/390/768/1440 piksel serta
empat regresi browser AMS lulus. Halaman akun dan modal pada fixture tetap di dalam tinggi/lebar
viewport; mobile membaca satu kartu per halaman sejak permintaan pertama. Generator OpenAPI dan
kedua SDK diperbarui. Pemeriksaan PRD tetap 259 FR, 294 kriteria dan 811 evidence anchors.

Audit ulang 17 Oktober 2026 menegaskan model integrator: pengelola menyimpan kredensial aplikasi,
tenant memberikan consent menurut platform/principal, lalu fitur berjalan sesuai scope/program.
[Audit lengkap](AUDIT-INTEGRATOR-COMMERCE.md) dan [50 baris matriks](AUDIT-INTEGRATOR-FITUR.csv)
memisahkan seluruh 28 modul Shopee/19 modul TikTok, endpoint token dan area yang belum terinventaris.
Fondasi akun creator/partner di atas khusus TikTok Shop. Creator/publisher Shopee belum tersedia;
AMS seller tidak menggantikannya. Pada TikTok, showcase, konten video/foto shoppable dan pemetaan
produk creator juga masih backlog, selain kolaborasi/sample/link/komisi/performa.

Prioritas sebelum perluasan modul: capability/scope per operasi, webhook pencabutan creator,
penyimpanan grant seller sebelum discovery, ikatan pemohon/izin terbaru, presisi ID Shopee,
konfirmasi hasil stok dan validasi token seller. Temuan ini masih terbuka; perubahan audit
hanya dokumentasi. Navigasi TikTok diambil ulang dan identik; 14 dokumen publik dibaca ulang.
Portal Shopee terhalang proxy HTTP 403. Tidak ada uji sandbox atau perubahan akun nyata.
