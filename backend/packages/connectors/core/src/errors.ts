/**
 * Connector error classes (technology doc 8.2, backend doc 8.6). Every failure a connector raises is
 * one of these, so the backend decides retry and store status without knowing marketplace codes:
 *
 * transient     network, 5xx, rate limit: retried by BullMQ, optionally after `retryAfterMs`
 * auth_expired  the access token is no longer accepted: refresh the token, then retry once
 * auth_revoked  the seller's authorization ended (revoked, expired, shop banned): the store needs
 *               the seller to authorize again; never retried
 * permanent     the request itself is wrong (bad parameter, missing scope, used code): not retried
 */
export type ConnectorErrorKind = "transient" | "auth_expired" | "auth_revoked" | "permanent";

export interface ConnectorErrorInit {
  /** Marketplace error code (`error_auth`, `105002`) or a connector code (`http_503`, `network`). */
  code: string;
  message: string;
  httpStatus?: number;
  requestId?: string;
  retryAfterMs?: number;
  /**
   * The marketplace item the failed call already created (Shopee creates an item before its variants):
   * the caller keeps it and continues from there instead of creating the item twice.
   */
  externalItemId?: string;
}

export abstract class ConnectorError extends Error {
  abstract readonly kind: ConnectorErrorKind;
  readonly code: string;
  readonly httpStatus: number | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly externalItemId: string | undefined;
  /** The marketplace's own words, without the code (shown to sellers). */
  readonly detail: string;

  constructor(init: ConnectorErrorInit) {
    super(`${init.code}: ${init.message}`);
    this.name = new.target.name;
    this.code = init.code;
    this.httpStatus = init.httpStatus;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
    this.externalItemId = init.externalItemId;
    this.detail = init.message;
  }
}

export class TransientConnectorError extends ConnectorError {
  readonly kind = "transient" as const;
}

export class AuthExpiredError extends ConnectorError {
  readonly kind = "auth_expired" as const;
}

export class AuthRevokedError extends ConnectorError {
  readonly kind = "auth_revoked" as const;
}

export class PermanentConnectorError extends ConnectorError {
  readonly kind = "permanent" as const;
}

export function isConnectorError(err: unknown): err is ConnectorError {
  return err instanceof ConnectorError;
}

export function errorOfKind(kind: ConnectorErrorKind, init: ConnectorErrorInit): ConnectorError {
  switch (kind) {
    case "transient":
      return new TransientConnectorError(init);
    case "auth_expired":
      return new AuthExpiredError(init);
    case "auth_revoked":
      return new AuthRevokedError(init);
    case "permanent":
      return new PermanentConnectorError(init);
  }
}

/** The same error, now carrying the item the marketplace already created (see `externalItemId`). */
export function withCreatedItem(err: ConnectorError, externalItemId: string): ConnectorError {
  return errorOfKind(err.kind, {
    code: err.code,
    message: err.detail,
    ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
    ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
    externalItemId,
  });
}
