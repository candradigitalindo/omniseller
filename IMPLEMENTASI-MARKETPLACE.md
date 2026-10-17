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
| Otorisasi | Seller via link/state tersedia | App Store, principal creator dan affiliate partner, pengelolaan akun/scopes, sandbox dan review |
| AMS/Affiliate | Alur baca AMS Shopee: worker/API/cache/UI, pencarian, komisi/periode, audit, ekspor, role dinamis dan isolasi diuji lokal | Mutasi campaign/komisi, targeted/open collaboration, sample, link dan performa affiliate TikTok; otorisasi tiap principal |
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
