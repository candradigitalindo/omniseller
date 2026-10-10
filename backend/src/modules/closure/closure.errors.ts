import { ConflictError, ValidationError } from "../../common/errors/domain-errors";

export const accountAlreadyClosing = () =>
  new ConflictError("account.closing", "Akun bisnis ini sudah ditutup. Buka kembali dulu bila ingin memakainya.");

export const accountNotClosing = () =>
  new ConflictError("account.not_closing", "Akun bisnis ini tidak sedang ditutup.");

export const businessNameMismatch = () =>
  new ValidationError([
    { path: "businessName", message: "Nama bisnis tidak sama. Ketik persis seperti di Profil bisnis." },
  ]);
