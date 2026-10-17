import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";

export const AFFILIATE_ACCOUNT_SCAN_MS = 15 * 60_000;
/** Select routing metadata only; credential access and all mutations stay in worker tenant transactions. */
export async function scanAffiliateAccounts(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
) {
  const work = await withSystemTx(system, async (tx) => {
    const refresh = await tx.execute<{ id: string; tenant_id: string }>(sql`
      SELECT id, tenant_id FROM affiliate_account
       WHERE status IN ('active','verifying')
         AND tenant_id IN (SELECT id FROM tenant WHERE status='active')
         AND (status='verifying' OR access_expires_at IS NULL OR
           access_expires_at - (access_expires_at-coalesce(last_refreshed_at,created_at))*0.2 <= ${now})
       ORDER BY access_expires_at NULLS FIRST,id LIMIT 2000`);
    const cleanup = await tx.execute<{ id: string; tenant_id: string }>(sql`
      SELECT id, tenant_id FROM affiliate_authorization
       WHERE (status IN ('succeeded','failed','expired') AND grant_access_token_enc IS NOT NULL)
          OR (status IN ('pending','exchanging','verifying') AND expires_at<=${now}
              AND (claimed_at IS NULL OR claimed_at<=${now}::timestamptz-interval '5 minutes'))
       ORDER BY id LIMIT 2000`);
    return { refresh: refresh.rows, cleanup: cleanup.rows };
  });
  const slot = `s${Math.floor(now.getTime() / AFFILIATE_ACCOUNT_SCAN_MS)}`;
  for (const [name, rows, field] of [
    ["affiliate_account.refresh", work.refresh, "accountId"],
    ["affiliate_account.grant_cleanup", work.cleanup, "authorizationId"],
  ] as const) {
    const def = registry.get("mp.outbound", name);
    if (!def) throw new Error(`Missing job ${name}`);
    for (const row of rows)
      await queues.get(def.queue).add(
        def.name,
        { tenantId: row.tenant_id, [field]: row.id },
        {
          ...def.options,
          jobId: jobKey(name, row.id, slot),
        },
      );
  }
  return { refresh: work.refresh.length, cleanup: work.cleanup.length };
}
