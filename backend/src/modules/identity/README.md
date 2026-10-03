# Modul identity

## Tanggung jawab
Tenant (bisnis), pengguna, peran bawaan, cakupan toko dan gudang, serta undangan anggota tim. Pendaftaran bisnis membuat tenant, enam peran bawaan (disalin ke tenant), Owner, dan gudang default `UTAMA`.

## Tabel yang dimiliki
- `tenant`, `user`, `role`, `role_permission`, `user_role`, `user_store_scope`, `user_warehouse_scope`, `invitation`, `api_key`, `device` (dua terakhir belum dipakai).
- `permission` (global, seed).

## Service publik
- `TenantsService.signup(input)`: tenant baru beserta Owner; slug `<nama>-<4 hex>`.
- `UsersService.loadPrincipal(tenantId, userId)`: identitas, izin, dan cakupan; dipakai `AuthGuard` di setiap permintaan.
- `UsersService.list | get | update | setRoles | setScopes | changeOwnPassword(ctx, ...)`. Error: `user.not_found`, `user.cannot_disable_self`, `role.last_owner`, `role.privilege_escalation`, `row.stale`.
- `UsersService.recordLoginSuccess | recordLoginFailure | resetPassword`: hanya untuk modul auth.
- `UsersService.recipientsIn(tx, permission)`: pengguna aktif dengan izin itu beserta cakupan toko dan gudangnya; penerima peringatan (modul orders, FR-SHP-10).
- `RolesService.list | permissions(ctx)`.
- `InvitationsService.invite | resend | revoke | list(ctx, ...)`, `inspect(token)`, `accept(token, input)`, `send(ctx, invitationId)` (job). Error: `user.email_taken`, `invitation.already_open`, `invitation.not_found`, `invitation.invalid`.
- `PreTenantLookup`: pembungkus fungsi `SECURITY DEFINER` (`auth_login_candidates`, `auth_resolve_invitation`, `auth_resolve_password_reset`), satu-satunya bacaan di luar `withTenantTx` (backend doc 7.5).

## Aturan
- Pengguna hanya bisa memberi peran (atau mengundang dengan peran) yang seluruh izinnya ia miliki sendiri.
- Tenant selalu punya minimal satu Owner aktif; pengguna tidak bisa menonaktifkan dirinya sendiri.
- Menonaktifkan pengguna dan mengganti kata sandi mencabut sesi di Redis.
- Satu undangan terbuka per email per tenant. Token undangan dibuat job pengirim (bukan request), berlaku 72 jam; kirim ulang menerbitkan token baru dan membatalkan tautan lama.

## Event
- Diterbitkan: `invitation.send_requested`, `password_reset.requested` (skema di `identity.events.ts`).
- Dikonsumsi: tidak ada.

## Endpoint
| Metode | Path | Izin |
|---|---|---|
| GET | `/v1/me` | sesi |
| POST | `/v1/me/password` | sesi |
| GET | `/v1/users`, `/v1/users/{id}` | `settings:user` |
| PATCH | `/v1/users/{id}` (If-Match opsional) | `settings:user` |
| PUT | `/v1/users/{id}/roles`, `/v1/users/{id}/scopes` | `settings:user` |
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
