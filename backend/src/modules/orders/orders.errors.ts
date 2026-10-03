import { ConflictError, NotFoundError, ValidationError } from "../../common/errors/domain-errors";

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
