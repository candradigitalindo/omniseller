import { ValidationError } from "../errors/domain-errors";
import type { AuthedRequest } from "./request";

/** If-Match: "<row_version>" (backend doc 8.8). Optional; malformed values are rejected. */
export function parseIfMatch(req: AuthedRequest): number | undefined {
  const raw = req.header("if-match");
  if (raw === undefined) return undefined;
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(raw.trim());
  if (!m) throw new ValidationError([{ path: "If-Match", message: 'Harus berisi row_version, contoh "3".' }]);
  return Number(m[1]);
}
