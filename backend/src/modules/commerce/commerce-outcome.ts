import { isConnectorError } from "@omniseller/connector-core";
/** A rejected API call differs from a timeout where the marketplace may already have committed. */
export function writeOutcomeUncertain(error: unknown, dispatched: boolean, acknowledged = false): boolean {
  if (!dispatched) return false;
  if (acknowledged) return true;
  if (!isConnectorError(error)) return true;
  if (/bad_response|partial_failure|response_too_large|write_outcome_unknown/.test(error.code)) return true;
  if (error.kind === "auth_expired" || error.kind === "auth_revoked" || error.kind === "permanent") return false;
  if (error.code === "local_rate_limit" || error.httpStatus === 429) return false;
  if (error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500) return false;
  return error.kind === "transient";
}
