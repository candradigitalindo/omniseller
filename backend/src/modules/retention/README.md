# Modul retention

## Tanggung jawab
Menghapus data yang tidak boleh atau tidak diminta disimpan (backend doc 8.23):
- data toko yang diputus tanpa menyimpan data (PRD FR-INT-07);
- menyusul: `retention.run` (backend doc 9.5): inbox webhook lama, outbox terkirim, dan anonimisasi data pembeli sesuai kebijakan.

## Tabel yang dimiliki
Tidak ada. Data dihapus lewat service modul pemiliknya, di transaksi pendek per batch.

## Service publik
- `StoreDataDeletionService.run(ctx, storeId, budgetMs?)` (hanya worker, job `store.data_delete`): `done`, `continued` (waktu habis; event `store.data_deletion_requested` ditulis lagi), atau `skipped` (toko tidak diminta dihapus, sudah selesai, atau tidak diputus).

## Aturan
- Urutan per toko:
  0. pengajuan retur, pembatalan, dan paket kembali toko itu, 500 per transaksi beserta barangnya (`ReturnsService.deleteStoreReturnsIn`; backend doc 8.26). Pengajuan merujuk pesanannya, jadi dihapus lebih dulu;
  1. pesanan, 200 per transaksi: pengiriman dan paketnya dihapus serta label dan dokumen PDF pesanan itu kedaluwarsa (`FulfillmentService.deleteForOrdersIn`); stok yang masih ditahan dilepas, lalu pesanan dihapus beserta baris, riwayat, masalah, referensi, dan tagnya (`OrdersService.deleteOrdersIn`);
  2. listing, 500 per transaksi, beserta status push stoknya (`ListingsService.deleteStoreListingsIn`);
  3. log sinkron, 1.000 per transaksi (`SyncLogService.deleteStoreLogIn`);
  4. salinan listing dari dan ke toko itu, 50 per transaksi beserta drafnya (`ListingCopyService.deleteStoreCopiesIn`), lalu cache kategori marketplace toko, 2.000 per transaksi (`CategoriesService.deleteStoreCategoriesIn`; backend doc 8.25);
  5. aturan alokasi stok (`InventoryService.deleteStoreRulesIn`), gudang marketplace dan cursor sinkron, lalu `store.data_deleted_at` (`StoresService.finishDataDeletionIn`).
- Satu job bekerja paling lama 20 detik (`DELETION_BUDGET_MS`), lalu melanjutkan lewat event yang sama.
- Yang tetap: pergerakan stok (mencatat apa yang terjadi pada stok), log audit (siapa melakukan apa), dan baris toko sebagai penanda. Baris toko tidak dihapus karena `user_store_scope` merujuknya dengan CASCADE: pengguna yang cakupannya hanya toko itu akan kehilangan semua baris cakupan, padahal cakupan kosong berarti semua toko.
- Berkas ekspor data yang dibuat sebelumnya tetap sampai kedaluwarsa (8.18).

## Event
- Dikonsumsi: `store.data_deletion_requested` (modul channel saat diputus tanpa data, dan lanjutan dari modul ini).

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `store.data_delete` | `import` | `store.data_deletion_requested` |
