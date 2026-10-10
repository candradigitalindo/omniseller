# Modul auth

## Tanggung jawab
Masuk, keluar, sesi web, reset kata sandi, verifikasi dua langkah, perangkat yang masuk, dan dua guard global (`AuthGuard`, `PermissionGuard`).

## Tabel yang dimiliki
- `password_reset_token`. Sesi dan tantangan login disimpan di Redis cache (`common/security/session-store.ts`, `login-challenges.ts`), bukan di tabel. Kolom 2FA ada di tabel `user` milik identity.

## Service publik
- `AuthService.login(input)`: memeriksa kandidat dari `auth_login_candidates`, mengembalikan token sesi. Error: `auth.invalid_credentials`, `auth.locked`, `auth.tenant_choice_required` (dengan daftar `tenants`), `rate.limited`.
- `AuthService.startSession | logout | finishLogin`. Untuk akun dengan 2FA, `login` melempar `auth.two_factor_required` dengan `challenge` alih-alih membuka sesi.
- `TwoFactorService` (api saja, backend doc 8.30): `completeLogin` (langkah kedua; error `auth.two_factor_invalid`, `auth.two_factor_expired`, `auth.locked`), `status`, `setup`, `enable`, `regenerateBackupCodes`, `disable`. Error: `two_factor.already_enabled`, `two_factor.not_started`, `two_factor.not_enabled`, `validation.failed` pada `password`, `code`, atau `backupCode`.
- `UserSessionsService` (api saja): `list`, `revoke` (error `session.current`, `session.not_found`), `revokeOthers`.
- `AuthService.requestPasswordReset(email, ip)`: selalu berhasil dari sudut pandang pemanggil; `sendPasswordReset(ctx, userId)` (job); `confirmPasswordReset(token, password)`. Error: `auth.reset_token_invalid`.

## Aturan
- **Akun yang ditutup** (`tenant.status = 'closing'`, backend doc 8.36): login dan `AuthGuard` hanya menerima pemegang `settings:billing` (lainnya 403 `tenant.closing`), dan tulis hanya lewat route `@AllowWhileClosing()` (ekspor, buka kembali, keluar); lainnya 403 `tenant.read_only`.
- Sesi: token acak 256 bit di cookie `os_session` (HttpOnly, SameSite=Lax, Secure di luar lokal dan tes), 30 hari geser, maksimal 10 sesi per pengguna. Redis hanya menyimpan hash token.
- Kata sandi: Argon2id 64 MB, 3 iterasi, paralelisme 4 (`@node-rs/argon2`); hash lama dinaikkan parameternya saat login berhasil. Minimal 10 karakter.
- Email yang tidak terdaftar membuang waktu yang sama dengan verifikasi hash, sehingga waktu respons tidak membocorkan email terdaftar.
- 5 kegagalan berturut mengunci akun 15 menit. Akun terkunci ditolak sebelum kata sandi diperiksa, agar tebakan benar tidak bisa dibedakan dari tebakan salah.
- Email yang sama di beberapa bisnis: daftar bisnis hanya ditampilkan setelah kata sandi terbukti benar.
- Batas laju (token bucket di Redis): masuk 20/menit per IP dan 10/15 menit per email; daftar 5/jam per IP; reset 5/15 menit per IP dan 3/jam per email (yang terakhir ditolak diam-diam). API 600/menit per tenant.
- Token reset berlaku 60 menit, sekali pakai; reset berhasil membatalkan semua tautan lain, membuka kunci, dan mencabut semua sesi.
- `AuthGuard` memuat ulang izin dan cakupan dari basis data di setiap permintaan, sehingga perubahan peran langsung berlaku. Tenant `suspended` atau `closed` ditolak; `closing` hanya boleh membaca.

- Verifikasi dua langkah: TOTP (otplib 13), toleransi satu langkah, kode yang langkahnya sudah dipakai ditolak. Rahasia disegel `TOTP_ENCRYPTION_KEY` (api saja), kode cadangan disimpan sebagai HMAC. Tantangan langkah kedua berlaku 5 menit dan 5 kode; kode salah ikut menghitung penguncian akun; hanya permintaan yang mengakhiri tantangan yang membuka sesi.
- Menyalakan 2FA mencabut semua sesi lain pengguna. Mematikannya butuh kata sandi dan kode. Pemeriksaan ulang kata sandi dibatasi 10 per 15 menit per pengguna.

## Event
- Diterbitkan: `password_reset.requested` (didefinisikan di `identity.events.ts`).

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| POST | `/v1/auth/signup` | publik |
| POST | `/v1/auth/login` | publik |
| POST | `/v1/auth/login/two-factor` | publik |
| POST | `/v1/auth/logout` | sesi |
| GET | `/v1/me/two-factor` | sesi |
| POST | `/v1/me/two-factor/setup`, `/enable`, `/backup-codes`, `/disable` | sesi |
| GET | `/v1/me/sessions` | sesi |
| DELETE | `/v1/me/sessions/{id}` | sesi |
| POST | `/v1/me/sessions/revoke-others` | sesi |
| POST | `/v1/auth/password-reset`, `/v1/auth/password-reset/confirm` | publik |
| POST | `/v1/auth/invitations/inspect`, `/v1/auth/invitations/accept` | publik |

## Keputusan khusus modul
- `TwoFactorService` dan `UserSessionsService` hanya di `AuthHttpModule` (api): `AuthService` juga dibangun worker untuk email atur ulang sandi, dan worker tidak menerima `TOTP_ENCRYPTION_KEY`.
- Kewajiban 2FA untuk Owner dan Admin (Fase 2), token mobile dan refresh token, dan API key menyusul.
- Verifikasi email saat daftar dan Cloudflare Turnstile menyusul bersama rilis publik.
