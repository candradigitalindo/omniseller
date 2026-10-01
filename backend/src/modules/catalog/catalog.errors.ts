import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from "../../common/errors/domain-errors";

export const productNotFound = () => new NotFoundError("product.not_found", "Produk tidak ditemukan.");
export const variantNotFound = () => new NotFoundError("variant.not_found", "Varian tidak ditemukan.");
export const listingNotFound = () => new NotFoundError("listing.not_found", "Listing tidak ditemukan.");
export const skuTaken = (path: string, sku: string) =>
  new ConflictError("catalog.sku_taken", `SKU "${sku}" sudah dipakai produk lain.`, [
    { path, message: "SKU sudah dipakai." },
  ]);
export const barcodeTaken = (path: string, barcode: string) =>
  new ConflictError("catalog.barcode_taken", `Barcode "${barcode}" sudah dipakai varian lain.`, [
    { path, message: "Barcode sudah dipakai." },
  ]);
export const attributesInvalid = (path: string, message: string) => new ValidationError([{ path, message }]);
export const productHasListings = () =>
  new ConflictError(
    "product.has_listings",
    "Produk ini masih terhubung ke listing marketplace. Lepaskan pemetaannya dulu atau arsipkan produknya.",
  );
export const variantUnavailable = (path: string) =>
  new ValidationError([{ path, message: "Varian tidak ditemukan atau sudah diarsipkan." }]);
export const listingsNotUsable = () =>
  new UnprocessableError("listing.store_not_active", "Toko listing ini tidak terhubung. Hubungkan ulang tokonya dulu.");
export const importInvalid = (errors: { path: string; message: string }[]) =>
  new ValidationError(errors, `File berisi ${errors.length} kesalahan. Tidak ada yang diubah.`);
