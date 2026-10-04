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
