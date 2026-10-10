# Modul closure

## Tanggung jawab
Penutupan akun bisnis oleh pengelola langganan (PRD 12.1, layar L47 dan L54, backend doc 8.36): menutup, 30 hari baca saja untuk mengunduh ekspor atau membuka kembali, pengingat 7 hari sebelum data dihapus. Penghapusannya sendiri milik modul retention (`TenantPurgeService`).

## Tabel yang dimiliki
- Tidak ada. Penutupan dicatat di baris `tenant` (`closing_at`, `closed_by`, `purge_after`, `purge_reminded_at`) lewat `TenantsService` (identity).
- Lewat service modul pemilik: `StoresService.disconnectAllIn | channelsDisconnectedIn | revokeLinks` (channel), `BillingService.closeIn` (billing), `InvitationsService.revokeOpenIn`, `UsersService.idsIn | endSessions | recipientsIn | namesIn | twoFactorIn` (identity), `NotificationInboxService.notifyScopedIn` (notification).

## Service publik
- `AccountClosureService`:
  - `get(ctx)`: status, `closingAt`, `purgeAfter`, `closedBy`, `revokeLinks`, `purgeAfterDays`;
  - `close(ctx, {businessName, password}, keepToken?)` (api): 409 `account.closing`, 422 `businessName` atau `password`, 429 setelah terlalu banyak kata sandi salah (`reauth:user`);
  - `reopen(ctx)` (api): 409 `account.not_closing`;
  - `remind(ctx, now?)` (worker, job `account.purge_reminder`): sekali per penutupan, hanya saat tinggal 7 hari.
- `closure-plan.ts` (murni): `PURGE_AFTER_DAYS` (30, yang dijanjikan Syarat Layanan dan Kebijakan Privasi; situs publik mengujinya), `PURGE_REMINDER_DAYS` (7), `CLOSURE_REASON`, `purgeDate`, `reminderDue`, `confirmsName`.

## Aturan
- Hanya `settings:billing` (Owner secara bawaan), dengan nama bisnis diketik ulang dan kata sandi pengguna itu sendiri.
- Satu transaksi: status `closing`, toko marketplace diputus dengan data disimpan, paket ke Starter seperti memilihnya di L45, tagihan menunggu dibatalkan, undangan terbuka dicabut, notifikasi `account.closing` (dalam aplikasi dan email, selalu dikirim) ke pengelola langganan. Setelah commit, sesi pengguna lain berakhir.
- Selama `closing`, `AuthGuard` dan login hanya menerima pemegang `settings:billing`; tulis hanya lewat route `@AllowWhileClosing()`.
- Membuka kembali tidak menyambungkan toko lagi dan tidak mengembalikan paket atau undangan.

## Event
- Tidak ada yang diterbitkan sendiri; penutupan menerbitkan `store.disconnected` (channel) dan event billing lewat service pemiliknya.

## Job
| Job | Antrean | Pemicu |
|---|---|---|
| `account.purge_reminder` | `notify` | Scheduler `account.closure_scan` (setiap 10 menit, `scheduler/closure-scan.ts`), id per bisnis dan tanggal hapus |

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET, POST | `/v1/account-closure` | `settings:billing` (POST menjawab 200) |
| DELETE | `/v1/account-closure` | `settings:billing`; boleh saat akun ditutup |

## Keputusan khusus modul
- Modul sendiri karena menggabungkan identity, channel, billing, dan notification; identity tidak boleh mengimpor channel atau billing (mereka mengimpornya).
- Toko diputus saat penutupan, bukan dibiarkan terhubung tanpa dipakai: stok tidak boleh lagi didorong ke marketplace yang dikelola penjual di tempat lain.
