import { PERMISSIONS } from "@omniseller/shared";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from "../../common/errors/domain-errors";

export const orderRuleNotFound = () => new NotFoundError("order_rule.not_found", "Aturan otomatis tidak ditemukan.");
export const orderRuleDuplicate = () =>
  new ConflictError("order_rule.duplicate", "Sudah ada aturan otomatis dengan nama itu.");
export const orderRuleLimit = (max: number) =>
  new UnprocessableError("order_rule.limit", `Paling banyak ${max} aturan otomatis. Hapus aturan yang tidak dipakai.`);
export const orderRuleNotHeld = (permission: string) =>
  new ForbiddenError(
    "order_rule.permission_not_held",
    `Aturan ini menjalankan "${PERMISSIONS[permission as keyof typeof PERMISSIONS] ?? permission}", izin yang tidak Anda miliki.`,
  );
export const orderRuleInvalid = (path: string, message: string) => new ValidationError([{ path, message }]);
export const orderRuleStale = () =>
  new ConflictError("row.stale", "Data sudah diubah orang lain. Muat ulang lalu coba lagi.");
export const orderRuleOrderInvalid = () =>
  new ValidationError([{ path: "ids", message: "Urutan harus memuat setiap aturan tepat satu kali." }]);
