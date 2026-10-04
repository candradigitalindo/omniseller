import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";

export const DIGEST_SCAN_MS = 15 * 60_000;
/** Local hour from which the daily operational email goes out (FR-NTF-02). */
export const DIGEST_HOUR = 7;

/**
 * `digest.scan` (every 15 minutes): active businesses whose local time is past 07:00 and that have no
 * daily email for their local date yet get a `digest.daily` job. Businesses younger than a day wait.
 */
export async function scanDailyDigests(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
): Promise<number> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ id: string; local_date: string }>(sql`
      SELECT t.id, to_char(${at} AT TIME ZONE t.timezone, 'YYYY-MM-DD') AS local_date
        FROM tenant t
       WHERE t.status = 'active'
         AND t.created_at < ${at} - interval '1 day'
         AND extract(hour FROM ${at} AT TIME ZONE t.timezone) >= ${DIGEST_HOUR}
         AND NOT EXISTS (SELECT 1 FROM daily_digest d
                          WHERE d.tenant_id = t.id AND d.digest_date = (${at} AT TIME ZONE t.timezone)::date)
       LIMIT 2000`);
    return r.rows;
  });
  const def = registry.get("notify", "digest.daily");
  if (!def) throw new Error("job notify/digest.daily is not registered");
  for (const r of rows) {
    await queues
      .get(def.queue)
      .add(
        def.name,
        { tenantId: r.id, date: r.local_date },
        { ...def.options, jobId: jobKey("digest.daily", r.id, r.local_date) },
      );
  }
  return rows.length;
}
