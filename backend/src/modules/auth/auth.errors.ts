import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "../../common/errors/domain-errors";

export const authRequired = () => new UnauthorizedError("auth.required", "Silakan masuk terlebih dulu.");
export const deviceUnauthorized = () =>
  new UnauthorizedError(
    "auth.device_invalid",
    "Token agen cetak tidak berlaku lagi. Pasang ulang agen dari halaman Printer.",
  );
export const invalidCredentials = () =>
  new UnauthorizedError("auth.invalid_credentials", "Email atau kata sandi salah.");
export const accountLocked = (until: Date) =>
  new ForbiddenError(
    "auth.locked",
    "Akun dikunci sementara karena terlalu banyak percobaan masuk yang gagal. Coba lagi nanti atau atur ulang kata sandi.",
    undefined,
    { locked_until: until.toISOString() },
  );
export const tenantChoiceRequired = (tenants: { slug: string; name: string }[]) =>
  new ConflictError(
    "auth.tenant_choice_required",
    "Email ini terdaftar di beberapa bisnis. Pilih bisnis yang dituju.",
    undefined,
    {
      tenants,
    },
  );
export const tenantInactive = () =>
  new ForbiddenError("tenant.inactive", "Bisnis ini sedang dinonaktifkan. Hubungi tim OmniSeller.");
export const tenantReadOnly = () =>
  new ForbiddenError("tenant.read_only", "Bisnis ini sedang ditutup dan hanya bisa dibaca.");
export const permissionDenied = () =>
  new ForbiddenError("auth.permission_denied", "Anda tidak punya izin untuk tindakan ini.");
/** The password is right; the client sends a code with `challenge` to POST /v1/auth/login/two-factor. */
export const twoFactorRequired = (challenge: string, expiresInSeconds: number) =>
  new UnauthorizedError(
    "auth.two_factor_required",
    "Masukkan kode dari aplikasi autentikator untuk menyelesaikan masuk.",
    undefined,
    { challenge, expires_in: expiresInSeconds },
  );
export const twoFactorInvalid = () =>
  new UnauthorizedError("auth.two_factor_invalid", "Kode salah atau sudah dipakai. Coba kode yang baru.");
export const twoFactorExpired = () =>
  new UnauthorizedError(
    "auth.two_factor_expired",
    "Waktu untuk memasukkan kode sudah habis atau kode salah terlalu sering. Masuk lagi dengan email dan kata sandi.",
  );
export const wrongPassword = () => new ValidationError([{ path: "password", message: "Kata sandi salah." }]);
export const codeWrong = (path: "code" | "backupCode") =>
  new ValidationError([
    {
      path,
      message:
        path === "code"
          ? "Kode tidak cocok. Pastikan jam di ponsel tepat, lalu coba kode yang baru."
          : "Kode cadangan tidak cocok atau sudah dipakai.",
    },
  ]);
export const twoFactorAlreadyEnabled = () =>
  new ConflictError("two_factor.already_enabled", "Verifikasi dua langkah sudah aktif.");
export const twoFactorNotStarted = () =>
  new ConflictError(
    "two_factor.not_started",
    "Mulai lagi dari langkah pertama: masukkan kata sandi untuk membuat kode QR.",
  );
export const sessionIsCurrent = () =>
  new ConflictError("session.current", "Ini perangkat yang sedang Anda pakai. Gunakan Keluar untuk mengakhirinya.");
export const sessionNotFound = () => new NotFoundError("session.not_found", "Perangkat ini sudah keluar.");
export const resetTokenInvalid = () =>
  new NotFoundError("auth.reset_token_invalid", "Tautan atur ulang kata sandi tidak berlaku lagi. Minta tautan baru.");
