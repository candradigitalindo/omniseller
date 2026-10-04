import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from "../../common/errors/domain-errors";

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
export const warehouseMissing = () => new NotFoundError("warehouse.not_found", "Gudang tidak ditemukan.");
export const warehouseCodeTaken = () =>
  new ConflictError(
    "warehouse.code_taken",
    "Kode gudang ini sudah dipakai, termasuk oleh gudang yang sudah dihapus. Pilih kode lain.",
  );
export const warehouseIsDefault = () =>
  new ConflictError(
    "warehouse.is_default",
    "Gudang utama tidak bisa dihapus. Jadikan gudang lain sebagai gudang utama dulu.",
  );
export const warehouseHasStock = (rows: number) =>
  new ConflictError(
    "warehouse.has_stock",
    `Masih ada stok ${rows} SKU di gudang ini. Sesuaikan stoknya menjadi 0 atau pindahkan dulu.`,
  );
export const warehouseInUse = (stores: string[]) =>
  new ConflictError(
    "warehouse.in_use",
    `Gudang ini masih dipakai ${stores.join(", ")}. Ubah gudang bawaan toko atau pemetaan gudang marketplace-nya dulu.`,
  );
export const warehouseHasOrders = (orders: number) =>
  new ConflictError("warehouse.has_orders", `Masih ada ${orders} pesanan yang belum dikirim dari gudang ini.`);
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

// ---- stock counts and transfers (FR-STK-08, 09; backend doc 8.27) ----

export const rowStale = () =>
  new ConflictError("row.stale", "Data sudah diubah orang lain. Muat ulang lalu coba lagi.");
export const stockOpsProblems = (problems: { path: string; message: string }[]) => new ValidationError(problems);
export const warehouseHasOpenDocuments = (counts: number, transfers: number) =>
  new ConflictError(
    "warehouse.has_open_documents",
    `Gudang ini masih dipakai ${[
      counts > 0 ? `${counts} stok opname` : "",
      transfers > 0 ? `${transfers} transfer stok` : "",
    ]
      .filter(Boolean)
      .join(" dan ")} yang belum selesai. Selesaikan atau batalkan dulu.`,
  );
export const stockCountNotFound = () => new NotFoundError("stock_count.not_found", "Stok opname tidak ditemukan.");
export const stockCountOpenExists = (number: string) =>
  new ConflictError(
    "stock_count.open_exists",
    `Gudang ini masih punya stok opname ${number} yang belum selesai. Lanjutkan, terapkan, atau batalkan dulu.`,
  );
export const stockCountClosed = () =>
  new ConflictError("stock_count.closed", "Stok opname ini sudah diterapkan atau dibatalkan.");
export const stockCountTooLarge = (max: number) =>
  new UnprocessableError(
    "stock_count.too_large",
    `Lebih dari ${max.toLocaleString("id-ID")} SKU dalam satu opname. Hitung per rak (opname parsial).`,
  );
export const stockCountEmpty = () =>
  new UnprocessableError("stock_count.empty", "Tidak ada SKU yang cocok dengan pilihan ini.");
export const stockCountNotCounting = () =>
  new ConflictError("stock_count.not_counting", "Stok opname ini sedang ditinjau, sudah diterapkan, atau dibatalkan.");
export const stockCountNotInReview = () =>
  new ConflictError("stock_count.not_in_review", "Stok opname ini tidak sedang menunggu persetujuan.");
export const stockCountApplying = () =>
  new ConflictError("stock_count.apply_requested", "Stok opname ini sudah disetujui dan sedang diterapkan ke stok.");
export const stockCountHidden = () =>
  new ValidationError([
    { path: "filter", message: "Selisih baru terlihat setelah hitungan dikirim untuk ditinjau (opname buta)." },
  ]);
export const scanUnknown = () =>
  new ValidationError([{ path: "code", message: "Barcode atau SKU ini tidak dikenal." }]);
export const stockTransferNotFound = () =>
  new NotFoundError("stock_transfer.not_found", "Transfer stok tidak ditemukan.");
export const stockTransferNotDraft = () =>
  new ConflictError("stock_transfer.not_draft", "Transfer ini sudah dikirim atau dibatalkan.");
export const stockTransferNotSent = () =>
  new ConflictError("stock_transfer.not_sent", "Transfer ini belum dikirim, sudah diterima, atau dibatalkan.");
export const stockTransferClosed = () =>
  new ConflictError("stock_transfer.closed", "Transfer ini sudah diterima atau dibatalkan.");
export const stockTransferOriginOnly = () =>
  new ForbiddenError(
    "stock_transfer.origin_only",
    "Hanya pengguna yang memegang gudang asal yang bisa mengubah, mengirim, atau membatalkan transfer ini.",
  );
export const stockTransferDestinationOnly = () =>
  new ForbiddenError(
    "stock_transfer.destination_only",
    "Hanya pengguna yang memegang gudang tujuan yang bisa mencatat penerimaan transfer ini.",
  );
