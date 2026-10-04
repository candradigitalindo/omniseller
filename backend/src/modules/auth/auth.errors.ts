import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "../../common/errors/domain-errors";

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
export const resetTokenInvalid = () =>
  new NotFoundError("auth.reset_token_invalid", "Tautan atur ulang kata sandi tidak berlaku lagi. Minta tautan baru.");
