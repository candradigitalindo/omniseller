# Modul listing-copy

## Tanggung jawab
Menyalin listing antar toko milik seller sendiri (PRD FR-PRD-13, backend doc 8.25): listing terpilih atau seluruh toko (paritas "salin toko" BigSeller) menjadi draf per toko tujuan, ditinjau dan diedit, lalu diterbitkan ke marketplace tujuan dengan gambar, varian, atribut, merek, dan kategori yang dipetakan. Listing hasil terbit dipetakan ke varian OmniSeller yang sama dengan listing asalnya. Pintu masuknya di layar L13 "Tambah produk > Salin dari toko".

## Tabel yang dimiliki
- `channel_category`: pohon kategori marketplace per toko dan aturan kategori akhir (cache, diisi worker).
- `category_mapping`: kategori tujuan yang dipilih seller untuk kategori asal.
- `listing_copy`: satu permintaan salin ke satu toko tujuan, dengan kemajuannya.
- `listing_draft`: satu item asal sebagaimana akan dibuat di toko tujuan.
- Membaca listing lewat `ListingsService` dan `ListingSyncService` (catalog), toko lewat `StoresService` (channel), stok awal lewat `StockComparisonService.initialStockIn` (inventory). Tidak pernah menyentuh tabel modul lain.

## Modul Nest
- `ListingCopyModule` (api dan worker): `ListingCopyRepository`, `CategoriesService`, `ListingCopyService`.
- `ListingCopyWorkerModule` (worker): `CategorySyncService`, `CopyWorkerService`, dan `IMAGE_FETCH` (host gambar dari env). Memakai `MarketplaceGateway` dari `ChannelWorkerModule` global.
- `ListingCopyHttpModule` (api): `StoreCategoriesController`, `ListingCopiesController`, `ListingDraftsController`.

## Service publik
- `ListingCopyService`:
  - salinan: `create(ctx, input, idempotencyKey)`, `list`, `get`, `cancel`;
  - draf: `listDrafts`, `getDraft`, `updateDraft` (`If-Match`), `deleteDraft`, `setCategory`, `setAttribute`, `publish`;
  - `problemsIn(tx, draft, targetStore)`: masalah draf terhadap kategori dan toko tujuan;
  - modul lain: `deleteStoreCopiesIn` (retention), `exportSheets()` (`draf_listing.csv`, `pemetaan_kategori.csv`).
  - Error: `listing_copy.not_found`, `listing_draft.not_found`, `listing_copy.finished`, `listing_draft.not_editable`, `row.stale`, `channel_category.unusable` (422), `channel_category.not_found`, validasi (`targetStoreIds`, `listingIds`, `attributes...`, `variants...`, `images...`, `variationNames`); dari channel `store.not_found`, `store.not_active`, `store.manual`.
- `CategoriesService` (api dan worker): `list`, `get` (antrekan pembacaan aturan bila belum ada), `requestRefresh` (paling sering sekali per 10 menit); di transaksi pemanggil: `categoryIn`, `categoriesIn`, `mappedCategoryIn`, `rememberIn`, `deleteStoreCategoriesIn`.
- Hanya worker:
  - `CategorySyncService`: `refresh` (pohon kategori), `ensureTree` (bila kosong atau lebih tua dari 7 hari), `rulesFor` (aturan dari cache bila lebih muda dari 7 hari);
  - `CopyWorkerService`: `prepare`, `failCopy`, `recheck`, `recheckGaveUp`, `publish`.

## Aturan
- Proses api tidak memanggil marketplace: kategori dan aturan dibaca dari cache, dan pembacaannya diantrekan ke worker.
- Keputusan murni ada di `copy-plan.ts` dengan uji unit: isi draf dari produk asal (`draftFromSource`), pemetaan atribut (`mapAttributes`: id untuk marketplace yang sama, nama dan sinonim untuk marketplace lain), harga (`adjustPrice`, ratusan rupiah), masalah (`problemsOf`), dan produk yang dibuat (`toProductToCreate`).
- Draf yang masih menunggu (bukan `published`) unik per toko tujuan, toko asal, dan item asal: salin ulang melewatinya.
- Yang boleh diedit hanya draf `draft` dan `failed`; draf `failed` yang diedit kembali `draft`. Foto hanya bisa diurutkan ulang dan dihapus; jumlah variasi tetap; varian bisa dihapus.
- Draf dengan masalah penghalang ditolak saat diterbitkan (`listing_draft.has_problems` di daftar `refused`).
- Gambar diunduh hanya dari host gambar marketplace (`image-fetch.ts`, ditambah `PRODUCT_IMAGE_HOSTS`): https, paling banyak 3 redirect yang diperiksa ulang, paling besar 10 MB, jenis dan ukuran piksel dari isi berkas. Gambar tidak disimpan.
- Referensi gambar yang sudah diunggah disimpan di draf saat itu juga; terbit ulang tidak mengunggah lagi.
- Stok awal produk = yang akan didorong pusher ke toko itu (`initialStockIn`); 0 untuk stok yang belum ditetapkan, toko mode paralel, dan varian tanpa produk OmniSeller.
- TikTok Shop: kunci idempoten Create Product `<draft_id>-<publish_attempt>`. Shopee: id item disimpan begitu `add_item` berhasil (`hooks.itemCreated`); terbit ulang melanjutkan item itu, tidak membuat item kedua.
- Listing baru dipetakan `copied` ke varian listing asal sebelum pencocokan SKU (`ListingSyncService.refreshCopiedItem`); `listing.mapped` memicu push stok.
- Salinan dan draf hanya terlihat bila toko asal dan tujuannya ada di cakupan toko pengguna.
- Status draf dan penghapusannya tercatat di `audit_log` tanpa isi produk.

## Event
- Diterbitkan: `listing_copy.requested` (juga lanjutan batch), `listing_draft.recheck_requested`, `listing_draft.publish_requested`, `channel_category.refresh_requested`, `channel_category.rules_requested`; `listing.mapped` lewat `ListingsService.mapCopiedIn`.
- Dikonsumsi: event miliknya sendiri.

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `listing_copy.prepare` | `mp.poll` | `listing_copy.requested`; 10 item per job, sisanya lanjutan; gagal setelah 5 percobaan |
| `listing_draft.recheck` | `mp.poll` | `listing_draft.recheck_requested` (kategori draf diganti) |
| `listing_draft.publish` | `mp.outbound` | `listing_draft.publish_requested`; id `listing_draft.publish\|<draft>\|<attempt>` |
| `channel_category.refresh` | `mp.poll` | `channel_category.refresh_requested` |
| `channel_category.rules` | `mp.poll` | `channel_category.rules_requested` |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/stores/{id}/categories`, `/v1/stores/{id}/categories/{categoryId}` | `catalog:read` |
| POST | `/v1/stores/{id}/categories/refresh` | `catalog:write` |
| POST | `/v1/listing-copies` | `catalog:write` |
| GET | `/v1/listing-copies`, `/v1/listing-copies/{id}` | `catalog:read` |
| POST | `/v1/listing-copies/{id}/cancel` | `catalog:write` |
| GET | `/v1/listing-drafts`, `/v1/listing-drafts/{id}` | `catalog:read` |
| PATCH, DELETE | `/v1/listing-drafts/{id}` | `catalog:write` |
| POST | `/v1/listing-drafts/category`, `/v1/listing-drafts/attributes` | `catalog:write` |
| POST | `/v1/listing-drafts/publish` | `catalog:publish` |

## Keputusan khusus modul
- Satu salinan per toko tujuan: kemajuan, kegagalan, dan pembatalan berdiri sendiri per toko.
- Kategori marketplace lain: pilihan seller sebelumnya, lalu rekomendasi marketplace tujuan (TikTok Shop diberi kategori dan merek asal). Merek dicari per nama di kategori tujuan; tidak ketemu berarti tanpa merek, dengan catatan.
- Tidak disalin: `listing_platforms` Tokopedia (bawaan TikTok Shop), video, sertifikat, harga grosir, tabel ukuran templat Shopee, gambar di dalam deskripsi. Pre-order tidak disalin ke TikTok Shop.
- Cache kategori adalah data rujukan marketplace, jadi tidak ikut ekspor data penuh.
