# Modul files

## Tanggung jawab
Berkas privat (backend doc 8.15, 8.18, DOKUMEN-TEKNOLOGI 13): label pengiriman, dokumen cetak, dan ekspor data di Cloudflare R2, MinIO atau direktori lokal saat pengembangan; unduhan lewat api; penghapusan berkas yang kedaluwarsa.

## Tabel yang dimiliki
- `file_object`.

## Service publik
- `FilesService` (api dan worker): `save` (unggah byte lalu catat), `saveFile` (stream dari disk untuk ekspor yang sudah ada), `saveFromLocalFile` dan `saveStream` (unggahan pengguna dengan ukuran tepat, maksimal 500 MiB), `metadata`, `read`, `readRange`, `download` (tautan bertanda tangan atau berkasnya; nama berkas dan `inline` atau `attachment` bisa diatur), `cleanupExpired`, `expireIn(tx, ids)` (berkas kedaluwarsa saat itu juga di transaksi pemanggil; job per jam menghapusnya: label dan dokumen pesanan dari toko yang datanya dihapus, backend doc 8.23).
- `FileStorage` (`FILE_STORAGE`): `R2FileStorage` (S3 API, path-style, tautan GET 10 menit) atau `LocalFileStorage` (hanya `local` dan `test`); `put` (byte), `putFile` (stream ekspor dari disk), `putStream` (stream dengan batas ukuran dan panjang tepat), `get` serta `getRange` (bagian berkas).

## Aturan
- Semua berkas tenant disimpan di bawah `t/<tenantId>/`: purge bisnis yang ditutup menghapus awalan itu (`FilesService.deleteAllObjects`, `FileStorage.deletePrefix`; R2 satu objek per permintaan karena DeleteObjects butuh checksum yang tidak didokumentasikan R2), backend doc 8.36.
- Unggah dulu, lalu tulis baris dalam transaksi pendek; transaksi tidak pernah terbuka selama unggahan. Unggahan yang barisnya gagal ditulis tertinggal sebagai objek tanpa baris.
- Kunci objek dibuat service (`t/<tenant>/<purpose>/<id>.<ext>`), tidak pernah dari permintaan, dan tanpa data pembeli.
- Berkas dengan data pembeli wajib punya `expires_at` (label 30 hari, dokumen dan ekspor 7 hari). Berkas unggahan migrasi (purpose `import`) disimpan 30 hari dan hanya dibaca worker; tidak ada endpoint unduhnya.
- Unduhan hanya untuk purpose yang diizinkan endpoint-nya (`label`, `pick_list` dengan `shipment:print` di sini; `export` lewat `/v1/exports/{id}/download` dengan `data:export`); berkas tenant lain atau yang kedaluwarsa tidak ditemukan.
- Klien S3 menghitung checksum hanya bila diwajibkan (`requestChecksumCalculation: "WHEN_REQUIRED"`): dengan bawaan SDK, unggahan stream sampai sebagai `aws-chunked` dengan trailer CRC32 yang tidak didokumentasikan R2.
- Unggahan commerce besar ditampung di berkas sementara pada disk, lalu `saveFromLocalFile` memeriksa ukuran aktual dan mengalirkannya ke penyimpanan. `saveStream` menghitung SHA-256 sambil mengalirkan data; batas unggahan pengguna adalah 500 MiB dan jumlah byte harus sama dengan ukuran yang dinyatakan. Tidak ada byte array sebesar seluruh video. `saveFile`/`putFile` untuk ekspor tetap memakai alur lama dan tidak mendapat batas unggahan pengguna ini.
- `readRange(ctx, id, start, endExclusive)` memakai rentang **setengah terbuka** `[start, endExclusive)`, maksimal 30 MiB per panggilan. Alur chunk commerce menggunakan callback ini; token dan pembacaan objek tetap di server. Service memeriksa tenant, awalan kunci privat, ukuran berkas dan kedaluwarsa, lalu memeriksa metadata kembali setelah pembacaan. Modul pemilik tetap memeriksa izin pengguna dan ikatan berkas ke akun/operasi sebelum meminta byte.
- Pembacaan lokal hanya membaca rentang yang diminta. R2 mengirim `Range: bytes=start-(endExclusive-1)` dan harus mengembalikan HTTP 206, `Content-Range` serta panjang yang cocok. Respons yang mengabaikan rentang ditolak sebelum isi dibaca; byte yang kurang atau berlebih juga ditolak.
- Operasi disk, hashing dan transfer penyimpanan tidak berjalan dalam transaksi database. Unggahan selesai sebelum transaksi metadata dibuka; pembacaan rentang berada di antara transaksi metadata yang pendek. Unggahan stream gagal tidak membuat baris dan berkas parsial dibersihkan. Bila hasil commit database tidak pasti, objek dipertahankan agar baris yang mungkin sudah tersimpan tetap memiliki berkas.

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
