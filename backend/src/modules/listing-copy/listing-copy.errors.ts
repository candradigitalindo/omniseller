import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from "../../common/errors/domain-errors";

export const copyNotFound = () => new NotFoundError("listing_copy.not_found", "Salinan listing tidak ditemukan.");
export const draftNotFound = () => new NotFoundError("listing_draft.not_found", "Draf listing tidak ditemukan.");
export const categoryNotFound = () =>
  new NotFoundError("channel_category.not_found", "Kategori tidak ditemukan di toko ini. Muat ulang daftar kategori.");
export const sameStore = () =>
  new ValidationError([{ path: "targetStoreIds", message: "Toko tujuan harus berbeda dari toko asal." }]);
export const listingsOfAnotherStore = () =>
  new ValidationError([{ path: "listingIds", message: "Semua listing harus dari toko asal yang dipilih." }]);
export const copyNotPreparing = () =>
  new ConflictError("listing_copy.finished", "Salinan ini sudah selesai disiapkan.");
export const draftNotEditable = (status: string) =>
  new ConflictError(
    "listing_draft.not_editable",
    status === "published"
      ? "Draf ini sudah diterbitkan; ubah produknya langsung di marketplace."
      : "Draf ini sedang diproses. Tunggu sampai selesai.",
  );
export const draftStale = () =>
  new ConflictError("row.stale", "Draf sudah diubah orang lain. Muat ulang lalu coba lagi.");
export const attributeNotInCategory = (path: string) =>
  new ValidationError([{ path, message: "Atribut ini tidak ada di kategori draf." }]);
export const variantKeyUnknown = (path: string) =>
  new ValidationError([{ path, message: "Varian ini tidak ada di draf." }]);
export const variationsFixed = () =>
  new ValidationError([
    { path: "variationNames", message: "Nama variasi bisa diganti, tetapi jumlah variasinya tidak bisa diubah." },
  ]);
export const imageNotInDraft = (path: string) =>
  new ValidationError([
    { path, message: "Foto ini tidak ada di draf; hanya urutan dan penghapusan foto yang bisa diubah." },
  ]);
export const categoryUnusable = (message: string) => new UnprocessableError("channel_category.unusable", message);
