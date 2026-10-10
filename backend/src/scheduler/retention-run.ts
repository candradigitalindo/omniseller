import { logger } from "@omniseller/logging";
import { ulidLowerBound } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { RETENTION_RUN_BATCH, RETENTION_RUN_BUDGET_MS, retentionLimits } from "../modules/retention/retention-plan";

const log = logger.forModule("scheduler");

/** Hourly: each run deletes what aged in the hour, in small statements, never a nightly backlog. */
export const RETENTION_RUN_MS = 60 * 60_000;

/**
 * `retention.run` (backend doc 9.5), system role: webhooks received more than 30 days ago, and outbox events
 * published more than 7 days ago, go in batches until none is left or the budget runs out (the next hour
 * goes on). Unpublished events stay whatever their age. Counts only in the log.
 */
export async function runRetention(
  system: DbHandle,
  now = new Date(),
  budgetMs = RETENTION_RUN_BUDGET_MS,
): Promise<{ webhooks: number; events: number }> {
  const started = Date.now();
  const { webhooksBefore, eventsBefore } = retentionLimits(now);
  // outbox ids are ULIDs made when the event is written, always before it is published
  const eventIdBefore = ulidLowerBound(eventsBefore);
  const batch = async (statement: ReturnType<typeof sql>) =>
    withSystemTx(system, async (tx) => (await tx.execute(statement)).rowCount ?? 0);

  let webhooks = 0;
  for (;;) {
    const n = await batch(sql`
      DELETE FROM webhook_inbox WHERE id IN (
        SELECT id FROM webhook_inbox WHERE received_at < ${webhooksBefore.toISOString()}::timestamptz
         LIMIT ${RETENTION_RUN_BATCH})`);
    webhooks += n;
    if (n < RETENTION_RUN_BATCH || Date.now() - started > budgetMs) break;
  }
  let events = 0;
  for (;;) {
    if (Date.now() - started > budgetMs) break;
    const n = await batch(sql`
      DELETE FROM outbox_event WHERE id IN (
        SELECT id FROM outbox_event WHERE id < ${eventIdBefore} AND published_at IS NOT NULL
         LIMIT ${RETENTION_RUN_BATCH})`);
    events += n;
    if (n < RETENTION_RUN_BATCH) break;
  }
  if (webhooks > 0 || events > 0) log.info({ webhooks, events }, "retention run");
  return { webhooks, events };
}
