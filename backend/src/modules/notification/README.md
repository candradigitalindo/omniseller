# Modul notification

## Tanggung jawab
Notifikasi untuk pengguna OmniSeller (PRD FR-NTF-01; backend doc 7.8.12, 8.15, 8.17): notifikasi in-app yang ditulis modul lain, dan email (undangan, reset sandi) dari worker.

## Tabel yang dimiliki
- `notification`; `notification_preference` menyusul bersama pengaturan notifikasi (L44).

## Service publik
- `NotificationInboxService` (api dan worker): `notifyIn` (di dalam transaksi pemanggil, satu baris per penerima), `notifyScopedIn` (penerima per izin, item per cakupan, satu notifikasi per pengguna), `list`, `unreadCount`, `markRead`.
- `inScope(recipient, item)`: aturan cakupan toko dan gudang yang sama dengan daftar pesanan.
- `EmailSender` (`EMAIL_SENDER`, hanya worker): `smtp`, `log` (hanya local), `memory` (hanya test), dengan templat di `templates.ts`.

## Aturan
- Setiap pengguna hanya membaca dan menandai notifikasinya sendiri; penanda untuk id milik orang lain diabaikan.
- Isi notifikasi tidak memuat data pribadi pembeli; data cukup id pesanan.
- Penerima dipilih lewat `notifyScopedIn`: pengguna aktif yang memegang izin, dan masing-masing hanya mendengar item di cakupan toko dan gudangnya. Pengguna yang tidak melihat satu item pun tidak menerima apa-apa.
- Notifikasi ditulis di transaksi modul yang memutuskan, oleh job modul itu (bukan oleh modul ini).

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/notifications` (`unread=true`, cursor) | masuk (milik sendiri) |
| GET | `/v1/notifications/unread-count` | masuk (milik sendiri) |
| POST | `/v1/notifications/read` (`ids` atau `all`) | masuk (milik sendiri) |

## Keputusan khusus modul
- Jenis notifikasi (backend doc 8.17): `order.new` dan `order.sla` (modul orders), `stock.critical` dan `sync.stock_push_failed` (inventory), `store.reauth_required` dan `store.authorization_expiring` (channel), `export.ready` dan `export.failed` (exports).
- Pengiriman lewat email dan WhatsApp sesuai preferensi menyusul bersama pengaturan notifikasi (L44).
