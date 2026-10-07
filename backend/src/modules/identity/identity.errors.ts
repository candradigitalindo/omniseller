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
