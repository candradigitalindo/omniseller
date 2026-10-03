# Modul files

## Tanggung jawab
Berkas privat (backend doc 8.15, DOKUMEN-TEKNOLOGI 13): label pengiriman dan dokumen cetak di Cloudflare R2, MinIO atau direktori lokal saat pengembangan; unduhan lewat api; penghapusan berkas yang kedaluwarsa.

## Tabel yang dimiliki
- `file_object`.

## Service publik
- `FilesService` (api dan worker): `save` (unggah lalu catat), `read`, `download` (tautan bertanda tangan atau berkasnya), `cleanupExpired`.
- `FileStorage` (`FILE_STORAGE`): `R2FileStorage` (S3 API, path-style, tautan GET 10 menit) atau `LocalFileStorage` (hanya `local` dan `test`).

## Aturan
- Unggah dulu, lalu tulis baris dalam transaksi pendek; transaksi tidak pernah terbuka selama unggahan. Unggahan yang barisnya gagal ditulis tertinggal sebagai objek tanpa baris.
- Kunci objek dibuat service (`t/<tenant>/<purpose>/<id>.<ext>`), tidak pernah dari permintaan, dan tanpa data pembeli.
- Berkas dengan data pembeli wajib punya `expires_at` (label 30 hari, dokumen 7 hari).
- Unduhan hanya untuk purpose yang diizinkan endpoint-nya (`label`, `pick_list` dengan `shipment:print`); berkas tenant lain atau yang kedaluwarsa tidak ditemukan.

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
