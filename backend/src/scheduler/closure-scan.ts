import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";
import { PURGE_REMINDER_DAYS } from "../modules/closure/closure-plan";

/** Every 10 minutes: a purge that stopped for time goes on soon, and a reminder is never a day late. */
export const CLOSURE_SCAN_MS = 10 * 60_000;

/**
 * `account.closure_scan` (backend doc 8.36): businesses closing past their purge date, or already being
 * purged, get `tenant.purge` once per slot; those closing within PURGE_REMINDER_DAYS of it, not reminded
 * yet, get `account.purge_reminder`, keyed by the purge date.
 */
export async function scanAccountClosures(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
): Promise<{ purges: number; reminders: number }> {
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ tenant_id: string; kind: "purge" | "remind"; purge_after: string }>(sql`
      SELECT id AS tenant_id, 'purge' AS kind, purge_after FROM tenant
       WHERE status IN ('closing', 'closed') AND purged_at IS NULL AND purge_after <= ${now.toISOString()}::timestamptz
      UNION ALL
      SELECT id, 'remind', purge_after FROM tenant
       WHERE status = 'closing' AND purge_reminded_at IS NULL AND purge_after > ${now.toISOString()}::timestamptz
         AND purge_after - make_interval(days => ${PURGE_REMINDER_DAYS}) <= ${now.toISOString()}::timestamptz
      LIMIT 2000`);
    return r.rows;
  });
  const purge = registry.get("import", "tenant.purge");
  const remind = registry.get("notify", "account.purge_reminder");
  if (!purge || !remind) throw new Error("tenant.purge or account.purge_reminder is not registered");
  const slot = `c${Math.floor(now.getTime() / CLOSURE_SCAN_MS)}`;
  let purges = 0;
  let reminders = 0;
  for (const r of rows) {
    if (r.kind === "purge") {
      await queues
        .get(purge.queue)
        .add(
          purge.name,
          { tenantId: r.tenant_id, slot },
          { ...purge.options, jobId: jobKey(purge.name, r.tenant_id, slot) },
        );
      purges++;
    } else {
      const purgeAfter = new Date(r.purge_after);
      await queues
        .get(remind.queue)
        .add(
          remind.name,
          { tenantId: r.tenant_id, purgeAfter: purgeAfter.toISOString() },
          { ...remind.options, jobId: jobKey(remind.name, r.tenant_id, String(purgeAfter.getTime())) },
        );
      reminders++;
    }
  }
  return { purges, reminders };
}
