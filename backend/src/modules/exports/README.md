# Modul exports

## Tanggung jawab
Ekspor seluruh data bisnis kapan saja tanpa biaya (PRD FR-MIG-09, backend doc 8.18): sembilan CSV dalam satu ZIP, dari satu snapshot basis data, sebagai jaminan portabilitas data.

## Tabel yang dimiliki
- `data_export` (mesin status di backend doc 7.9).
- Data dibaca lewat `exportSheets()` setiap modul pemilik: `StoresService` (`toko.csv`), `WarehousesService` (`gudang.csv`), `ProductTransferService` (`produk.csv`), `ListingsService` (`listing.csv`), `ListingCopyService` (`draf_listing.csv`, `pemetaan_kategori.csv`), `InventoryService` (`stok.csv`, `mutasi_stok.csv`), `OrdersService` (`pesanan.csv`, `item_pesanan.csv`), `FulfillmentService` (`pengiriman.csv`), `HandoverService` (`serah_terima.csv`), `ReturnsService` (`retur.csv`, `retur_barang.csv`). Nama toko, kode gudang, dan nama pengguna lewat `StoresService.namesIn`, `WarehousesService.codesIn`, `UsersService.namesIn`. ZIP disimpan lewat `FilesService.saveFile`.

## Service publik
- `ExportsService` (api): `request`, `list`, `get`, `download`.
- Hanya worker: `ExportRenderService` (`render`, `sheets`).

## Aturan
- Izin `data:export` (Owner secara bawaan) dan tanpa batasan toko atau gudang: ZIP memuat semua toko dan gudang (403 `export.scope_limited`).
- Satu ekspor `queued` atau `running` per bisnis (indeks unik parsial); permintaan kedua mendapat yang sama. Ekspor yang tidak bergerak lebih dari 1 jam ditandai `failed` dan diganti. Ekspor gagal tidak diulang; permintaan berikutnya membuat yang baru.
- Semua sheet dibaca dalam satu transaksi `REPEATABLE READ READ ONLY` (`withTenantTx(..., { snapshot: true })`), per halaman 2.000 baris (keyset `id`), ditulis ke berkas di direktori sementara, lalu di-ZIP (yazl, streaming) dan diunggah dari disk. Tidak ada transaksi terbuka selama unggahan.
- ZIP berisi data pribadi pembeli: privat, kedaluwarsa 7 hari, permintaan dan setiap unduhan masuk `audit_log`. Isi dan URL-nya tidak pernah masuk log.
- CSV memakai `common/csv.ts`: `;`, BOM, CRLF, waktu ISO 8601 di zona waktu bisnis, dan `'` di depan teks yang mirip rumus spreadsheet.
- Tabel baru yang berisi data bisnis tenant mendapat `ExportSheet` di service pemiliknya dan didaftarkan di `ExportRenderService.sheets()`.

## Event
- Diterbitkan dan dikonsumsi: `export.requested`.

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `export.render` | `export` (satu job per worker) | `export.requested` |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| POST | `/v1/exports` | `data:export` (202) |
| GET | `/v1/exports`, `/v1/exports/{id}` | `data:export` |
| GET | `/v1/exports/{id}/download` | `data:export` |

## Keputusan khusus modul
- Keuangan (penarikan dana, biaya marketplace) dan pelanggan masuk ekspor saat modulnya ada; README.txt di ZIP menyebutnya.
- `produk.csv` memakai kolom templat impor produk agar bisa diimpor ulang; sheet lain menyertakan id agar berkas bisa dihubungkan.
