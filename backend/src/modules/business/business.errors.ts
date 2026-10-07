import { NotFoundError, UnprocessableError, ValidationError } from "../../common/errors/domain-errors";

export const businessDocumentNotFound = () =>
  new NotFoundError("business_document.not_found", "Dokumen legalitas tidak ditemukan.");

export const logoNotFound = () => new NotFoundError("business_profile.no_logo", "Bisnis ini belum punya logo.");

export const nibAndProcess = () =>
  new ValidationError([
    {
      path: "nibInProcessSince",
      message: "Isi NIB atau tandai sedang dalam proses, tidak keduanya.",
    },
  ]);

export const fileInvalid = (path: string, message: string) => new ValidationError([{ path, message }]);

export const futureDate = (path: string) =>
  new ValidationError([{ path, message: "Tanggal tidak boleh setelah hari ini." }]);

export const documentDates = () =>
  new UnprocessableError("business_document.dates", "Tanggal berlaku tidak boleh sebelum tanggal terbit.");
