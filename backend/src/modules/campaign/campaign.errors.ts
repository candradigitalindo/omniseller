import { ConflictError, NotFoundError, ValidationError } from "../../common/errors/domain-errors";

export const cutoffNotFound = () => new NotFoundError("courier_cutoff.not_found", "Cut-off kurir tidak ditemukan.");
export const cutoffDuplicate = () =>
  new ConflictError("courier_cutoff.duplicate", "Gudang ini sudah punya cut-off untuk kurir itu. Ubah yang ada saja.");
export const holidayNotFound = () =>
  new NotFoundError("courier_holiday.not_found", "Hari libur kurir tidak ditemukan.");
export const holidayDuplicate = () =>
  new ConflictError("courier_holiday.duplicate", "Hari libur ini sudah dicatat untuk kurir itu.");
export const hoursNotFound = () => new NotFoundError("operating_hours.not_found", "Jam operasional tidak ditemukan.");
export const periodOverlap = (name: string) =>
  new ConflictError(
    "operating_hours.overlap",
    `Tanggalnya bertabrakan dengan periode "${name}". Satu tanggal hanya ikut satu periode khusus.`,
  );
export const warehouseInvalid = () =>
  new ValidationError([{ path: "warehouseId", message: "Gudang tidak ditemukan." }]);
export const weekInvalid = (message: string) => new ValidationError([{ path: "schedule", message }]);
export const periodDates = () =>
  new ValidationError([{ path: "to", message: "Tanggal selesai tidak boleh sebelum tanggal mulai." }]);
