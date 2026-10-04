# Modul files

## Tanggung jawab
Berkas privat (backend doc 8.15, 8.18, DOKUMEN-TEKNOLOGI 13): label pengiriman, dokumen cetak, dan ekspor data di Cloudflare R2, MinIO atau direktori lokal saat pengembangan; unduhan lewat api; penghapusan berkas yang kedaluwarsa.

## Tabel yang dimiliki
- `file_object`.

## Service publik
- `FilesService` (api dan worker): `save` (unggah lalu catat), `saveFile` (sama, untuk berkas besar di disk yang dialirkan ke penyimpanan), `read`, `download` (tautan bertanda tangan atau berkasnya; nama berkas dan `inline` atau `attachment` bisa diatur), `cleanupExpired`.
- `FileStorage` (`FILE_STORAGE`): `R2FileStorage` (S3 API, path-style, tautan GET 10 menit) atau `LocalFileStorage` (hanya `local` dan `test`); `put` (byte) dan `putFile` (stream dari disk).

## Aturan
- Unggah dulu, lalu tulis baris dalam transaksi pendek; transaksi tidak pernah terbuka selama unggahan. Unggahan yang barisnya gagal ditulis tertinggal sebagai objek tanpa baris.
- Kunci objek dibuat service (`t/<tenant>/<purpose>/<id>.<ext>`), tidak pernah dari permintaan, dan tanpa data pembeli.
- Berkas dengan data pembeli wajib punya `expires_at` (label 30 hari, dokumen dan ekspor 7 hari). Berkas unggahan migrasi (purpose `import`) disimpan 30 hari dan hanya dibaca worker; tidak ada endpoint unduhnya.
- Unduhan hanya untuk purpose yang diizinkan endpoint-nya (`label`, `pick_list` dengan `shipment:print` di sini; `export` lewat `/v1/exports/{id}/download` dengan `data:export`); berkas tenant lain atau yang kedaluwarsa tidak ditemukan.
- Klien S3 menghitung checksum hanya bila diwajibkan (`requestChecksumCalculation: "WHEN_REQUIRED"`): dengan bawaan SDK, unggahan stream sampai sebagai `aws-chunked` dengan trailer CRC32 yang tidak didokumentasikan R2.

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `files.cleanup_expired` | `pdf` | jadwal `files.cleanup_scan` (setiap jam, per tenant dengan berkas kedaluwarsa) |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/files/{id}/download` | `shipment:print` |

## Keputusan khusus modul
- Penyimpanan lokal (`FILE_STORAGE=local`) ada agar pengembangan tanpa Docker tetap bisa membuat dan mengunduh label; ditolak di staging dan produksi.
- Bucket R2 dibuat oleh infrastruktur (Terraform), bukan oleh aplikasi; lokal oleh `minio-init` di Docker Compose.
