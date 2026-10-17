# Affiliate marketplace

Mengelola pembacaan produk open campaign AMS seller Shopee Indonesia. Creator dan affiliate partner
TikTok memakai principal berbeda dan belum didukung modul ini. Tidak mengubah campaign atau komisi.

`affiliate_product_query` (0032) menyimpan permintaan satu halaman, hasil yang dinormalisasi, cursor,
status, masa berlaku dan lease worker. Semua pembacaan tenant memakai withTenantTx dan cakupan toko.
Izin dinamis `affiliate:read` mengizinkan pencarian dan pembacaan; role Owner/Admin bawaan mendapat
izin ini di semua tenant. Token tetap hanya dibaca worker. Toko read_only boleh dibaca.

POST/GET `/v1/stores/{id}/affiliate/products`: POST menerima pageSize, search, sortBy, cursor serta
Idempotency-Key; membalas 202. GET mengambil permintaan terbaru, atau requestId tertentu milik toko
itu. UI memantau status, menelusuri halaman, dan membuka rincian periode/perlindungan di modal.
Satu toko memiliki maksimal satu pembacaan yang sedang antre/berjalan. Hasil kedaluwarsa setelah
24 jam dan dibersihkan saat permintaan berikutnya setelah tujuh hari. Pembersihan toko melalui
retention juga menghapus query. Snapshot hasil masuk ekspor data bisnis.

Event `affiliate.products_requested` -> job `affiliate.products_read` pada mp.poll. Satu job hanya
membaca satu halaman (maksimal 100 produk) lewat MarketplaceGateway; retry mengikuti batas laju,
lease mencegah hasil ganda dan izin pemohon diperiksa ulang. Hasil AMS yang menolak entitlement,
terms atau app scope ditampilkan sebagai kegagalan yang dapat ditindaklanjuti, bukan sukses kosong.

Kontrak mengikuti adapter AMS yang sudah diaudit (ADR-044); akses portal resmi masih ditolak pada
17 Oktober 2026. Tes menggunakan fixture bertanda tangan, bukan akun marketplace nyata. Aktivasi AMS,
izin Affiliate Marketing Solution Management, kontrak terbaru dan sandbox tetap harus diverifikasi
sebelum rilis. Modul ini tidak berarti seluruh API affiliate telah diimplementasikan.
