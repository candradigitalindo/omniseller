# Modul migration

## Tanggung jawab
Pindah dari aplikasi lain tanpa stok kacau (PRD 6.20: FR-MIG-01, 05, 06; layar L46; backend doc 8.19):
- impor produk, varian, HPP, dan stok awal dari berkas Excel atau CSV aplikasi lain (BigSeller, Ginee, Jubelio, spreadsheet, templat OmniSeller) lewat pemetaan kolom terpandu;
- mode paralel: perbandingan pesanan dan stok kedua sistem;
- cutover dengan checklist, yang bisa dibatalkan dalam 24 jam.

## Tabel yang dimiliki
- `migration_job`, `migration_row_error`, `migration_preset`, `store_cutover` (mesin status `migration_job` dan `store_cutover` di backend doc 7.9).
- Data modul lain lewat service pemiliknya:
  - produk lewat `ProductTransferService.importRecordsIn`;
  - stok awal lewat `InventoryService.importInitialIn`;
  - gudang lewat `WarehousesService`;
  - perbandingan stok lewat `StockComparisonService`;
  - toko lewat `StoresService` (`listIn`, `lockIn`, `setSyncModeIn`, `unmappedWarehousesIn`);
  - listing belum terpetakan lewat `ListingsService.unmappedInStoreIn`;
  - pesanan lewat `OrdersService.statusCountsIn`;
  - berkas lewat `FilesService`.

## Service publik
- `ImportsService` (api): `upload`, `list`, `get`, `setMapping`, `requestValidation`, `requestImport`, `errors`, `errorsCsv`, `presets`, `preset`, `savePreset`, `deletePreset`.
- `ParallelModeService` (api): `summary`, `comparisonOf`, `stateIn` (checklist satu toko).
- `CutoverService` (api): `check`, `cutover`, `undo`, `list`.
- Hanya worker: `ImportRunnerService` (`validate`, `import`).
- Fungsi murni (uji unit):
  - `import-plan.ts`: field, sinonim judul per aplikasi, tebakan baris judul dan pemetaan, preset, konversi baris.
  - `xlsx.ts`, `sheet.ts`: pembaca berkas.

## Aturan
- **Berkas**:
  - Excel (.xlsx) atau CSV, paling besar 8 MB dan 10.000 baris. Jenisnya dikenali dari isi.
  - Isi .xlsx yang diekstrak dibatasi keras 96 MB (melawan ZIP bomb).
  - Berkas disimpan privat 30 hari, diunggah sebelum barisnya ditulis.
- **Validasi dan impor**:
  - Validasi menjalankan impor sungguhan di transaksi yang di-rollback.
  - Impor hanya dari `validated` dan semua atau tidak sama sekali: produk, stok awal, dan status job dalam satu transaksi.
  - Perubahan dicatat atas nama peminta.
- **Stok awal**: hanya mengisi stok yang belum pernah ditetapkan; impor tidak pernah menimpa hitungan.
- **Izin**:
  - Layar migrasi butuh `settings:store`.
  - Impor produk butuh `catalog:write`; stok awal juga butuh `inventory:adjust`.
- **Mode paralel**: tidak ada push stok dan tidak ada aksi pesanan. Perbandingan stok memakai rencana pusher (`planStockPush`) dengan toko dianggap `live`, tanpa mengirim apa pun.
- **Cutover**:
  - Semua toko yang diminta lolos checklist, atau tidak ada yang pindah (409 dengan alasan per toko).
  - Konfirmasi pencabutan aplikasi lama wajib.
  - Bisa dibatalkan sekali dalam 24 jam.
  - Cutover dan pembatalannya masuk `audit_log`.

## Event
- Diterbitkan dan dikonsumsi: `migration.validate_requested`, `migration.import_requested`.
- Toko yang pindah atau batal menulis `store.sync_mode_changed` (modul channel); pusher stok mengonsumsinya.

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `migration.validate` | `import` | `migration.validate_requested` |
| `migration.import` | `import` | `migration.import_requested` |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/migration/fields` | `settings:store` |
| POST, GET | `/v1/migration/imports` | `settings:store` (+ `catalog:write`) |
| GET | `/v1/migration/imports/{id}` | `settings:store` |
| PUT | `/v1/migration/imports/{id}/mapping` | `settings:store` (+ `catalog:write`) |
| POST | `/v1/migration/imports/{id}/validate`, `/v1/migration/imports/{id}/import` | `settings:store` (+ `catalog:write`, `inventory:adjust` untuk stok) |
| GET | `/v1/migration/imports/{id}/errors`, `/v1/migration/imports/{id}/errors/export` | `settings:store` |
| GET, POST | `/v1/migration/presets` | `settings:store` |
| DELETE | `/v1/migration/presets/{id}` | `settings:store` |
| GET | `/v1/migration/parallel`, `/v1/migration/stores/{id}/stock-comparison`, `/v1/migration/cutover-check` | `settings:store` |
| POST | `/v1/migration/cutover`, `/v1/migration/cutovers/{id}/undo` | `settings:store` |
| GET | `/v1/migration/cutovers` | `settings:store` |

## Keputusan khusus modul
- Judul kolom ekspor BigSeller, Ginee, dan Jubelio di pusat bantuan mereka hanya terlihat di tangkapan layar. Sinonim per aplikasi adalah tebakan awal; penjual memeriksa pemetaan di layar dan bisa menyimpannya. Perbarui sinonim dengan berkas nyata dari pedagang pilot.
- Pembaca .xlsx ditulis sendiri di atas fflate; SheetJS tidak dipakai (paket npm-nya berhenti di versi dengan kerentanan yang diketahui).
- Pencabutan otorisasi aplikasi lama tidak bisa diperiksa lewat API marketplace, jadi berupa konfirmasi penjual. Deteksi perubahan stok dari luar OmniSeller (FR-MIG-07) menyusul.
- Menyusul: impor pemetaan SKU listing dari aplikasi lama (FR-MIG-03), lokasi rak dan pemasok (FR-MIG-02), dan laporan migrasi lengkap (FR-MIG-08).
