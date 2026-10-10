# Modul notification

## Tanggung jawab
Notifikasi untuk pengguna OmniSeller (PRD FR-NTF-01, FR-NTF-02; backend doc 7.8.12, 8.15, 8.17, 8.20):
- notifikasi in-app yang ditulis modul lain;
- preferensi notifikasi per pengguna;
- email (undangan, reset sandi, ringkasan harian) yang dikirim dari worker.

## Tabel yang dimiliki
- `notification`
- `notification_preference`: pilihan per pengguna dan jenis. Tanpa baris berarti bawaan jenis itu.

## Service publik
- `NotificationInboxService` (api dan worker):
  - `notifyIn`: di dalam transaksi pemanggil, satu baris per penerima. Dengan `{ email: true }` setiap notifikasi juga dikirim lewat email oleh job `notification.email` (event `notification.email_requested`).
  - `notifyScopedIn`: penerima per izin, item per cakupan, satu notifikasi per pengguna; opsi `email` sama.
  - `list`, `unreadCount`, `markRead`.
- `NotificationPreferencesService` (api dan worker):
  - `list`: jenis yang bisa dipilih, pilihan pengguna, dan bawaannya.
  - `set`: menyimpan pilihan pengguna sendiri.
  - `emailChoicesIn(tx, kind)`: pilihan email semua pengguna yang sudah memilih.
- `PREFERENCE_KINDS`: jenis yang bisa dipilih beserta label dan bawaan emailnya.
- `inScope(recipient, item)`: aturan cakupan toko dan gudang yang sama dengan daftar pesanan.
- `NotificationEmailService` (hanya worker, job `notification.email`): mengirim satu notifikasi ke penerimanya bila masih aktif dan mencatat `channels_sent.email`, sehingga ulangan job tidak mengirim dua kali.
- `EmailSender` (`EMAIL_SENDER`, hanya worker): `smtp`, `log` (hanya local), `memory` (hanya test). Templatnya di `templates.ts`, termasuk `dailyDigestEmail`. Pesan boleh membawa `attachments` (nama, tipe, isi); `log` hanya mencatat nama dan ukurannya (`attachmentSummary`).
- `EmailAttachments` (diekspor `NotificationInboxModule`): modul lain mendaftarkan sumber lampiran saat modul worker-nya mulai (`register`), dan job `notification.email` menanyai semuanya untuk setiap email (`for`), sebelum mengirim. Modul ini tidak mengimpor pemilik sumbernya. Sumber sekarang: PDF tagihan untuk email pembayaran (billing).

## Aturan
- Jenis `account.closing` (penutupan akun, pengingat 7 hari sebelum data dihapus, pembukaan kembali; backend doc 8.36) selalu dikirim ke pemegang `settings:billing`, dalam aplikasi dan email.
- Setiap pengguna hanya membaca dan menandai notifikasinya sendiri; penanda untuk id milik orang lain diabaikan. Preferensi juga hanya milik sendiri.
- Isi notifikasi tidak memuat data pribadi pembeli; data cukup id pesanan.
- Penerima dipilih lewat `notifyScopedIn`: pengguna aktif yang memegang izin, dan masing-masing hanya mendengar item di cakupan toko dan gudangnya. Pengguna yang tidak melihat satu item pun tidak menerima apa-apa.
- Notifikasi ditulis di transaksi modul yang memutuskan, oleh job modul itu (bukan oleh modul ini).
- Jenis di preferensi: `digest.daily` (email ringkasan operasional pukul 07.00, bawaan aktif bagi pemegang `report:read`), `legal.reminder` dan `billing.reminder` (terkunci, hanya bagi pemegang `settings:billing`; backend doc 8.29 dan 8.32), dan `store.connection_lost` (terkunci, "Selalu dikirim" di L44; tampil hanya bagi pemegang `settings:store`, mengubahnya ditolak 422 `notification_preference.locked`). Jenis lain memberi 404 `notification_preference.unknown_kind`.

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `notification.email` | `notify` | `notification.email_requested` (notifikasi yang juga dikirim lewat email) |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/notifications` (`unread=true`, cursor) | masuk (milik sendiri) |
| GET | `/v1/notifications/unread-count` | masuk (milik sendiri) |
| POST | `/v1/notifications/read` (`ids` atau `all`) | masuk (milik sendiri) |
| GET | `/v1/notifications/preferences` | masuk (milik sendiri) |
| PUT | `/v1/notifications/preferences/{kind}` (`email`) | masuk (milik sendiri) |

## Keputusan khusus modul
- **Jenis notifikasi** (backend doc 8.17):
  - `order.new` dan `order.sla` (modul orders);
  - `stock.critical` dan `sync.stock_push_failed` (inventory);
  - `store.reauth_required`, `store.authorization_expiring`, `store.warehouses_changed`, `store.connection_lost` (juga email), dan `store.connection_restored` (channel, backend doc 8.23);
  - `export.ready` dan `export.failed` (exports);
  - `migration.validated`, `migration.invalid`, `migration.imported`, dan `migration.failed` (migration);
  - `return.new` (pengajuan retur atau pembatalan menunggu keputusan, bagi `return:respond`), `return.parcel_back` (paket kembali, bagi `return:receive`), dan `return.due_soon` (tenggat dalam 12 jam; returns, backend doc 8.26).
- **Ringkasan email harian ada di modul `reporting`** (`DigestService`). Modul ini hanya menyimpan pilihan dan templatnya, karena orders, inventory, channel, dan returns mengimpor `NotificationInboxModule`.
- **Menyusul bersama layar pengaturan notifikasi (L44):** email dan WhatsApp untuk jenis lain sesuai preferensi (jalur email `notification.email` sudah ada), dan kolom `in_app` serta `whatsapp`, yang sudah ada di tabel tetapi belum dibaca.
