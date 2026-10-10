import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from "../../common/errors/domain-errors";

export const orderNotFound = () => new NotFoundError("order.not_found", "Pesanan tidak ditemukan.");
export const problemNotFound = () =>
  new NotFoundError("order_problem.not_found", "Masalah pesanan tidak ditemukan atau sudah selesai.");
export const orderNotCancellable = (readOnly: boolean) =>
  new ConflictError(
    "order.not_cancellable",
    readOnly
      ? "Toko masih mode baca saja. Batalkan pesanan ini di aplikasi lama atau di seller center."
      : "Pesanan ini tidak bisa dibatalkan penjual pada status sekarang.",
  );
export const cancelReasonInvalid = (allowed: string[]) =>
  new ValidationError([
    {
      path: "reason",
      message: allowed.length
        ? `Alasan tidak berlaku untuk pesanan ini. Pilih salah satu: ${allowed.join(", ")}.`
        : "Pesanan ini tidak bisa dibatalkan penjual pada status sekarang.",
    },
  ]);

// ---- manual orders, warehouses, tags (backend doc 8.21) ----

export const orderStoreReadOnly = () =>
  new ConflictError(
    "store.read_only",
    "Toko masih mode baca saja. Proses pesanan ini di aplikasi lama sampai sinkron diaktifkan.",
  );
export const notManual = () =>
  new UnprocessableError(
    "order.not_manual",
    "Aksi ini hanya untuk pesanan manual. Pesanan marketplace diproses di sana.",
  );
export const orderStatusInvalid = (current: string, allowed: string) =>
  new ConflictError("order.status_invalid", `Pesanan berstatus ${current}; aksi ini untuk pesanan ${allowed}.`);
export const orderUnpaid = () =>
  new ConflictError("order.unpaid", "Pesanan belum dibayar. Tandai dibayar dulu, atau pilih bayar di tempat (COD).");
export const orderHasProblems = () => new ConflictError("order.has_problems", "Selesaikan masalah pesanan ini dulu.");
export const orderWithoutAddress = () =>
  new ConflictError(
    "order.no_address",
    "Pesanan ini tanpa alamat kirim. Isi alamatnya dulu, atau tandai selesai saat barang diambil pembeli.",
  );
export const warehouseFixedByMarketplace = () =>
  new ConflictError(
    "order.warehouse_fixed",
    "Gudang pesanan ini ditetapkan marketplace dan tidak bisa dipindah. Tambah stok di gudang itu, atau batalkan pesanan.",
  );
export const recipientPhoneMissing = () =>
  new ValidationError([{ path: "shippingAddress.phone", message: "Isi nomor telepon penerima untuk kurir." }]);
export const variantUnavailable = (path: string) =>
  new ValidationError([{ path, message: "Varian tidak ditemukan atau sudah diarsipkan." }]);
export const orderWarehouseNotFound = (path: string) =>
  new ValidationError([{ path, message: "Gudang tidak ditemukan, tidak aktif, atau di luar cakupan Anda." }]);
export const noWarehouse = () =>
  new UnprocessableError("order.no_warehouse", "Belum ada gudang aktif yang bisa melayani pesanan ini.");
export const discountTooLarge = () =>
  new ValidationError([{ path: "discount", message: "Diskon tidak boleh melebihi subtotal barang." }]);
export const tagNotFound = () => new NotFoundError("tag.not_found", "Tag tidak ditemukan.");
export const tagDuplicate = () => new ConflictError("tag.duplicate", "Sudah ada tag dengan nama ini.");
export const tagLimit = (max: number) =>
  new UnprocessableError("tag.limit", `Paling banyak ${max} tag. Hapus tag yang tidak dipakai dulu.`);
export const tagsUnknown = (path: string) => new ValidationError([{ path, message: "Tag tidak ditemukan." }]);
export const buyerDataAnonymized = () =>
  new ConflictError(
    "order.buyer_anonymized",
    "Data pembeli pesanan ini sudah dianonimkan sesuai masa simpan data pembeli dan tidak bisa diisi lagi.",
  );
