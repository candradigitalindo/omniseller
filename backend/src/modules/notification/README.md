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
  - `notifyIn`: di dalam transaksi pemanggil, satu baris per penerima.
  - `notifyScopedIn`: penerima per izin, item per cakupan, satu notifikasi per pengguna.
  - `list`, `unreadCount`, `markRead`.
- `NotificationPreferencesService` (api dan worker):
  - `list`: jenis yang bisa dipilih, pilihan pengguna, dan bawaannya.
  - `set`: menyimpan pilihan pengguna sendiri.
  - `emailChoicesIn(tx, kind)`: pilihan email semua pengguna yang sudah memilih.
- `PREFERENCE_KINDS`: jenis yang bisa dipilih beserta label dan bawaan emailnya.
- `inScope(recipient, item)`: aturan cakupan toko dan gudang yang sama dengan daftar pesanan.
- `EmailSender` (`EMAIL_SENDER`, hanya worker): `smtp`, `log` (hanya local), `memory` (hanya test). Templatnya di `templates.ts`, termasuk `dailyDigestEmail`.

## Aturan
- Setiap pengguna hanya membaca dan menandai notifikasinya sendiri; penanda untuk id milik orang lain diabaikan. Preferensi juga hanya milik sendiri.
- Isi notifikasi tidak memuat data pribadi pembeli; data cukup id pesanan.
- Penerima dipilih lewat `notifyScopedIn`: pengguna aktif yang memegang izin, dan masing-masing hanya mendengar item di cakupan toko dan gudangnya. Pengguna yang tidak melihat satu item pun tidak menerima apa-apa.
- Notifikasi ditulis di transaksi modul yang memutuskan, oleh job modul itu (bukan oleh modul ini).
- Jenis yang bisa dipilih sekarang hanya `digest.daily`: email ringkasan operasional pukul 07.00. Bawaannya aktif bagi pemegang `report:read`. Jenis lain di endpoint preferensi memberi 404 `notification_preference.unknown_kind`.

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
  - `store.reauth_required` dan `store.authorization_expiring` (channel);
  - `export.ready` dan `export.failed` (exports);
  - `migration.validated`, `migration.invalid`, `migration.imported`, dan `migration.failed` (migration).
- **Ringkasan email harian ada di modul `reporting`** (`DigestService`). Modul ini hanya menyimpan pilihan dan templatnya, karena orders, inventory, dan channel mengimpor `NotificationInboxModule`.
- **Menyusul bersama layar pengaturan notifikasi (L44):** pengiriman email dan WhatsApp untuk jenis lain sesuai preferensi, dan kolom `in_app` serta `whatsapp`, yang sudah ada di tabel tetapi belum dibaca.
