import { HttpException } from "@nestjs/common";
import { ZodError } from "zod";
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PreconditionError,
  UnauthorizedError,
  ValidationError,
} from "./domain-errors";

/** RFC 9457 Problem Details as returned by every endpoint (backend doc 10.3). */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  code: string;
  errors?: { path: string; message: string }[];
  [extension: string]: unknown;
}

const TYPE_BASE = "https://docs.omniseller.id/errors/";

const TITLES: Record<number, string> = {
  400: "Permintaan tidak valid",
  401: "Perlu masuk",
  403: "Tidak punya izin",
  404: "Tidak ditemukan",
  409: "Terjadi konflik",
  412: "Prasyarat belum terpenuhi",
  422: "Isian tidak valid",
  429: "Terlalu banyak permintaan",
  500: "Terjadi kesalahan di sistem",
  502: "Layanan luar sedang bermasalah",
  503: "Layanan sedang sibuk",
};

/** Codes raised by our SQL functions and triggers (drizzle/sql/10_functions.sql) as the error MESSAGE. */
const SQL_RAISE_CODES: Record<string, (detail?: string) => DomainError> = {
  STOCK_INSUFFICIENT: (d) => new ConflictError("stock.insufficient", d),
  STOCK_REASON_REQUIRED: () =>
    new ValidationError([{ path: "reason", message: "Alasan wajib diisi untuk penyesuaian stok." }]),
  STOCK_INVENTORY_MISSING: (d) => new NotFoundError("stock.inventory_missing", d),
  INVALID_STATUS_TRANSITION: (d) => new ConflictError("status.invalid_transition", d),
  // The following mean application code broke an invariant: always a 500 and a Sentry event.
  TENANT_MISMATCH: (d) => new InternalError("internal.tenant_mismatch", d),
  INVENTORY_DIRECT_WRITE_FORBIDDEN: (d) => new InternalError("internal.inventory_direct_write", d),
  AUDIT_LOG_IMMUTABLE: (d) => new InternalError("internal.audit_log_immutable", d),
};

/** Unique constraints whose violation has a business meaning. Others map to `row.duplicate`. */
const UNIQUE_CONSTRAINT_CODES: Record<string, string> = {
  store_channel_external_shop_uq: "store.already_connected",
  order_external_ref_uq: "order.duplicate",
  variant_tenant_sku_uq: "variant.sku_taken",
  variant_tenant_barcode_uq: "variant.barcode_taken",
  product_tenant_sku_uq: "product.sku_taken",
  channel_listing_external_uq: "listing.duplicate",
  warehouse_tenant_code_uq: "warehouse.code_taken",
  stock_count_open_uq: "stock_count.open_exists",
  user_tenant_email_uq: "user.email_taken",
  tenant_slug_key: "tenant.slug_taken",
};

interface PgErrorLike {
  code: string;
  message: string;
  detail?: string;
  constraint?: string;
  severity?: string;
}

/** Drizzle wraps driver errors; walk the cause chain to the PostgreSQL error. */
export function findPgError(err: unknown): PgErrorLike | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current; depth++) {
    const c = current as Partial<PgErrorLike> & { cause?: unknown };
    if (typeof c.code === "string" && /^[0-9A-Z]{5}$/.test(c.code) && typeof c.message === "string" && c.severity) {
      return c as PgErrorLike;
    }
    current = c.cause;
  }
  return undefined;
}

export function toDomainError(err: unknown): DomainError {
  if (err instanceof DomainError) return err;

  if (err instanceof ZodError) {
    return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }

  const pg = findPgError(err);
  if (pg) {
    const raised = SQL_RAISE_CODES[pg.message];
    if (raised) return raised(pg.detail);
    switch (pg.code) {
      case "23505":
        return new ConflictError(UNIQUE_CONSTRAINT_CODES[pg.constraint ?? ""] ?? "row.duplicate", pg.constraint);
      case "23503":
        return pg.message.startsWith("update or delete")
          ? new ConflictError("row.in_use", pg.constraint)
          : new PreconditionError("row.reference_missing", pg.constraint);
      case "23514":
      case "23502":
        return new ConflictError("row.constraint_failed", pg.constraint);
      case "40001":
      case "40P01":
        return new ConflictError("tx.conflict", "Data sedang diubah proses lain, coba lagi.");
      case "42501":
        return new InternalError("internal.privilege", pg.message);
      default:
        return new InternalError("internal.database", pg.code);
    }
  }

  if (err instanceof HttpException) {
    const status = err.getStatus();
    if (status === 404) return new NotFoundError("route.not_found");
    if (status === 403) return new ForbiddenError("auth.permission_denied");
    if (status === 413) return new ValidationError([], "Isi permintaan terlalu besar.");
    if (status === 401) return new UnauthorizedError("auth.required");
    if (status >= 400 && status < 500) return new ValidationError([], err.message);
  }

  return new InternalError("internal");
}

export function toProblem(err: unknown, requestId: string): Problem {
  const d = toDomainError(err);
  const problem: Problem = {
    type: `${TYPE_BASE}${d.code}`,
    title: TITLES[d.status] ?? TITLES[500]!,
    status: d.status,
    instance: requestId,
    code: d.code,
  };
  // Internal details never leave the process; they go to logs and Sentry.
  if (d.detail && d.status < 500) problem.detail = d.detail;
  if (d.errors?.length) problem.errors = d.errors;
  if (d.extensions && d.status < 500) {
    for (const [k, v] of Object.entries(d.extensions)) if (!(k in problem)) problem[k] = v;
  }
  return problem;
}
