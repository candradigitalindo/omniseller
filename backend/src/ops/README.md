# CLI operasional

Jalankan dari `backend/` setelah `pnpm install` dan `pnpm build:packages`. Perintah membaca `.env.local`; variabel lingkungan yang sudah diset mengambil prioritas. `--help` menampilkan pilihan tanpa membuka koneksi.

Semua perintah memerlukan `NODE_ENV=local|test|staging|production`. Perubahan di produksi memerlukan `OPS_CONFIRM=1`; `--dry-run` dan daftar job gagal tidak memerlukannya. Pratinjau tidak mengubah baris, kunci, outbox, atau antrean.

## Perintah

| Perintah | Pilihan wajib | Hasil |
|---|---|---|
| `pnpm ops:webhook:replay` | `--tenant <ULID>`, lalu `--id <inbox ULID>` atau `--source shopee\|tiktokshop --since <ISO dengan zona>` | Inbox terverifikasi milik bisnis itu dijadwalkan ulang. `--force` diperlukan untuk yang sudah diproses. Reset `processed_at` dan event outbox satu transaksi. Setiap replay mempunyai id kejadian sendiri; job lama tidak dihapus. |
| `pnpm ops:stock:push` | `--tenant <ULID> --variant <ULID> --warehouse <ULID>` | Stok yang sudah ditetapkan di gudang aktif dikirim ulang melalui perencana stok biasa, walaupun nilai terakhir sama. Toko baca saja dan stok belum ditetapkan tetap dilewati; jumlah stok lokal tidak diubah. |
| `pnpm ops:partition:maintain` | — | Menjalankan `maintain_partitions(now())` yang juga dipakai scheduler. Tidak memindahkan baris dari partisi DEFAULT. |
| `pnpm ops:crypto:rotate-dek` | `--tenant <ULID>` | Menjadwalkan `tenant.dek_rotate`; JSON hasil memuat `rotationId`. Worker membuat versi DEK baru dan menyegel ulang kredensial dalam batch 50. |
| `pnpm ops:tenant:purge` | `--tenant <ULID>` | Menjadwalkan `tenant.purge` yang sudah ada, hanya setelah akun ditutup dan `purge_after` terlewati. Tidak dapat memotong masa 30 hari atau menutup akun dari CLI. |
| `pnpm jobs:dlq` | `--queue <nama antrean>` | Metadata job di daftar `failed` BullMQ, jumlah keseluruhan, dan `more`. Tidak menampilkan payload, hasil, stack trace, atau pesan error. |
| `pnpm jobs:retry` | `--queue <nama>`, lalu `--id <jobId>` atau `--all` | Memindahkan job gagal yang dikenal dan payload-nya sah ke antrean yang sama. Id, payload, dan pilihan job tetap; jumlah percobaan direset. Tidak mengulang job selesai/aktif atau membuang job. |

Semua mutasi menerima `--dry-run`. Replay berdasarkan sumber, daftar, dan retry `--all` dibatasi `--limit 1..1000` (bawaan 100); `more=true` berarti masih ada di luar batch. Untuk replay berikutnya, tunggu worker memproses batch atau pilih id; sebelum worker memprosesnya, notifikasi masih berstatus belum diproses. `--force` sengaja dapat mengulang batch yang sama. Job yang tidak dikenal atau payload-nya rusak dihitung `skipped` dan tetap tersimpan; gunakan `--id` untuk memilih job lain bila daftar penuh dengan job yang dilewati.

```sh
pnpm ops:webhook:replay --tenant <tenant_id> --source shopee --since 2026-10-16T00:00:00Z --limit 100 --dry-run
pnpm ops:stock:push --tenant <tenant_id> --variant <variant_id> --warehouse <warehouse_id> --dry-run
pnpm jobs:dlq --queue mp.outbound
pnpm jobs:retry --queue mp.outbound --id '<job_id>' --dry-run
```

## Akses dan pelaksanaan

- Perintah tenant memakai `DATABASE_URL_WORKER` dengan login **omniseller_worker**, di `withTenantTx` dan konteks sistem untuk tenant yang disebut. Pemeliharaan partisi memakai `DATABASE_URL_SYSTEM` dengan login **omniseller_system**, di `withSystemTx`. CLI menolak URL dengan login berbeda, termasuk superuser. Daftar dan retry job hanya memerlukan `REDIS_QUEUE_URL`.
- Replay, push stok, rotasi, dan purge hanya menulis outbox. Scheduler dan worker harus berjalan agar pekerjaan dilaksanakan; keberhasilan CLI berarti permintaan tersimpan, bukan marketplace sudah berubah atau data sudah terhapus. CLI tidak membutuhkan kunci marketplace, KMS, atau akses berkas.
- Rotasi dan penyimpanan token berbagi advisory lock transaksi per tenant, sebelum mengunci baris kredensial. Worker membaca versi aktif tiap penyegelan; cache 10 menit hanya menyimpan hasil unwrap berdasarkan tenant, versi, dan sidik jari ciphertext DEK. Retry memakai `rotationId` yang sama (id baris `tenant_key`) dan melanjutkan kredensial versi lebih lama; retry rotasi lama tidak menurunkan versi baru. Kunci lama tetap disimpan untuk pembaca yang sedang berjalan dan pemulihan cadangan.
- Tenant selain `active` menolak replay, push, dan rotasi. Purge tetap divalidasi ulang oleh worker dan fungsi SQL; membuka kembali akun sebelum worker berjalan membatalkan penghapusan.
- Output JSON memuat metadata dan jumlah saja. Error koneksi ditulis sebagai pesan umum agar URL, kata sandi, payload, dan error pihak luar tidak bocor. Kredensial salah, bisnis tidak memenuhi syarat, atau koneksi putus menghasilkan exit code 1. Tidak ada opsi menghapus job, menutup akun, atau memaksa purge lebih awal.

## Pengujian

`src/ops/ops-plan.spec.ts` menguji pilihan dan pagar produksi. `test/e2e/ops.e2e.int.spec.ts` memakai role aplikasi dan Redis dengan prefix per run: isolasi tenant, outbox, batas batch, purge, retry job, CLI asli, rotasi yang gagal setelah batch pertama, retry, cache rollback, serta penulis token yang bersamaan dengan rotasi. `test/e2e/stock.e2e.int.spec.ts` membuktikan stok marketplace yang berubah di luar OmniSeller dikembalikan tanpa mutasi stok lokal, dan toko baca saja tetap dilewati.
