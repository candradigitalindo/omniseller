import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";
import { DEFAULT_BUYER_DATA_RETENTION_MONTHS } from "../modules/business/business-plan";
import { HOLD_STATUSES } from "../modules/orders/order-plan";

/** Hourly: a business's backlog continues within the hour, and nobody waits for a nightly window. */
export const RETENTION_SCAN_MS = 60 * 60_000;

/**
 * `retention.buyer_scan` (PRD 12.1, backend doc 8.34): businesses with orders past their buyer data retention
 * that still hold the buyer's data and are no longer held for shipping get `retention.buyer_anonymize`, once
 * per hour. Every business counts, whatever its status: the promise to buyers does not lapse.
 */
export async function scanBuyerRetention(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
): Promise<number> {
  const held = sql.join(
    [...HOLD_STATUSES].map((s) => sql`${s}`),
    sql`, `,
  );
  const tenants = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ tenant_id: string }>(sql`
      SELECT t.id AS tenant_id FROM tenant t
        LEFT JOIN business_profile bp ON bp.tenant_id = t.id
       WHERE EXISTS (
         SELECT 1 FROM "order" o
          WHERE o.tenant_id = t.id AND o.buyer_anonymized_at IS NULL
            AND o.ordered_at < ${now.toISOString()}::timestamptz
                - make_interval(months => coalesce(bp.buyer_data_retention_months, ${DEFAULT_BUYER_DATA_RETENTION_MONTHS})::int)
            AND o.status NOT IN (${held}))
       LIMIT 5000`);
    return r.rows;
  });
  const def = registry.get("import", "retention.buyer_anonymize");
  if (!def) throw new Error("retention.buyer_anonymize is not registered");
  const slot = `h${Math.floor(now.getTime() / RETENTION_SCAN_MS)}`;
  for (const t of tenants) {
    await queues
      .get(def.queue)
      .add(def.name, { tenantId: t.tenant_id, slot }, { ...def.options, jobId: jobKey(def.name, t.tenant_id, slot) });
  }
  return tenants.length;
}
