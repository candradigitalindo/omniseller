import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";

/** Hourly: a period ends at a time of day, and reminders need not wait for midnight. */
export const BILLING_SCAN_MS = 60 * 60_000;

/**
 * `billing.renewal_scan` (backend doc 8.32): businesses whose live subscription ends within a week or
 * already ended get `billing.renew`, which decides by the subscription's own dates; a business without
 * any subscription row (its `tenant.created` job never ran) gets `billing.trial_start`.
 */
export async function scanBillingRenewals(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
): Promise<{ renew: number; trials: number }> {
  const { renew, trials } = await withSystemTx(system, async (tx) => {
    const renew = await tx.execute<{ tenant_id: string }>(sql`
      SELECT DISTINCT tenant_id FROM subscription
       WHERE status IN ('trialing', 'active', 'past_due')
         AND current_period_end IS NOT NULL
         AND current_period_end <= ${now.toISOString()}::timestamptz + interval '7 days'
       LIMIT 5000`);
    const trials = await tx.execute<{ tenant_id: string }>(sql`
      SELECT t.id AS tenant_id FROM tenant t
       WHERE t.status IN ('active', 'closing')
         AND NOT EXISTS (SELECT 1 FROM subscription s WHERE s.tenant_id = t.id)
       LIMIT 5000`);
    return { renew: renew.rows, trials: trials.rows };
  });
  const slot = `h${Math.floor(now.getTime() / BILLING_SCAN_MS)}`;
  const renewDef = registry.get("billing", "billing.renew");
  const trialDef = registry.get("billing", "billing.trial_start");
  if (!renewDef || !trialDef) throw new Error("billing jobs are not registered");
  for (const r of renew) {
    await queues
      .get(renewDef.queue)
      .add(
        renewDef.name,
        { tenantId: r.tenant_id, slot },
        { ...renewDef.options, jobId: jobKey(renewDef.name, r.tenant_id, slot) },
      );
  }
  for (const r of trials) {
    await queues
      .get(trialDef.queue)
      .add(
        trialDef.name,
        { tenantId: r.tenant_id, slot },
        { ...trialDef.options, jobId: jobKey(trialDef.name, r.tenant_id, slot) },
      );
  }
  return { renew: renew.length, trials: trials.length };
}
