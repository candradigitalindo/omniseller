import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";
import { DUE_ALERT_MS } from "../modules/returns/return-plan";
import { OF_ACTIVE_TENANT } from "./active-tenants";

/** Cross-tenant scans of the returns module (backend doc 9.5, 8.26); the work happens in tenant jobs. */

export const RETURN_POLL_SLOT_MS = 10 * 60_000;
export const RETURN_NOTICE_SLOT_MS = 5 * 60_000;
export const RETURN_DUE_SLOT_MS = 15 * 60_000;

async function add(
  registry: JobRegistry,
  queues: QueueRegistry,
  queue: string,
  name: string,
  payload: object,
  jobId: string,
) {
  const def = registry.get(queue, name);
  if (!def) throw new Error(`job ${queue}/${name} is not registered`);
  await queues.get(def.queue).add(def.name, payload, { ...def.options, jobId });
}

/**
 * `mp.poll.returns` (every 10 min, FR-RET-01): an incremental return pull for every connected store,
 * read-only ones included (their requests are shown; only answering is refused). Shopee sends no return
 * push, so this is how its requests arrive; for TikTok Shop it catches missed webhooks. Manual sales
 * channels have no marketplace.
 */
export async function scanReturnPolls(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
) {
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ store_id: string; tenant_id: string }>(sql`
      SELECT id AS store_id, tenant_id FROM store
       WHERE status IN ('active', 'token_expiring') AND channel <> 'manual' ORDER BY id`);
    return r.rows;
  });
  const slot = `r${Math.floor(now.getTime() / RETURN_POLL_SLOT_MS)}`;
  for (const r of rows) {
    await add(
      registry,
      queues,
      "mp.poll",
      "return.pull",
      { storeId: r.store_id, tenantId: r.tenant_id },
      jobKey("return.pull", r.store_id, slot),
    );
  }
  return rows.length;
}

/** `return.new_scan` (every 5 min): tenants with new requests or returning parcels to announce. */
export async function scanReturnNotices(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
) {
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ tenant_id: string }>(sql`
      SELECT DISTINCT tenant_id FROM return_request WHERE notify_new AND ${OF_ACTIVE_TENANT} LIMIT 2000`);
    return r.rows;
  });
  const slot = `n${Math.floor(now.getTime() / RETURN_NOTICE_SLOT_MS)}`;
  for (const r of rows) {
    await add(
      registry,
      queues,
      "notify",
      "return.new_notice",
      { tenantId: r.tenant_id, slot },
      jobKey("return.new_notice", r.tenant_id, slot),
    );
  }
  return rows.length;
}

/** `return.due_scan` (every 15 min, FR-RET-07): tenants with a deadline within 12 hours not alerted yet. */
export async function scanReturnDue(system: DbHandle, queues: QueueRegistry, registry: JobRegistry, now = new Date()) {
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ tenant_id: string }>(sql`
      SELECT DISTINCT tenant_id FROM return_request
       WHERE due_alerted_at IS NULL AND respond_by_at IS NOT NULL AND ${OF_ACTIVE_TENANT}
         AND respond_by_at <= ${new Date(now.getTime() + DUE_ALERT_MS)}
         AND status NOT IN ('refunded', 'cancelled', 'closed')
       LIMIT 2000`);
    return r.rows;
  });
  const slot = `d${Math.floor(now.getTime() / RETURN_DUE_SLOT_MS)}`;
  for (const r of rows) {
    await add(
      registry,
      queues,
      "notify",
      "return.due_alert",
      { tenantId: r.tenant_id, slot },
      jobKey("return.due_alert", r.tenant_id, slot),
    );
  }
  return rows.length;
}
