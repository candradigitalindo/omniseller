# Modul sync

## Tanggung jawab
Log sinkron per toko dan inbox webhook marketplace (technology doc 8.3; backend doc 8.6, 8.11). Relay outbox ada di `scheduler/outbox-relay.ts`; dorongan stok dan polling pesanan bergabung ke sini bersama modul katalog dan pesanan.

## Tabel yang dimiliki
- `sync_job`: satu baris per operasi ke marketplace (`auth.refresh`, `warehouses.pull`, `webhooks.subscribe`, ...), dengan panggilan HTTP yang sudah disamarkan, durasi, dan pesan galat untuk seller.
- `webhook_inbox`: global (tanpa RLS), ditulis proses webhook sebelum tenant diketahui. Disimpan 30 hari.
- `outbox_event` (infra, `src/outbox`).

## Service publik
- `SyncLogService.run(ctx, entri, fn, ringkasan?)`: menulis baris `running`, menjalankan `fn` sambil merekam panggilan connector, lalu `succeeded` atau `failed`. `skipped(ctx, entri, alasan)`. `list(ctx, storeId, cursor, limit)`.
- `WebhookReceiver.receive(channel, headers, rawBody)` (proses webhook): verifikasi, simpan, enqueue. Error: `webhook.signature_invalid` (401), `channel.not_configured`.
- `WebhookInboxService.process(ctx, inboxId, konsumen, run)` (worker): normalisasi lalu panggil konsumen per jenis event.
- `describeSyncError(err)`: kode dan pesan berbahasa Indonesia untuk error connector.

## Aturan
- Proses webhook membaca body mentah; tanda tangan dihitung atas byte persis yang diterima.
- Satu baris inbox per (notifikasi, toko); id event `tts_notification_id` (TikTok Shop) atau SHA-256 body (Shopee). Duplikat jatuh di UNIQUE `(source, event_id)`.
- Jawaban selalu 200 dengan body kosong; penambahan job dibatasi 1,5 detik agar Shopee (batas 3 detik) tidak menganggapnya gagal. Kegagalan enqueue diperbaiki sapuan inbox.
- Baris inbox hanya diproses oleh job tenant pemiliknya; baris tenant lain diabaikan.
- Baris log sinkron ditulis di transaksi pendek sendiri, tidak pernah membungkus panggilan HTTP.

## Job dan jadwal
| Nama | Jenis | Keterangan |
|---|---|---|
| `webhook.process` | job, antrean `webhook` | Id `webhook.process\|<inbox_id>` |
| `webhook.inbox_sweep` | jadwal 30 detik (scheduler) | Enqueue ulang, rutekan notifikasi toko yang baru terhubung, tutup toko tak dikenal setelah 15 menit |

## Endpoint
| Metode | Path | Akses |
|---|---|---|
| POST | `/webhooks/shopee`, `/webhooks/tiktokshop` | proses `webhook`, tanda tangan marketplace |
