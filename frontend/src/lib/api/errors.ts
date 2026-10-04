/** A field the api refused, as `errors[]` of its Problem Details (backend doc 8.7). */
export interface FieldIssue {
  path: string;
  message: string;
}

/** RFC 9457 Problem Details as the api answers every error, with its stable `code`. */
export interface ProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  code?: string;
  errors?: FieldIssue[];
  [extension: string]: unknown;
}

/** An answer of the api other than 2xx; `detail` is written for the user, `code` is for the program. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly errors: FieldIssue[];
  readonly problem: ProblemDetails;

  constructor(status: number, problem: ProblemDetails) {
    super(problem.detail ?? problem.title ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = problem.code ?? `http.${status}`;
    this.detail = problem.detail;
    this.errors = problem.errors ?? [];
    this.problem = problem;
  }

  /** The message of one field (`lines.0.qty`), when the api named it. */
  fieldMessage(path: string): string | undefined {
    return this.errors.find((e) => e.path === path)?.message;
  }
}

/** The network or the api is down: fetch itself threw. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("Tidak bisa terhubung ke server. Periksa koneksi lalu coba lagi.", { cause });
    this.name = "NetworkError";
  }
}

/** Turns what the api said into Problem Details, whatever shape it had. */
export function toProblem(status: number, body: unknown): ProblemDetails {
  if (body && typeof body === "object") return body as ProblemDetails;
  if (typeof body === "string" && body.trim()) return { status, title: body.trim() };
  return { status };
}

/** One sentence for a toast or a banner: what went wrong, in the user's words when the api gave them. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.detail) return error.detail;
    if (error.status === 429) return "Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.";
    if (error.status >= 500) return `Terjadi kesalahan di sistem (kode ${error.code}). Coba lagi.`;
    return error.problem.title ?? "Permintaan ditolak.";
  }
  if (error instanceof NetworkError) return error.message;
  return "Terjadi kesalahan. Coba lagi.";
}
