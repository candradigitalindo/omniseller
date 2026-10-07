# Modul identity

## Tanggung jawab
Tenant (bisnis), pengguna, peran bawaan, cakupan toko dan gudang, serta undangan anggota tim. Pendaftaran bisnis membuat tenant, enam peran bawaan (disalin ke tenant), Owner, dan gudang default `UTAMA`.

## Tabel yang dimiliki
- `tenant`, `user`, `role`, `role_permission`, `user_role`, `user_store_scope`, `user_warehouse_scope`, `invitation`, `api_key` (belum dipakai), `device` (agen cetak sejak backend doc 8.24; aplikasi gudang menyusul).
- `permission` (global, seed).

## Service publik
- `TenantsService.signup(input)`: tenant baru beserta Owner; slug `<nama>-<4 hex>`. Bisnis baru mulai di paket Growth dan menulis event `tenant.created`, sehingga modul `billing` mencatat uji cobanya (backend doc 8.32).
- Paket (backend doc 8.32): `TenantsService.planIn(tx, ctx)` (paket yang berlaku, `tenant.plan_id`), `listPlansIn`, `planNamesIn` (log audit dan ekspor), dan `setPlanIn` (hanya untuk modul `billing`). `plan` adalah tabel global yang diisi seed.
- `UsersService.loadPrincipal(tenantId, userId)`: identitas, izin, dan cakupan; dipakai `AuthGuard` di setiap permintaan.
- `UsersService.list | get | update | setRoles | setScopes | changeOwnPassword(ctx, ...)`. Error: `user.not_found`, `user.cannot_disable_self`, `role.last_owner`, `role.privilege_escalation`, `row.stale`.
- `UsersService.recordLoginSuccess | recordLoginFailure | resetPassword`: hanya untuk modul auth. `recordLoginFailure` juga dipakai untuk kode salah di langkah kedua login dan memberi `lockedUntil` bila akun baru terkunci.
- Verifikasi dua langkah (backend doc 8.30): kolom 2FA tabel `user` ditulis lewat `UsersService.twoFactorIn | setTwoFactorIn | useBackupCodeIn` di transaksi pemanggil (modul auth yang memutuskan), dan `rolesIn` untuk anjuran Owner dan Admin. `UsersService.revokeSessions(ctx, id, keep?)` mengeluarkan anggota dari semua perangkat; `resetTwoFactor(ctx, id)` mematikan 2FA anggota lalu mengeluarkannya. Error: `user.two_factor_reset_self`, `user.two_factor_reset_forbidden`, `two_factor.not_enabled`.
- `UsersService.recipientsIn(tx, permission)`: pengguna aktif dengan izin itu beserta cakupan toko dan gudangnya; penerima notifikasi (`notifyScopedIn`, backend doc 8.17).
- `UsersService.namesIn(tx)`: nama semua pengguna, termasuk yang dinonaktifkan (kolom pelaku di ekspor data).
- `UsersService.countSeatsIn(tx)`: pengguna yang tidak dinonaktifkan ditambah undangan terbuka, terhadap kuota pengguna paket; `billingContactIn(tx)`: pengguna aktif tertua yang memegang `settings:billing`, penerima tagihan Xendit.
- `TenantsService.timezone(ctx)`, `TenantsService.profile(ctx)`: zona waktu bisnis (arti "hari ini" di dasbor) dan nama bisnis.
- `RolesService.list | permissions(ctx)`.
- `InvitationsService.invite | resend | revoke | list(ctx, ...)`, `inspect(token)`, `accept(token, input)`, `send(ctx, invitationId)` (job). Error: `user.email_taken`, `invitation.already_open`, `invitation.not_found`, `invitation.invalid`, `billing.limit_reached` (undangan baru melebihi kuota pengguna paket: undangan terbuka ikut dihitung).
- `PreTenantLookup`: pembungkus fungsi `SECURITY DEFINER` (`auth_login_candidates`, `auth_resolve_invitation`, `auth_resolve_password_reset`, `auth_resolve_device`), satu-satunya bacaan di luar `withTenantTx` (backend doc 7.5).
- `DevicesService` (backend doc 8.24): `createIn` (token 256 bit sekali tampil, hanya hash yang disimpan), `getIn`, `activeIn`, `updateIn`, `revokeIn`, `reportIn` (versi dan printer laporan agen), dan `authenticate(token)` untuk `AuthGuard` dan `RealtimeGateway`: token tidak dikenal atau dicabut memberi null, `last_seen_at` ditulis paling sering 30 detik sekali. `isOnline`: melapor dalam 2 menit terakhir. Aturan agen cetak (gudang, antrean, cabut) ada di `fulfillment` (`PrintAgentsService`).

## Aturan
- Pengguna hanya bisa memberi peran (atau mengundang dengan peran) yang seluruh izinnya ia miliki sendiri.
- Tenant selalu punya minimal satu Owner aktif; pengguna tidak bisa menonaktifkan dirinya sendiri.
- Menonaktifkan pengguna dan mengganti kata sandi mencabut sesi di Redis.
- Mematikan 2FA anggota hanya untuk anggota lain yang izinnya tidak lebih luas dari pemanggil. Trigger audit `user` mencatat `status` dan `totp_enabled`, tanpa hash sandi, rahasia, kode cadangan, dan catatan login.
- Perangkat dicabut, tidak dihapus. Log audit mencatat pasang, ubah, dan cabut tanpa hash token, dan tidak mencatat laporan agen.
- Satu undangan terbuka per email per tenant. Token undangan dibuat job pengirim (bukan request), berlaku 72 jam; kirim ulang menerbitkan token baru dan membatalkan tautan lama.

## Event
- Diterbitkan: `invitation.send_requested`, `password_reset.requested`, `tenant.created` (skema di `identity.events.ts`).
- Dikonsumsi: tidak ada.

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/me` | sesi |
| POST | `/v1/me/password` | sesi |
| GET | `/v1/users`, `/v1/users/{id}` | `settings:user` |
| PATCH | `/v1/users/{id}` (If-Match opsional) | `settings:user` |
| PUT | `/v1/users/{id}/roles`, `/v1/users/{id}/scopes` | `settings:user` |
| POST | `/v1/users/{id}/sessions/revoke`, `/v1/users/{id}/two-factor/reset` | `settings:user` |
| GET | `/v1/roles`, `/v1/permissions` | `settings:user` |
| GET, POST | `/v1/invitations` | `settings:user` |
| POST | `/v1/invitations/{id}/resend` | `settings:user` |
| DELETE | `/v1/invitations/{id}` | `settings:user` |

Pendaftaran dan penerimaan undangan ada di controller modul auth (`/v1/auth/signup`, `/v1/auth/invitations/*`).

## Job
| Antrean | Nama | jobId |
|---|---|---|
| `notify` | `identity.invite_email` | `identity.invite_email\|<invitation_id>\|<outbox_event_id>` |
| `notify` | `auth.password_reset_email` | `auth.password_reset_email\|<user_id>\|<outbox_event_id>` |

## Keputusan khusus modul
- Controller hanya dimuat proses `api` (`IdentityHttpModule`); service dimuat `api` dan `worker` (`IdentityModule`).
- Peran kustom (FR-USR-01 S) menyusul di Fase 3.
