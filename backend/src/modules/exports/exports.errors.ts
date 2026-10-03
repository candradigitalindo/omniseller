import { ConflictError, ForbiddenError, NotFoundError } from "../../common/errors/domain-errors";

export const exportNotFound = () => new NotFoundError("export.not_found", "Ekspor tidak ditemukan.");
export const exportNotReady = () =>
  new ConflictError("export.not_ready", "Ekspor belum siap. Tunggu sampai statusnya Siap, lalu unduh.");
export const exportExpired = () =>
  new NotFoundError("export.expired", "Berkas ekspor sudah kedaluwarsa. Minta ekspor baru.");
export const exportScopeLimited = () =>
  new ForbiddenError(
    "export.scope_limited",
    "Ekspor penuh berisi data semua toko dan gudang, jadi hanya untuk pengguna tanpa batasan toko atau gudang.",
  );
