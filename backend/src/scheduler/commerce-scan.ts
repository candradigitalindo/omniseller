import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";

export const COMMERCE_CLEANUP_SCAN_MS = 15 * 60_000;

/** Only tenant routing metadata leaves the system transaction; the worker erases expired payloads. */
export async function scanCommerceCleanup(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
) {
  const rows = await withSystemTx(system, async (tx) =>
    tx.execute<{ tenant_id: string }>(sql`
      SELECT tenant_id FROM commerce_operation
       WHERE expires_at <= ${now} AND (input <> '{}'::jsonb OR result IS NOT NULL)
       ORDER BY expires_at,id LIMIT 2000`),
  );
  const tenants = [...new Set(rows.rows.map((row) => row.tenant_id))];
  const def = registry.get("mp.poll", "commerce.cleanup");
  if (!def) throw new Error("Missing commerce.cleanup job");
  const slot = `s${Math.floor(now.getTime() / COMMERCE_CLEANUP_SCAN_MS)}`;
  for (const tenantId of tenants)
    await queues.get(def.queue).add(
      def.name,
      { tenantId, slot },
      {
        ...def.options,
        jobId: jobKey(def.name, tenantId, slot),
      },
    );
  return tenants.length;
}
