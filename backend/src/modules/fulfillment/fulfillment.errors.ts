import { ConflictError, NotFoundError, UnprocessableError } from "../../common/errors/domain-errors";

export const documentNotFound = () => new NotFoundError("document.not_found", "Dokumen tidak ditemukan.");
export const trackingNotShipped = () =>
  new ConflictError("tracking.not_shipped", "Pesanan ini belum dikirim, atau dikirim oleh marketplace.");
export const trackingManual = () =>
  new UnprocessableError("tracking.manual", "Pelacakan pesanan manual belum tersedia. Lacak resinya di situs kurir.");
