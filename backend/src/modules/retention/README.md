# Modul retention

## Tanggung jawab
Menghapus data yang tidak boleh atau tidak diminta disimpan:
- data toko yang diputus tanpa menyimpan data (PRD FR-INT-07, backend doc 8.23);
- data pribadi pembeli pesanan yang melewati masa simpan bisnis (PRD 12.1, backend doc 8.34);
- bisnis yang ditutup setelah tanggal hapusnya (PRD 12.1, backend doc 8.36): seluruh baris dan berkasnya, kecuali tagihan dan langganan.
`retention.run` (inbox webhook lebih dari 30 hari, outbox terkirim lebih dari 7 hari, backend doc 9.5) berjalan di scheduler dengan role system (`scheduler/retention-run.ts`), bukan di modul ini.

## Tabel yang dimiliki
Tidak ada. Data dihapus lewat service modul pemiliknya, di transaksi pendek per batch.

## Service publik
- `StoreDataDeletionService.run(ctx, storeId, budgetMs?)` (hanya worker, job `store.data_delete`): `done`, `continued` (waktu habis; event `store.data_deletion_requested` ditulis lagi), atau `skipped` (toko tidak diminta dihapus, sudah selesai, atau tidak diputus).
- `TenantPurgeService.run(tenantId, budgetMs?)` (hanya worker, job `tenant.purge`): `not_due`, `continued` (waktu habis; pemindaian berikutnya melanjutkan), atau `done`. Semua hapus lewat fungsi SQL `SECURITY DEFINER` di `drizzle/sql/16_tenant_purge.sql` yang menolak bisnis yang belum ditutup dan belum lewat `purge_after`.
- `BuyerDataRetentionService.run(ctx, now?, budgetMs?)` (hanya worker, job `retention.buyer_anonymize`): `{anonymized, done}`. Masa simpan dari `BusinessProfileService.buyerDataRetentionIn`; batas waktu dari `retentionCutoff` (`retention-plan.ts`).

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

- Anonimisasi data pembeli: pesanan yang `ordered_at`-nya lebih tua dari masa simpan (3 sampai 24 bulan, bawaan 24) dan tidak lagi berstatus tahan kirim, yang tertua dulu, 500 per transaksi selama paling lama 20 detik per job. Per batch, berurutan: `FulfillmentService.anonymizeIn` (keterangan pelacakan kosong; label dan dokumen kedaluwarsa), `ReturnsService.anonymizeIn` (alasan, foto pembeli, dan foto bukti; berkasnya kedaluwarsa), lalu `OrdersService.anonymizeBuyersIn` (nama, username, telepon, catatan, id pembeli, pengirim dropship; alamat tinggal kota dan provinsi; `buyer_anonymized_at`). Nilai, barang, tanggal, dan riwayat tetap. Log hanya mencatat jumlah.

## Event
- Dikonsumsi: `store.data_deletion_requested` (modul channel saat diputus tanpa data, dan lanjutan dari modul ini).

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `store.data_delete` | `import` | `store.data_deletion_requested` |
| `tenant.purge` | `import` | Scheduler `account.closure_scan` (setiap 10 menit, `scheduler/closure-scan.ts`), id per bisnis dan slot |
| `retention.buyer_anonymize` | `import` | Scheduler `retention.buyer_scan` (setiap jam, `scheduler/retention-scan.ts`), id per bisnis dan jam |
