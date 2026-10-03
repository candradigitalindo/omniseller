import { AsyncLocalStorage } from "node:async_hooks";
import { assertUlid, type StatusSource } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import type { RequestContext } from "../common/context/request-context";
import { CrossTenantTxError, InternalError } from "../common/errors/domain-errors";
import type { DbHandle, Tx } from "./client";

interface OpenTx {
  tenantId: string;
  tx: Tx;
}

const openTx = new AsyncLocalStorage<OpenTx>();

/** A consistent read of many tables (the full data export): one snapshot, no writes. */
export interface SnapshotTxOptions {
  snapshot: true;
}

/**
 * The only way to read or write tenant data (invariant I1). Opens a transaction, sets the tenant for
 * RLS plus the actor and request id used by audit triggers, then runs `fn`.
 *
 * Nested calls for the same tenant become savepoints of the outer transaction. A nested call for a
 * different tenant is a bug and throws CrossTenantTxError. `{ snapshot: true }` opens a REPEATABLE
 * READ, READ ONLY transaction instead, so every query sees the same moment; it cannot be nested.
 */
export async function withTenantTx<T>(
  handle: DbHandle,
  ctx: RequestContext,
  fn: (tx: Tx) => Promise<T>,
  opts?: SnapshotTxOptions,
): Promise<T> {
  assertUlid(ctx.tenantId);
  if (handle.role === "system") {
    throw new InternalError("internal.system_role_in_tenant_tx", "use the api or worker pool for tenant work");
  }
  const outer = openTx.getStore();
  if (outer) {
    if (outer.tenantId !== ctx.tenantId) throw new CrossTenantTxError(outer.tenantId, ctx.tenantId);
    if (opts?.snapshot)
      throw new InternalError("internal.snapshot_tx_nested", "a snapshot transaction cannot be nested");
    return outer.tx.transaction((savepoint) =>
      openTx.run({ tenantId: ctx.tenantId, tx: savepoint }, () => fn(savepoint)),
    );
  }
  return handle.db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT
      set_config('app.tenant_id', ${ctx.tenantId}, true),
      set_config('app.actor_type', ${ctx.actor.type}, true),
      set_config('app.actor_id', ${ctx.actor.id}, true),
      set_config('app.request_id', ${ctx.requestId}, true)`);
      return openTx.run({ tenantId: ctx.tenantId, tx }, () => fn(tx));
    },
    opts?.snapshot ? { isolationLevel: "repeatable read", accessMode: "read only" } : undefined,
  );
}

/**
 * Cross-tenant work for registered scheduler jobs only (outbox relay, partitions, retention).
 * Requires a pool that logs in as omniseller_system.
 */
export async function withSystemTx<T>(handle: DbHandle, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (handle.role !== "system") {
    throw new InternalError("internal.system_tx_role", "withSystemTx needs the omniseller_system pool");
  }
  if (openTx.getStore()) {
    throw new InternalError("internal.system_tx_nested", "withSystemTx cannot run inside a tenant transaction");
  }
  return handle.db.transaction(fn);
}

/**
 * Marks status changes inside `fn` as facts reported by the marketplace, which unlocks the
 * via = 'marketplace' rows of the status transition tables (backend doc 7.9).
 */
export async function withStatusSource<T>(tx: Tx, source: StatusSource, fn: () => Promise<T>): Promise<T> {
  await tx.execute(sql`SELECT set_config('app.status_source', ${source}, true)`);
  try {
    return await fn();
  } finally {
    await tx.execute(sql`SELECT set_config('app.status_source', 'app', true)`);
  }
}
