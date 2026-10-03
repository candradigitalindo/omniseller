import { ConflictError, NotFoundError, ValidationError } from "../../common/errors/domain-errors";

export const warehouseNotFound = (path: string) =>
  new ValidationError([{ path, message: "Gudang tidak ditemukan, tidak aktif, atau di luar cakupan Anda." }]);
export const variantNotFound = (path: string) =>
  new ValidationError([{ path, message: "Varian produk tidak ditemukan." }]);
export const stockInsufficient = (path: string, onHand: number) =>
  new ValidationError(
    [{ path, message: `Stok fisik tidak cukup (tercatat ${onHand}).` }],
    "Penyesuaian membuat stok fisik di bawah nol. Tidak ada yang diubah.",
  );
export const duplicateLine = (path: string) =>
  new ValidationError([{ path, message: "Varian dan gudang ini sudah ada di baris lain." }]);
export const ruleNotFound = () => new NotFoundError("stock_rule.not_found", "Aturan alokasi stok tidak ditemukan.");
export const ruleDuplicate = () =>
  new ConflictError(
    "stock_rule.duplicate",
    "Sudah ada aturan untuk toko, gudang marketplace, dan varian yang sama. Ubah aturan itu saja.",
  );
export const ruleInvalid = (path: string, message: string) => new ValidationError([{ path, message }]);
export const ordersImporting = () =>
  new ConflictError(
    "store.orders_importing",
    "Pesanan toko ini masih diimpor. Tunggu sampai selesai agar stok untuk pesanan yang belum dikirim ikut dihitung.",
  );
export const storeNotLive = () =>
  new ConflictError(
    "store.not_live",
    "Toko ini masih mode baca saja atau belum terhubung, jadi stok belum didorong ke marketplace.",
  );
