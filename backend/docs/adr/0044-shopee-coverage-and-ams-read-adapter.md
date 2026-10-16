# ADR-044 — Inventaris cakupan Shopee dan adapter AMS baca

Tanggal: 16 Oktober 2026. Status: diterima untuk pengembangan; gerbang rilis AMS belum terpenuhi.

## Konteks

Pemilik produk meminta pemeriksaan seluruh fitur Shopee dan secara khusus menunjuk API
`v2.ams.get_open_campaign_added_product`. Connector yang ada hanya menangani sebagian operasi.
Portal resmi mengembalikan HTTP 403 di lingkungan cloud ini; browser pengguna yang terbuka tidak
memberikan akses DOM kepada alat agent. Snapshot dokumentasi publik bertanggal 15 Mei 2026 tersedia.

## Keputusan

Inventaris memakai metadata snapshot yang dipin ke commit sumber, dengan provenance dan batas
verifikasi pada setiap baris. Referensi endpoint dihitung dari AST kode produksi dan dipisahkan dari
kelengkapan alur backend/UI, izin aplikasi, region, serta keberhasilan sandbox.

Endpoint yang diminta mendapat adapter baca bertipe melalui `MarketplaceConnector.affiliate?`.
Kemampuan ini opsional; tidak mengharuskan connector marketplace lain mengaku mendukung AMS.
Pembuatan adapter yang belum memiliki consumer aplikasi dibatasi pada endpoint yang secara eksplisit
diminta pengguna dan didokumentasikan sebagai pekerjaan parsial. Tidak menambah endpoint HTTP semu,
menu nonfungsional, izin tenant, penyimpanan data, atau operasi perubahan kampanye.

Kontrak snapshot dipakai untuk pengujian transport dan normalisasi: GET bertanda tangan, cursor,
filter, ID int64 sebagai string, komisi basis point, periode perlindungan dan tanggal tak terbatas.
Kegagalan entitlement AMS tetap galat permanen, tanpa memicu refresh token atau pencabutan otorisasi.

## Konsekuensi

Belum ada klaim semua fitur Shopee tersedia. AMS masih membutuhkan pemeriksaan kontrak resmi terbaru,
izin **Affiliate Marketing Solution Management** yang sesuai, aktivasi seller, kredensial sandbox,
serta implementasi service/job/API/UI dengan isolasi tenant. Panggilan jaringan berikutnya tetap harus
melalui `MarketplaceGateway` di worker dan outbox; API tidak memanggil marketplace langsung.

Snapshot mencakup 428 endpoint dan 48 panduan, tetapi bukan bukti kelengkapan katalog resmi terkini.
API chat dan program terbatas dapat tidak tercakup. Endpoint yang tidak relevan bagi Indonesia atau
jenis aplikasi tidak otomatis menjadi fitur yang harus diekspos ke semua tenant.
