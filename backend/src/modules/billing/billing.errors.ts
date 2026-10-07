import {
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from "../../common/errors/domain-errors";

export const planNotFound = () =>
  new ValidationError([{ path: "planCode", message: "Paket tidak dikenal atau sudah tidak ditawarkan." }]);
export const samePlan = () => new ConflictError("billing.same_plan", "Bisnis ini sudah memakai paket itu.");
export const paymentsUnavailable = () =>
  new UnprocessableError(
    "billing.payments_unavailable",
    "Pembayaran belum tersedia di lingkungan ini. Hubungi tim OmniSeller untuk naik paket.",
  );
export const invoiceNotFound = () => new NotFoundError("invoice.not_found", "Tagihan tidak ditemukan.");
export const invoiceNotPending = () =>
  new ConflictError("invoice.not_pending", "Tagihan ini sudah selesai; tidak ada yang bisa dibatalkan.");
export const renewalInvoice = () =>
  new ConflictError(
    "invoice.renewal",
    "Tagihan perpanjangan tidak bisa dibatalkan. Pilih paket lain bila tidak ingin melanjutkan paket ini.",
  );
export const nextPeriodPaid = (from: string) =>
  new ConflictError(
    "billing.next_period_paid",
    `Periode berikutnya sudah dibayar. Paket bisa diubah lagi mulai ${from}.`,
  );

/** Xendit answered, but not with what was asked: its HTTP status and error code say why. */
export class XenditRefusedError extends ExternalServiceError {
  constructor(
    readonly httpStatus: number,
    readonly errorCode: string | null,
  ) {
    super("billing.gateway_error", `Xendit menjawab ${httpStatus}${errorCode ? ` (${errorCode})` : ""}.`);
  }

  /** Asking again would be refused again (4xx); a 5xx is worth a retry. */
  get permanent(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500;
  }
}

export const gatewayError = (detail: string) => new ExternalServiceError("billing.gateway_error", detail);
export const gatewayNotConfigured = () =>
  new Error("XENDIT_SECRET_KEY is not set: the worker cannot create invoices (backend doc 8.32)");
