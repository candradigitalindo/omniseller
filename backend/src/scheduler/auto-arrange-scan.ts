import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";
import { SCHEDULE_LEASE_MS } from "../modules/automation/schedule.repository";
import { OF_ACTIVE_TENANT } from "./active-tenants";

/** How often orders waiting for their rule's time of day are looked for (backend doc 8.37). */
export const AUTO_ARRANGE_SCAN_MS = 60_000;

/**
 * `order.auto_arrange_scan` (every minute): businesses with orders whose rule arranges the shipment at a
 * time of day that has come get an `order.auto_arrange` job, one id per business per minute. The job
 * carries the scan's moment, so it arranges only what was due then, never a row of the next minute.
 */
export async function scanAutoArranges(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
): Promise<number> {
  const lease = new Date(now.getTime() - SCHEDULE_LEASE_MS);
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ tenant_id: string }>(sql`
      SELECT DISTINCT tenant_id FROM order_rule_schedule
       WHERE due_at <= ${now} AND (claimed_at IS NULL OR claimed_at <= ${lease}) AND ${OF_ACTIVE_TENANT}
       LIMIT 2000`);
    return r.rows;
  });
  const def = registry.get("order.ingest", "order.auto_arrange");
  if (!def) throw new Error("job order.ingest/order.auto_arrange is not registered");
  const slot = `m${Math.floor(now.getTime() / AUTO_ARRANGE_SCAN_MS)}`;
  for (const r of rows) {
    const payload = { tenantId: r.tenant_id, slot, until: now.toISOString() };
    await queues.get(def.queue).add(def.name, payload, {
      ...def.options,
      jobId: jobKey("order.auto_arrange", r.tenant_id, slot),
    });
  }
  return rows.length;
}
