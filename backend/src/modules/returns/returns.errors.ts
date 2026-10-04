import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from "../../common/errors/domain-errors";
import type { Problem } from "./return-plan";

export const returnNotFound = () => new NotFoundError("return.not_found", "Pengajuan retur tidak ditemukan.");
export const returnIsRto = () =>
  new UnprocessableError(
    "return.not_marketplace",
    "Paket kembali (RTO) tidak perlu ditanggapi; catat penerimaannya saja.",
  );
export const returnResponsePending = () =>
  new ConflictError("return.response_pending", "Tanggapan sebelumnya masih dikirim ke marketplace.");
export const returnDecisionsStale = () =>
  new ConflictError(
    "return.decisions_stale",
    "Pilihan keputusan sedang diperbarui dari marketplace. Coba lagi dalam beberapa saat.",
  );
export const returnNothingToDecide = () =>
  new ConflictError("return.nothing_to_decide", "Pengajuan ini tidak menunggu keputusan penjual.");
export const returnStoreReadOnly = () =>
  new ConflictError(
    "store.read_only",
    "Toko masih mode baca saja. Tanggapi pengajuan ini di aplikasi lama atau di seller center.",
  );
export const returnAlreadyReceived = () =>
  new ConflictError("return.already_received", "Penerimaan barang retur ini sudah dicatat.");
export const returnNoGoods = () =>
  new UnprocessableError("return.no_goods", "Pengajuan ini tidak mengirim barang kembali ke gudang Anda.");
export const returnEvidenceLimit = (max: number) =>
  new ConflictError("return.evidence_limit", `Paling banyak ${max} foto per pengajuan.`);
export const returnEvidenceInvalid = () =>
  new ValidationError([{ path: "content", message: "Foto harus berkas JPEG atau PNG, paling besar 5 MB." }]);
export const returnWarehouseRequired = () =>
  new ValidationError([{ path: "warehouseId", message: "Pilih gudang yang menerima barang retur." }]);
export const returnWarehouseNotFound = () =>
  new ValidationError([{ path: "warehouseId", message: "Gudang tidak ditemukan atau di luar cakupan Anda." }]);
export const returnProblems = (problems: Problem[]) => new ValidationError(problems);
