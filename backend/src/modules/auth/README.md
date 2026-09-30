# Modul auth

## Tanggung jawab
Masuk, keluar, sesi web, reset kata sandi, dan dua guard global (`AuthGuard`, `PermissionGuard`).

## Tabel yang dimiliki
- `password_reset_token`. Sesi disimpan di Redis cache (`common/security/session-store.ts`), bukan di tabel.

## Service publik
- `AuthService.login(input)`: memeriksa kandidat dari `auth_login_candidates`, mengembalikan token sesi. Error: `auth.invalid_credentials`, `auth.locked`, `auth.tenant_choice_required` (dengan daftar `tenants`), `rate.limited`.
- `AuthService.startSession | logout`.
- `AuthService.requestPasswordReset(email, ip)`: selalu berhasil dari sudut pandang pemanggil; `sendPasswordReset(ctx, userId)` (job); `confirmPasswordReset(token, password)`. Error: `auth.reset_token_invalid`.

## Aturan
- Sesi: token acak 256 bit di cookie `os_session` (HttpOnly, SameSite=Lax, Secure di luar lokal dan tes), 30 hari geser, maksimal 10 sesi per pengguna. Redis hanya menyimpan hash token.
- Kata sandi: Argon2id 64 MB, 3 iterasi, paralelisme 4 (`@node-rs/argon2`); hash lama dinaikkan parameternya saat login berhasil. Minimal 10 karakter.
- Email yang tidak terdaftar membuang waktu yang sama dengan verifikasi hash, sehingga waktu respons tidak membocorkan email terdaftar.
- 5 kegagalan berturut mengunci akun 15 menit. Akun terkunci ditolak sebelum kata sandi diperiksa, agar tebakan benar tidak bisa dibedakan dari tebakan salah.
- Email yang sama di beberapa bisnis: daftar bisnis hanya ditampilkan setelah kata sandi terbukti benar.
- Batas laju (token bucket di Redis): masuk 20/menit per IP dan 10/15 menit per email; daftar 5/jam per IP; reset 5/15 menit per IP dan 3/jam per email (yang terakhir ditolak diam-diam). API 600/menit per tenant.
- Token reset berlaku 60 menit, sekali pakai; reset berhasil membatalkan semua tautan lain, membuka kunci, dan mencabut semua sesi.
- `AuthGuard` memuat ulang izin dan cakupan dari basis data di setiap permintaan, sehingga perubahan peran langsung berlaku. Tenant `suspended` atau `closed` ditolak; `closing` hanya boleh membaca.

## Event
- Diterbitkan: `password_reset.requested` (didefinisikan di `identity.events.ts`).

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| POST | `/v1/auth/signup` | publik |
| POST | `/v1/auth/login` | publik |
| POST | `/v1/auth/logout` | sesi |
| POST | `/v1/auth/password-reset`, `/v1/auth/password-reset/confirm` | publik |
| POST | `/v1/auth/invitations/inspect`, `/v1/auth/invitations/accept` | publik |

## Keputusan khusus modul
- 2FA TOTP (FR-USR-05, Fase 2), token mobile dan refresh token, token perangkat, dan API key menyusul; tabelnya sudah ada.
- Verifikasi email saat daftar dan Cloudflare Turnstile menyusul bersama rilis publik.
