import { NotFoundError } from "../../common/errors/domain-errors";

export const documentNotFound = () => new NotFoundError("document.not_found", "Dokumen tidak ditemukan.");
