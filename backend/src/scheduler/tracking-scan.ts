import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";

export const TRACKING_SCAN_MS = 30 * 60_000;
/** Orders per `shipment.tracking_pull` job. */
export const TRACKING_BATCH = 50;
const MAX_ORDERS = 2000;

/**
 * `shipment.tracking_scan` (every 30 minutes, backend doc 8.22): marketplace orders still on their way
 * (shipped or returning, status changed in the last 30 days) whose parcel was read more than 3 hours ago
 * or never, and orders delivered or completed in the last 3 days whose tracked parcel was not read since
 * then (the last events). One `shipment.tracking_pull` job per 50 orders of a tenant. Manual sales
 * channels, stores that are not connected, and orders fulfilled by the marketplace are left out.
 */
export async function scanTracking(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
): Promise<number> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ tenant_id: string; order_id: string }>(sql`
      SELECT o.tenant_id, o.id AS order_id
        FROM "order" o
        JOIN store s ON s.tenant_id = o.tenant_id AND s.id = o.store_id
        LEFT JOIN shipment sh ON sh.tenant_id = o.tenant_id AND sh.order_id = o.id AND sh.status <> 'cancelled'
       WHERE o.fulfillment_mode = 'seller'
         AND s.channel <> 'manual' AND s.status IN ('active', 'token_expiring')
         AND ((o.status IN ('shipped', 'return_in_progress')
               AND o.status_changed_at > ${at} - interval '30 days'
               AND (sh.tracking_synced_at IS NULL OR sh.tracking_synced_at < ${at} - interval '3 hours'))
           OR (o.status IN ('delivered', 'completed') AND sh.id IS NOT NULL
               AND o.status_changed_at > ${at} - interval '3 days'
               AND (sh.tracking_synced_at IS NULL OR sh.tracking_synced_at < o.status_changed_at)))
       ORDER BY sh.tracking_synced_at NULLS FIRST, o.id
       LIMIT ${MAX_ORDERS}`);
    return r.rows;
  });
  const def = registry.get("mp.track", "shipment.tracking_pull");
  if (!def) throw new Error("job mp.track/shipment.tracking_pull is not registered");
  const slot = `t${Math.floor(now.getTime() / TRACKING_SCAN_MS)}`;
  const byTenant = new Map<string, string[]>();
  for (const r of rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r.order_id]);
  for (const [tenantId, orderIds] of byTenant) {
    for (let i = 0; i < orderIds.length; i += TRACKING_BATCH) {
      await queues
        .get(def.queue)
        .add(
          def.name,
          { tenantId, orderIds: orderIds.slice(i, i + TRACKING_BATCH) },
          { ...def.options, jobId: jobKey("shipment.tracking_pull", tenantId, slot, String(i / TRACKING_BATCH)) },
        );
    }
  }
  return rows.length;
}
