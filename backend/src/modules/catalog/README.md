# Modul catalog

## Tanggung jawab
Produk master dan variannya, listing marketplace, dan pemetaan keduanya (PRD 6.2: FR-PRD-01 sampai 04, 09, 10, 11, 12; bagian produk FR-INT-04; backend doc 8.12, 8.23). Juga riwayat perubahan produk dan barcode: CRUD produk dengan atribut varian, tarik listing dari Shopee dan Tokopedia & Shop, pemetaan otomatis per SKU, saran pemetaan, membuat produk dari listing, aktif dan nonaktif di marketplace, serta impor dan ekspor CSV.

## Tabel yang dimiliki
- `listing_price_change` (migrasi 0031): permintaan perubahan harga per listing, harga sebelum/target/hasil, status worker, lease dan riwayat. Maksimal satu permintaan queued/processing per listing. Harga listing hanya berubah setelah dibaca kembali dari marketplace. API harga memakai `price:write`, cakupan toko dan Idempotency-Key; toko read_only ditolak. Worker membaca harga terbaru sebelum menulis, menolak perubahan di Seller Center yang lebih baru dan tidak mengubah harga promo. Dialog harga menampilkan antrean serta hasil konfirmasi. Riwayat ikut ekspor data penuh.
- `product`, `variant`, `product_image`, `bundle_component`, `channel_listing`. `listing_stock_state` milik modul inventory.
- Mengekspor view `catalog_variant_v` (`drizzle/sql/15_views.sql`): varian hidup beserta produknya, untuk dibaca modul lain.
- Membaca toko, cakupan toko, dan `sync_cursor` lewat `StoresService` (milik `channel`); repository ini tidak pernah menyentuh tabel `store`.

## Service publik
- `ProductsService` (api dan worker): `list`, `get`, `create`, `update` (`If-Match`), `remove`, `addVariant`, `updateVariant`; versi `...In(tx, ...)` untuk dipakai di transaksi lain (impor CSV, produk dari listing). Error: `product.not_found`, `variant.not_found`, `catalog.sku_taken`, `catalog.barcode_taken`, `product.has_listings`, `row.stale`, validasi atribut (422).
- `ListingsService` (api dan worker): `list`, `get`, `summary` (jumlah listing dan yang terpetakan, untuk progres L15), `unmappedWithSuggestions`, `map`, `autoMap`, `autoMapIn`, `createProductsFromListings`, `requestStatus`, `requestPull`. Error: `listing.not_found`, `listing.store_not_active`, `store.not_found`, varian tidak tersedia (422).
- `ProductsService` untuk riwayat dan barcode (backend doc 8.23): `history` (dari `audit_log` lewat `AuditService.entriesIn`, nama pelaku lewat `UsersService`; entri dibentuk `product-history.ts`), `generateBarcodes` (EAN-13 internal awalan 20, nomor dari `document_sequence` jenis `barcode`), `lookup` (barcode persis, lalu SKU).
- `ListingsService.deleteStoreListingsIn` (modul retention, toko diputus tanpa data).
- `ProductTransferService` (api dan worker): `exportCsv`, `importCsv(ctx, content, dryRun)`, `exportSheets` (`produk.csv` ekspor data penuh, backend doc 8.18), `importRecordsIn(tx, ctx, records)`: baris templat produk di transaksi pemanggil, masalah dikembalikan per baris dan kolom (impor migrasi, 8.19).
- Hanya worker: `ListingSyncService` (`pull`, `apply`, `refreshItems`, `pushStatus`); semua panggilan marketplace lewat `MarketplaceGateway.call`.
- Untuk modul inventory, di dalam transaksinya: `ListingsService.mappedForVariantsIn`, `mappedInStoreIn`, `listingsByIdsIn`.
- Untuk dasbor dan ekspor: `ListingsService.unmappedCountIn` (listing belum terpetakan dalam cakupan toko), `ListingsService.exportSheets` (`listing.csv`).
- Untuk checklist cutover: `ListingsService.unmappedInStoreIn(tx, storeId)`.
- Untuk salin listing (modul `listing-copy`, backend doc 8.25), di transaksi pemanggil: `ListingsService.itemListingsIn` (listing item asal), `storeItemIdsIn` dan `storeItemCountIn` (item toko yang masih ada), `listedVariantsIn` (varian yang sudah punya listing di toko), `mapCopiedIn` (petakan listing hasil salinan sebagai `copied`). Hanya worker: `ListingSyncService.refreshCopiedItem` (baca item yang baru dibuat, petakan `copied`, lalu pencocokan SKU).

## Aturan
- **HPP** (backend doc 8.24): hanya pemegang `finance:read` yang melihatnya (`seesCost` di `common/cost-visibility.ts`). Tanpa izin itu `costPrice` di jawaban produk bernilai `null`, perubahan HPP di riwayat tampil tanpa nilai (`withoutCost`, `hidden: true`), dan kolom `hpp` CSV ekspor kosong; impor ulang berkas itu tidak mengubah HPP karena sel kosong tidak mengubah apa pun. Mengisi HPP tetap dengan `catalog:write`. `produk.csv` di ekspor data penuh selalu memuat HPP.
- SKU produk dan SKU varian unik per bisnis tanpa membedakan huruf besar dan spasi tepi (`lower(btrim(sku))`, indeks unik migrasi 0004), sama dengan aturan pencocokan listing. Barcode unik persis.
- Barcode (`common/barcode.ts`, `barcodeProblem`): ASCII yang bisa dicetak tanpa spasi, paling banyak 48 karakter; angka sepanjang EAN-8, UPC-A, EAN-13, atau GTIN-14 harus punya check digit GS1 yang benar. Berlaku di API, impor CSV, dan impor migrasi; barcode lama tidak diubah.
- Setiap perubahan kolom produk dan varian masuk `audit_log` (trigger `audit_change_trg`), jadi riwayat produk lengkap; penulisan yang hanya mengubah `updated_at` dan `row_version` tidak dicatat.
- Produk punya maksimal tiga atribut. Setiap varian mengisi tepat semua atribut dengan nilai tidak kosong, dan kombinasinya unik per produk.
- Upsert listing tidak pernah mengubah pemetaan. `variant_id`, `mapping_source`, dan `mapped_at` terisi bersama atau kosong bersama (CHECK). Sumber pemetaan: `auto_sku`, `manual`, `created`, dan `copied` (listing yang dibuat dengan menyalin listing varian itu dari toko lain).
- Pemetaan otomatis hanya bila SKU listing cocok dengan tepat satu varian aktif. Pemetaan ke varian arsip ditolak.
- `autoMapBySku` membaca listing dan varian dalam query terpisah (varian lewat indeks SKU per 1.000), bukan join: join itu salah rencana tepat setelah tarikan katalog besar, sebelum statistik planner menyusul, dan melewati batas waktu pernyataan.
- Produk yang variannya masih dipetakan listing tidak bisa dihapus; arsipkan saja.
- Status listing hanya berubah dari jawaban marketplace: setelah aktif atau nonaktif dikirim, item dibaca ulang.
- "Stok habis" (FR-PRD-09) bukan status tersendiri: listing `active` dengan `stock = 0` di respons.
- Data dari marketplace diurai dengan `parseJsonSafe` (id TikTok Shop 19 digit).

## `channel_listing.channel_data`
Ditulis setiap tarikan (`ListingChannelData`): `itemSku`, `variantName`, `attributes`, `imageUrl`, `itemImageUrls`, `description`, `brand`, `categoryPath`, `weightG`, `dimensionsMm`, `stockByWarehouse` (per id gudang marketplace), `statusDetail` (status asli marketplace), `updatedAt`.

## Event
- Diterbitkan: `listing.pull_requested` (tarik ulang, atau lanjutan halaman berikutnya), `listing.status_push_requested` (maksimal 500 item per event), `listing.mapped`, `listing.unmapped` (dikonsumsi pusher stok di modul inventory).
- Dikonsumsi: `store.connected` (tarikan penuh pertama); dari webhook (`jobs/webhook-consumers.ts`): `listing.changed` (Shopee kode 6, 16, 22; TikTok Shop `PRODUCT_STATUS_CHANGE`, `PRODUCT_AUDIT_STATUS_CHANGE`).

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `listing.pull` | `mp.poll` | `store.connected` (penuh), `listing.pull_requested`, jadwal `mp.poll.products` 6 jam (inkremental) |
| `listing.status_push` | `mp.outbound` | `listing.status_push_requested` |

Satu job `listing.pull` membaca maksimal 10 halaman (`PAGES_PER_JOB`). Tarikan inkremental mundur 10 menit dari awal tarikan terakhir. Tarikan penuh menutup listing yang tidak terlihat (`deleted`) setelah halaman terakhir.

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/products`, `/v1/products/{id}` | `catalog:read` |
| POST, PATCH, DELETE | `/v1/products`, `/v1/products/{id}` | `catalog:write` |
| POST, PATCH | `/v1/products/{id}/variants`, `/v1/products/{id}/variants/{variantId}` | `catalog:write` |
| GET | `/v1/products/export` | `catalog:read` |
| GET | `/v1/products/{id}/history` | `catalog:read` |
| GET | `/v1/products/lookup?code=` | `catalog:read` |
| POST | `/v1/products/barcodes` | `catalog:write` |
| POST | `/v1/products/import` | `catalog:write` |
| GET | `/v1/listings`, `/v1/listings/summary`, `/v1/listings/{id}` | `catalog:read` |
| GET | `/v1/listings/unmapped` | `catalog:map` |
| POST | `/v1/listings/auto-map` | `catalog:map` |
| PUT | `/v1/listings/{id}/mapping` | `catalog:map` |
| POST | `/v1/listings/create-products`, `/v1/listings/sync` | `catalog:write` |
| POST | `/v1/listings/status` | `catalog:publish` |

## Format CSV
Kolom: `sku_produk`, `nama_produk`, `deskripsi`, `merek`, `kategori`, `sku_varian`, `nama_varian`, `atribut` (`Warna=Hitam; Ukuran=M`), `barcode`, `harga_jual`, `hpp`, `berat_gram`, `panjang_mm`, `lebar_mm`, `tinggi_mm`, `status` (`aktif`, `arsip`), `gambar` (URL dipisah ` | `). Satu baris per varian. Ekspor: penulis bersama `common/csv.ts` (pemisah `;`, UTF-8 dengan BOM, CRLF, `'` di depan teks yang diawali `=`, `+`, `-`, `@`, tab, atau CR agar spreadsheet tidak menjalankannya sebagai rumus). Impor: `;` atau `,`, awalan `'` itu dibuang lagi, maksimal 10.000 baris, semua atau tidak sama sekali, kesalahan di `rows.<baris>.<kolom>`. Berkas `produk.csv` di ekspor data penuh memakai kolom yang sama, jadi bisa diimpor ulang.

## Keputusan khusus modul
- Gambar disimpan sebagai URL (`product_image.source_url`) sampai pipeline berkas menyalinnya ke `file_object`.
- Produk dari listing memakai SKU induk item, atau `SP-<item_id>` / `TTS-<item_id>`, dan berat 100 g bila marketplace tidak mengisi.
- Template Excel (.xlsx) belum ada; CSV dengan BOM dan `;` dibuka Excel per kolom.
- Harga reguler per listing kini melalui `ListingPriceService`, `ListingPriceRepository` dan `ListingPriceWorkerService` (ADR-045), job `listing.price_push` pada `mp.outbound`; endpoint POST/GET `/v1/listings/{id}/price-changes`, POST `/v1/listings/{id}/price-changes/cancel`. GET memakai `catalog:read`; perubahan dan pembatalan memakai `price:write`. Body perubahan `{price, expectedPrice}`, Idempotency-Key wajib. Respons menyertakan `canCancel`; permintaan yang sudah diterima marketplace tidak bisa dibatalkan. Pemohon nonaktif, scope/izin berubah, toko read_only dan harga eksternal baru ditolak. Menyusul: aturan harga otomatis/massal, bundle (`bundle_component`). Salin listing antar toko (FR-PRD-13) ada di modul `listing-copy`. Push stok ada di modul inventory. Label barcode internal dicetak lewat dokumen modul fulfillment (`POST /v1/documents/barcode-labels`).
