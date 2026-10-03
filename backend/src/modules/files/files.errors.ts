import { NotFoundError } from "../../common/errors/domain-errors";

export const fileNotFound = () => new NotFoundError("file.not_found", "Berkas tidak ditemukan atau sudah kedaluwarsa.");
