/**
 * Domain error hierarchy (backend doc 8.7). Domain code throws these, never `new Error("...")`.
 * `code` is a stable machine key (`<area>.<reason>`); `detail` is safe to show to the user.
 */
export interface FieldIssue {
  path: string;
  message: string;
}

export abstract class DomainError extends Error {
  abstract readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly errors: FieldIssue[] | undefined;
  /** Extra Problem Details members (RFC 9457 extensions), for example the tenants to choose from. */
  readonly extensions: Record<string, unknown> | undefined;

  constructor(code: string, detail?: string, errors?: FieldIssue[], extensions?: Record<string, unknown>) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = new.target.name;
    this.code = code;
    this.detail = detail;
    this.errors = errors;
    this.extensions = extensions;
  }
}

export class ValidationError extends DomainError {
  readonly status = 422;
  constructor(errors: FieldIssue[], detail = "Periksa kembali isian yang ditandai.") {
    super("validation.failed", detail, errors);
  }
}

export class UnauthorizedError extends DomainError {
  readonly status = 401;
}

export class ForbiddenError extends DomainError {
  readonly status = 403;
}

export class NotFoundError extends DomainError {
  readonly status = 404;
}

export class ConflictError extends DomainError {
  readonly status = 409;
}

export class PreconditionError extends DomainError {
  readonly status = 412;
}

export class RateLimitedError extends DomainError {
  readonly status = 429;
  constructor(readonly retryAfterSeconds: number) {
    super("rate.limited", "Terlalu banyak percobaan. Coba lagi sebentar lagi.");
  }
}

export class ExternalServiceError extends DomainError {
  readonly status = 502;
}

export class InternalError extends DomainError {
  readonly status = 500;
}

/** Thrown by withTenantTx when a transaction for another tenant is opened inside one already running. */
export class CrossTenantTxError extends InternalError {
  constructor(outer: string, inner: string) {
    super("internal.cross_tenant_tx", `transaction for tenant ${inner} opened inside tenant ${outer}`);
  }
}
