import {
  ConflictError,
  type FieldIssue,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from "../../common/errors/domain-errors";

export const importNotFound = () => new NotFoundError("migration.not_found", "Impor tidak ditemukan.");
export const importBusy = () =>
  new ConflictError("migration.busy", "Berkas ini sedang divalidasi atau diimpor. Tunggu sampai selesai.");
export const importAlreadyDone = () =>
  new ConflictError("migration.already_imported", "Berkas ini sudah diimpor. Unggah berkas baru untuk impor lagi.");
export const importNotValidated = () =>
  new ConflictError("migration.not_validated", "Validasi berkas dulu sampai semua baris benar.");
export const fileUnreadable = (message: string) => new UnprocessableError("migration.file_unreadable", message);
export const fileTooLarge = () => new UnprocessableError("migration.file_too_large", "Berkas maksimal 8 MB.");
export const fileGone = () =>
  new UnprocessableError("migration.file_expired", "Berkas impor sudah dihapus setelah 30 hari. Unggah ulang.");
export const tooManyRows = (max: number) =>
  new UnprocessableError("migration.too_many_rows", `Maksimal ${max.toLocaleString("id-ID")} baris per berkas.`);
export const noDataRows = () => new UnprocessableError("migration.no_rows", "Berkas tidak berisi baris produk.");
export const mappingInvalid = (issues: FieldIssue[]) => new ValidationError(issues, "Pemetaan kolom belum lengkap.");
export const permissionMissing = (permission: string) =>
  new ForbiddenError("auth.permission_denied", `Butuh izin ${permission} untuk impor ini.`);

export const presetNotFound = () => new NotFoundError("migration_preset.not_found", "Preset pemetaan tidak ditemukan.");
export const presetNameTaken = () =>
  new ConflictError("migration_preset.name_taken", "Nama preset sudah dipakai. Pilih nama lain.");

export const cutoverNotFound = () => new NotFoundError("cutover.not_found", "Cutover tidak ditemukan.");
export const cutoverChecklistFailed = (stores: unknown[]) =>
  new ConflictError("cutover.checklist_failed", "Checklist belum terpenuhi. Selesaikan dulu, lalu pindah.", undefined, {
    stores,
  });
export const cutoverUndoExpired = () =>
  new ConflictError("cutover.undo_expired", "Cutover hanya bisa dibatalkan dalam 24 jam.");
export const cutoverAlreadyUndone = () => new ConflictError("cutover.already_undone", "Cutover ini sudah dibatalkan.");
export const oldAppNotConfirmed = () =>
  new ValidationError(
    [{ path: "oldAppRevoked", message: "Cabut dulu otorisasi aplikasi lama di Seller Center, lalu centang." }],
    "Konfirmasi pencabutan aplikasi lama dulu.",
  );
export const nothingToCutover = () =>
  new UnprocessableError("cutover.no_stores", "Tidak ada toko dalam mode uji berdampingan.");
