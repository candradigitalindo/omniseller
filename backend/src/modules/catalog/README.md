# Modul catalog

## Tanggung jawab
Produk master dan variannya, listing marketplace, dan pemetaan keduanya (PRD 6.2: FR-PRD-01 sampai 04, 09, 10; bagian produk FR-INT-04; backend doc 8.12): CRUD produk dengan atribut varian, tarik listing dari Shopee dan Tokopedia & Shop, pemetaan otomatis per SKU, saran pemetaan, membuat produk dari listing, aktif dan nonaktif di marketplace, serta impor dan ekspor CSV.

## Tabel yang dimiliki
- `product`, `variant`, `product_image`, `bundle_component`, `channel_listing`. `listing_stock_state` milik modul inventory.
- Mengekspor view `catalog_variant_v` (`drizzle/sql/15_views.sql`): varian hidup beserta produknya, untuk dibaca modul lain.
- Membaca toko, cakupan toko, dan `sync_cursor` lewat `StoresService` (milik `channel`); repository ini tidak pernah menyentuh tabel `store`.

## Service publik
- `ProductsService` (api dan worker): `list`, `get`, `create`, `update` (`If-Match`), `remove`, `addVariant`, `updateVariant`; versi `...In(tx, ...)` untuk dipakai di transaksi lain (impor CSV, produk dari listing). Error: `product.not_found`, `variant.not_found`, `catalog.sku_taken`, `catalog.barcode_taken`, `product.has_listings`, `row.stale`, validasi atribut (422).
- `ListingsService` (api dan worker): `list`, `get`, `unmappedWithSuggestions`, `map`, `autoMap`, `autoMapIn`, `createProductsFromListings`, `requestStatus`, `requestPull`. Error: `listing.not_found`, `listing.store_not_active`, `store.not_found`, varian tidak tersedia (422).
- `ProductTransferService` (api dan worker): `exportCsv`, `importCsv(ctx, content, dryRun)`, `exportSheets` (`produk.csv` ekspor data penuh, backend doc 8.18), `importRecordsIn(tx, ctx, records)`: baris templat produk di transaksi pemanggil, masalah dikembalikan per baris dan kolom (impor migrasi, 8.19).
- Hanya worker: `ListingSyncService` (`pull`, `apply`, `refreshItems`, `pushStatus`); semua panggilan marketplace lewat `MarketplaceGateway.call`.
- Untuk modul inventory, di dalam transaksinya: `ListingsService.mappedForVariantsIn`, `mappedInStoreIn`, `listingsByIdsIn`.
- Untuk dasbor dan ekspor: `ListingsService.unmappedCountIn` (listing belum terpetakan dalam cakupan toko), `ListingsService.exportSheets` (`listing.csv`).
- Untuk checklist cutover: `ListingsService.unmappedInStoreIn(tx, storeId)`.

## Aturan
- SKU produk dan SKU varian unik per bisnis tanpa membedakan huruf besar dan spasi tepi (`lower(btrim(sku))`, indeks unik migrasi 0004), sama dengan aturan pencocokan listing. Barcode unik persis.
- Produk punya maksimal tiga atribut. Setiap varian mengisi tepat semua atribut dengan nilai tidak kosong, dan kombinasinya unik per produk.
- Upsert listing tidak pernah mengubah pemetaan. `variant_id`, `mapping_source`, dan `mapped_at` terisi bersama atau kosong bersama (CHECK).
- Pemetaan otomatis hanya bila SKU listing cocok dengan tepat satu varian aktif. Pemetaan ke varian arsip ditolak.
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
| POST | `/v1/products/import` | `catalog:write` |
| GET | `/v1/listings`, `/v1/listings/{id}` | `catalog:read` |
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
- Menyusul: dorong harga (`listing.price_push`), salin listing antar toko (FR-PRD-11 sampai 13), bundle (`bundle_component`). Push stok ada di modul inventory.
