import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";
import { SLA_WARNING_MS } from "../modules/orders/order-plan";

/** Cross-tenant scans of the orders and files modules (backend doc 9.5); the work happens in tenant jobs. */

export const SLA_ALERT_SLOT_MS = 5 * 60_000;
export const FILE_CLEANUP_SLOT_MS = 3600_000;

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
 * `order.sla_scan` (every 5 min, FR-SHP-10): tenants with seller orders still to ship whose ship-by
 * alert is due get an `order.sla_alert` job, one id per tenant per slot.
 */
export async function scanSlaAlerts(system: DbHandle, queues: QueueRegistry, registry: JobRegistry, now = new Date()) {
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ tenant_id: string }>(sql`
      SELECT DISTINCT tenant_id FROM "order"
       WHERE status IN ('new', 'problem', 'ready_to_pack', 'packed', 'ready_to_ship')
         AND fulfillment_mode = 'seller' AND ship_by_at IS NOT NULL
         AND ship_by_at <= ${new Date(now.getTime() + SLA_WARNING_MS)}
         AND (sla_alert_level IS NULL OR (sla_alert_level = 'warning' AND ship_by_at <= ${now}))
       LIMIT 2000`);
    return r.rows;
  });
  const slot = `a${Math.floor(now.getTime() / SLA_ALERT_SLOT_MS)}`;
  for (const r of rows) {
    await add(
      registry,
      queues,
      "notify",
      "order.sla_alert",
      { tenantId: r.tenant_id, slot },
      jobKey("order.sla_alert", r.tenant_id, slot),
    );
  }
  return rows.length;
}

/** `order.new_scan` (every 5 min, FR-NTF-01): tenants with orders waiting for the new-order digest. */
export async function scanNewOrderNotices(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
) {
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ tenant_id: string }>(sql`
      SELECT DISTINCT tenant_id FROM "order" WHERE notify_new LIMIT 2000`);
    return r.rows;
  });
  const slot = `n${Math.floor(now.getTime() / SLA_ALERT_SLOT_MS)}`;
  for (const r of rows) {
    await add(
      registry,
      queues,
      "notify",
      "order.new_notice",
      { tenantId: r.tenant_id, slot },
      jobKey("order.new_notice", r.tenant_id, slot),
    );
  }
  return rows.length;
}

/** `files.cleanup_scan` (hourly): tenants with expired labels or documents get a cleanup job. */
export async function scanExpiredFiles(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
) {
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ tenant_id: string }>(sql`
      SELECT DISTINCT tenant_id FROM file_object
       WHERE tenant_id IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= ${now}
       LIMIT 2000`);
    return r.rows;
  });
  const slot = `f${Math.floor(now.getTime() / FILE_CLEANUP_SLOT_MS)}`;
  for (const r of rows) {
    await add(
      registry,
      queues,
      "pdf",
      "files.cleanup_expired",
      { tenantId: r.tenant_id, slot },
      jobKey("files.cleanup_expired", r.tenant_id, slot),
    );
  }
  return rows.length;
}
