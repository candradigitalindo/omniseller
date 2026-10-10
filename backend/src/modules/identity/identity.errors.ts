import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../common/errors/domain-errors";

export const userNotFound = () => new NotFoundError("user.not_found", "Pengguna tidak ditemukan.");
export const roleNotFound = () =>
  new ValidationError([{ path: "roleIds", message: "Peran tidak ditemukan." }], "Peran tidak ditemukan.");
export const invitationNotFound = () => new NotFoundError("invitation.not_found", "Undangan tidak ditemukan.");
export const invitationInvalid = () =>
  new NotFoundError("invitation.invalid", "Tautan undangan tidak berlaku lagi. Minta undangan baru ke pemilik toko.");
export const emailTaken = () => new ConflictError("user.email_taken", "Email ini sudah terdaftar di bisnis ini.");
export const invitationAlreadyOpen = () =>
  new ConflictError("invitation.already_open", "Email ini sudah punya undangan yang belum diterima. Kirim ulang saja.");
export const cannotDisableSelf = () =>
  new ConflictError("user.cannot_disable_self", "Anda tidak bisa menonaktifkan akun sendiri.");
export const lastOwner = () =>
  new ConflictError("role.last_owner", "Bisnis harus tetap punya minimal satu Owner yang aktif.");
export const privilegeEscalation = () =>
  new ForbiddenError("role.privilege_escalation", "Anda tidak bisa memberi peran dengan izin yang tidak Anda miliki.");
export const customRoleNotFound = () => new NotFoundError("role.not_found", "Peran tidak ditemukan.");
export const systemRole = () =>
  new ConflictError("role.system", "Peran bawaan tidak bisa diubah atau dihapus. Buat peran kustom bila perlu.");
export const roleNameTaken = () =>
  new ConflictError("role.name_taken", "Nama peran itu sudah dipakai. Pilih nama lain.", [
    { path: "name", message: "Nama peran itu sudah dipakai." },
  ]);
export const roleInUse = (usage: { users: number; invitations: number }) =>
  new ConflictError(
    "role.in_use",
    `Peran ini masih dipakai ${[
      usage.users ? `${usage.users} pengguna` : null,
      usage.invitations ? `${usage.invitations} undangan terbuka` : null,
    ]
      .filter(Boolean)
      .join(" dan ")}. Ganti peran mereka atau batalkan undangannya dulu.`,
    undefined,
    usage,
  );
export const twoFactorResetSelf = () =>
  new ConflictError(
    "user.two_factor_reset_self",
    "Untuk akun sendiri, matikan verifikasi dua langkah dari halaman Akun saya.",
  );
export const twoFactorResetForbidden = () =>
  new ForbiddenError(
    "user.two_factor_reset_forbidden",
    "Anda tidak bisa mematikan verifikasi dua langkah pengguna yang izinnya lebih luas dari Anda.",
  );
export const twoFactorNotEnabled = () =>
  new ConflictError("two_factor.not_enabled", "Verifikasi dua langkah akun ini tidak aktif.");
export const wrongCurrentPassword = () =>
  new ValidationError([{ path: "currentPassword", message: "Kata sandi saat ini salah." }]);
