import { AsyncLocalStorage } from "node:async_hooks";
import { newId, PERMISSION_CODES, type Permission } from "@omniseller/shared";

export type ActorType = "user" | "api_key" | "device" | "system";

/** Who is acting and within which tenant (backend doc 8.2). Services take it as their first argument. */
export interface RequestContext {
  requestId: string;
  traceId: string;
  tenantId: string;
  actor: { type: ActorType; id: string };
  permissions: ReadonlySet<string>;
  /** null means every store / warehouse of the tenant */
  storeScope: ReadonlySet<string> | null;
  warehouseScope: ReadonlySet<string> | null;
  locale: "id" | "en";
}

/**
 * A job acting for one person (the daily email, an emailed report): that person's permissions and store
 * or warehouse scope on top of the job's ids. Only what the principal says reaches the context; the system
 * context's every-permission set does not.
 */
export function userContext(
  base: Pick<RequestContext, "requestId" | "traceId" | "tenantId">,
  principal: {
    user: { id: string; locale?: "id" | "en" };
    permissions: readonly string[];
    storeScope: readonly string[] | null;
    warehouseScope: readonly string[] | null;
  },
): RequestContext {
  return {
    requestId: base.requestId,
    traceId: base.traceId,
    tenantId: base.tenantId,
    actor: { type: "user", id: principal.user.id },
    permissions: new Set(principal.permissions),
    storeScope: principal.storeScope ? new Set(principal.storeScope) : null,
    warehouseScope: principal.warehouseScope ? new Set(principal.warehouseScope) : null,
    locale: principal.user.locale ?? "id",
  };
}

/** Per-request (or per-job) ambient data used by logging and error rendering, never by services. */
export interface Ambient {
  requestId: string;
  traceId?: string;
  ctx?: RequestContext;
}

const storage = new AsyncLocalStorage<Ambient>();

export function runWithAmbient<T>(ambient: Ambient, fn: () => T): T {
  return storage.run(ambient, fn);
}

export function ambient(): Ambient | undefined {
  return storage.getStore();
}

export function attachContext(ctx: RequestContext): void {
  const store = storage.getStore();
  if (store) store.ctx = ctx;
}

/** Context for jobs and scheduler work: system actor with every permission inside one tenant. */
export function systemContext(tenantId: string, opts: { requestId?: string; traceId?: string } = {}): RequestContext {
  const requestId = opts.requestId ?? newId();
  return {
    requestId,
    traceId: opts.traceId ?? requestId,
    tenantId,
    actor: { type: "system", id: "system" },
    permissions: new Set<Permission>(PERMISSION_CODES),
    storeScope: null,
    warehouseScope: null,
    locale: "id",
  };
}

/**
 * A device acting for its business (a print agent, backend doc 8.24): no permissions and no scopes; the
 * agent routes decide what a device may touch (its own print jobs).
 */
export function deviceContext(tenantId: string, deviceId: string, opts: { requestId?: string } = {}): RequestContext {
  const requestId = opts.requestId ?? newId();
  return {
    requestId,
    traceId: requestId,
    tenantId,
    actor: { type: "device", id: deviceId },
    permissions: new Set<Permission>(),
    storeScope: null,
    warehouseScope: null,
    locale: "id",
  };
}

/** Fields that every log line carries. */
export function logFields(): Record<string, unknown> | undefined {
  const a = storage.getStore();
  if (!a) return undefined;
  return {
    request_id: a.requestId,
    trace_id: a.traceId ?? a.requestId,
    tenant_id: a.ctx?.tenantId,
    actor: a.ctx ? `${a.ctx.actor.type}:${a.ctx.actor.id}` : undefined,
  };
}
