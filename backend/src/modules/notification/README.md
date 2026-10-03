# Modul notification

## Tanggung jawab
Notifikasi untuk pengguna OmniSeller (PRD FR-NTF-01; backend doc 7.8.12, 8.15): notifikasi in-app yang ditulis modul lain, dan email (undangan, reset sandi) dari worker.

## Tabel yang dimiliki
- `notification`; `notification_preference` menyusul bersama pengaturan notifikasi (L44).

## Service publik
- `NotificationInboxService` (api dan worker): `notifyIn` (di dalam transaksi pemanggil, satu baris per penerima), `list`, `unreadCount`, `markRead`.
- `EmailSender` (`EMAIL_SENDER`, hanya worker): `smtp`, `log` (hanya local), `memory` (hanya test), dengan templat di `templates.ts`.

## Aturan
- Setiap pengguna hanya membaca dan menandai notifikasinya sendiri; penanda untuk id milik orang lain diabaikan.
- Isi notifikasi tidak memuat data pribadi pembeli; data cukup id pesanan.
- Pemanggil menentukan penerima (izin dan cakupan toko dan gudang); peringatan batas kirim memakai pengguna dengan `shipment:arrange` lewat `UsersService.recipientsIn`.

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/notifications` (`unread=true`, cursor) | masuk (milik sendiri) |
| GET | `/v1/notifications/unread-count` | masuk (milik sendiri) |
| POST | `/v1/notifications/read` (`ids` atau `all`) | masuk (milik sendiri) |

## Keputusan khusus modul
- Jenis notifikasi pertama: `order.sla` (peringatan batas kirim, modul orders). Pesanan baru, stok kritis, toko terputus, dan sinkron gagal, serta pengiriman lewat email dan WhatsApp sesuai preferensi, menyusul bersama pengaturan notifikasi.
