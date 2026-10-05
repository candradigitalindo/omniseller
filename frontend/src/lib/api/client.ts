import createClient, { type Client, type Middleware } from "openapi-fetch";
import { ApiError, NetworkError, toProblem } from "./errors";
import type { paths } from "./schema";

export type Api = Client<paths>;

/** Routes that answer 401 as part of their work (a wrong password), not because the session ended. */
const OWN_401 = /^\/v1\/auth\//;

/** Called once when the api says the session is gone; the app sends the user to `/masuk`. */
let onSessionEnded: (() => void) | null = null;

export function handleSessionEnded(fn: (() => void) | null): void {
  onSessionEnded = fn;
}

const sessionWatch: Middleware = {
  onResponse({ response, schemaPath }) {
    if (response.status === 401 && !OWN_401.test(schemaPath)) onSessionEnded?.();
  },
};

/**
 * The typed client of the OmniSeller API, generated from `backend/openapi.json` (`pnpm api:types`). It
 * calls the web app's own origin: the session cookie travels by itself (ADR-039).
 */
export function createApi(options: { baseUrl?: string; fetch?: (input: Request) => Promise<Response> } = {}): Api {
  const client = createClient<paths>({
    // absolute, because `new Request("/v1/...")` has no base outside a browser page (tests)
    baseUrl: options.baseUrl ?? globalThis.location?.origin ?? "",
    credentials: "same-origin",
    // looked up per call, not when the module loads, so a test can stub the global
    fetch: options.fetch ?? ((request) => globalThis.fetch(request)),
  });
  client.use(sessionWatch);
  return client;
}

export const api = createApi();

/**
 * The data of an answer, or an ApiError with the api's Problem Details. Every query and mutation goes
 * through this, so screens only ever handle the success shape.
 */
export async function unwrap<R extends { data?: unknown; error?: unknown; response: Response }>(
  call: Promise<R>,
): Promise<NonNullable<R["data"]>> {
  let result: R;
  try {
    result = await call;
  } catch (cause) {
    throw new NetworkError(cause);
  }
  const { data, error, response } = result;
  if (!response.ok || error !== undefined) throw new ApiError(response.status, toProblem(response.status, error));
  return data as NonNullable<R["data"]>;
}

/**
 * Like `unwrap`, with the answer's `ETag` (the row version) for a later `If-Match`: a save then fails
 * instead of overwriting what someone else saved in between (backend 8.8).
 */
export async function unwrapWithEtag<R extends { data?: unknown; error?: unknown; response: Response }>(
  call: Promise<R>,
): Promise<{ data: NonNullable<R["data"]>; etag: string | null }> {
  let result: R;
  try {
    result = await call;
  } catch (cause) {
    throw new NetworkError(cause);
  }
  const { data, error, response } = result;
  if (!response.ok || error !== undefined) throw new ApiError(response.status, toProblem(response.status, error));
  return { data: data as NonNullable<R["data"]>, etag: response.headers.get("etag") };
}
