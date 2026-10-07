import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";

/** Hourly: a reminder falls due at a business's local midnight, in any of Indonesia's zones. */
export const LEGAL_SCAN_MS = 60 * 60_000;

/**
 * `business.legal_scan` (hourly, backend doc 8.29): businesses with a renewal reminder due, as the stages
 * go (30 days before, 7 days before, ended), for a document's end date or an NIB's six-month deadline. The
 * UTC date gives a day of slack; the job `business.legal_alert` decides by the business's own date and
 * claims each reminder, so a candidate with nothing due yet costs one empty run.
 */
export async function scanLegalReminders(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
): Promise<number> {
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ tenant_id: string }>(sql`
      WITH d AS (SELECT (${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')::date AS today)
      SELECT tenant_id FROM business_document, d
       WHERE valid_until IS NOT NULL
         AND ((reminded_stage IS NULL AND valid_until <= today + 31)
           OR (reminded_stage = '30d' AND valid_until <= today + 8)
           OR (reminded_stage = '7d' AND valid_until <= today))
      UNION
      SELECT tenant_id FROM business_profile, d
       WHERE nib IS NULL AND nib_in_process_since IS NOT NULL
         AND ((nib_reminded_stage IS NULL AND (nib_in_process_since + interval '6 months')::date <= today + 31)
           OR (nib_reminded_stage = '30d' AND (nib_in_process_since + interval '6 months')::date <= today + 8)
           OR (nib_reminded_stage = '7d' AND (nib_in_process_since + interval '6 months')::date <= today))
      LIMIT 5000`);
    return r.rows;
  });
  const def = registry.get("notify", "business.legal_alert");
  if (!def) throw new Error("job notify/business.legal_alert is not registered");
  const slot = `h${Math.floor(now.getTime() / LEGAL_SCAN_MS)}`;
  for (const r of rows) {
    await queues
      .get(def.queue)
      .add(def.name, { tenantId: r.tenant_id, slot }, { ...def.options, jobId: jobKey(def.name, r.tenant_id, slot) });
  }
  return rows.length;
}
