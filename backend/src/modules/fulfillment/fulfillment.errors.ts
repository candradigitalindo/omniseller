import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from "../../common/errors/domain-errors";

export const documentNotFound = () => new NotFoundError("document.not_found", "Dokumen tidak ditemukan.");
export const trackingNotShipped = () =>
  new ConflictError("tracking.not_shipped", "Pesanan ini belum dikirim, atau dikirim oleh marketplace.");
export const trackingManual = () =>
  new UnprocessableError("tracking.manual", "Pelacakan pesanan manual belum tersedia. Lacak resinya di situs kurir.");

// ---- print agents and print jobs (FR-SHP-17, backend doc 8.24) ----

export const printAgentNotFound = () => new NotFoundError("print_agent.not_found", "Agen cetak tidak ditemukan.");
/** A print request names an agent that is gone, revoked, or outside the caller's warehouses. */
export const printAgentInvalid = (path: string) =>
  new ValidationError([{ path, message: "Agen cetak tidak ditemukan, sudah dicabut, atau di luar gudang Anda." }]);
export const printWarehouseInvalid = () =>
  new ValidationError([
    { path: "warehouseId", message: "Gudang tidak ditemukan, tidak aktif, atau di luar cakupan Anda." },
  ]);
export const printJobNotFound = () => new NotFoundError("print_job.not_found", "Pekerjaan cetak tidak ditemukan.");
export const printJobNotPending = () =>
  new ConflictError("print_job.not_pending", "Pekerjaan cetak ini sudah selesai, gagal, atau dibatalkan.");
export const printJobNotReady = () =>
  new ConflictError("print_job.not_ready", "Dokumennya masih dibuat. Coba lagi sebentar.");
export const printJobNotRetryable = () =>
  new ConflictError("print_job.not_retryable", "Hanya pekerjaan cetak yang gagal atau macet yang bisa diulang.");
export const printFileExpired = () =>
  new ConflictError("print_job.file_expired", "Berkas cetak sudah tidak tersimpan. Buat dokumennya lagi.");
export const documentNotPrintable = () =>
  new ConflictError("document.not_printable", "Dokumen ini gagal dibuat atau berkasnya sudah tidak tersimpan.");

// ---- scanning (FR-SHP-04, 05, 17) ----

export const scanNotFound = () => new NotFoundError("scan.not_found", "Nomor pesanan atau resi tidak ditemukan.");
export const scanAmbiguous = (count: number) =>
  new ConflictError(
    "scan.ambiguous",
    `Kode ini cocok dengan ${count} pesanan. Pindai resi paketnya, atau buka pesanan dari daftar.`,
  );
/** A refusal from scan-plan (label not ready, not packed, wrong courier), with its own code. */
export const scanRefused = (r: { code: string; message: string }) => new ConflictError(r.code, r.message);
export const packingMismatch = (check: {
  lines: { key: string; expected: number; scanned: number }[];
  unknown: string[];
}) =>
  new UnprocessableError(
    "packing.mismatch",
    check.unknown.length > 0
      ? "Ada barang yang bukan milik pesanan ini. Keluarkan dari paket."
      : "Jumlah barang belum cocok dengan pesanan.",
    undefined,
    { lines: check.lines.filter((l) => l.scanned !== l.expected), unknown: check.unknown },
  );

// ---- courier handover (FR-SHP-05) ----

export const handoverNotFound = () => new NotFoundError("handover.not_found", "Manifest serah terima tidak ditemukan.");
export const handoverNotOpen = () =>
  new ConflictError("handover.not_open", "Manifest ini sudah selesai atau dibatalkan.");
export const handoverNotCompleted = () =>
  new ConflictError("handover.not_completed", "Manifest dicetak setelah serah terima selesai.");
export const handoverEmpty = () => new ConflictError("handover.empty", "Belum ada paket yang dipindai.");
export const handoverItemNotFound = () =>
  new NotFoundError("handover_item.not_found", "Paket ini tidak ada di manifest.");
export const handoverElsewhere = (number: string) =>
  new ConflictError("handover.scanned_elsewhere", `Paket ini sudah dipindai di manifest ${number}.`);
export const handoverItemsInvalid = (
  items: { itemId: string; trackingNumber: string; code: string; message: string }[],
) =>
  new ConflictError(
    "handover.items_invalid",
    "Beberapa paket tidak bisa diserahkan lagi (dibatalkan atau berubah). Keluarkan dari manifest dulu.",
    undefined,
    { items },
  );
