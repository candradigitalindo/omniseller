import { sql } from "drizzle-orm";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { jobKey } from "../jobs/job-id";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";

/**
 * Cross-tenant scheduler scans of the channel and sync modules (backend doc 9.5). They only select
 * with the system role and enqueue per-store jobs; every change to tenant data happens in those jobs,
 * under the worker role and RLS.
 */

export const TOKEN_REFRESH_SLOT_MS = 15 * 60_000;
export const WAREHOUSE_POLL_SLOT_MS = 6 * 3600_000;
export const ORDER_POLL_SLOT_MS = 5 * 60_000;
/** Pushes for shops OmniSeller does not know are kept this long, in case the shop is being connected. */
const UNKNOWN_SHOP_GRACE = "15 minutes";

async function add(
  queues: QueueRegistry,
  registry: JobRegistry,
  queue: string,
  name: string,
  payload: object,
  jobId: string,
) {
  const def = registry.get(queue, name);
  if (!def) throw new Error(`job ${queue}/${name} is not registered`);
  await queues.get(def.queue).add(def.name, payload, { ...def.options, jobId });
}

/**
 * `webhook.inbox_sweep` (every 30 s): re-enqueues stored notifications whose job was never added
 * (Redis was down when they arrived), routes notifications that arrived before their store existed,
 * and closes those that still match no store after a grace period. A job id that already exists in
 * BullMQ makes the re-enqueue a no-op.
 */
export async function sweepWebhookInbox(system: DbHandle, queues: QueueRegistry, registry: JobRegistry) {
  const work = await withSystemTx(system, async (tx) => {
    const pending = await tx.execute<{ id: string; tenant_id: string }>(sql`
      UPDATE webhook_inbox SET attempts = attempts + 1
       WHERE id IN (SELECT id FROM webhook_inbox
                     WHERE processed_at IS NULL AND tenant_id IS NOT NULL AND attempts < 3
                       AND received_at < now() - interval '30 seconds'
                       AND received_at > now() - interval '1 day'
                     ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED)
      RETURNING id, tenant_id`);

    const routed = await tx.execute<{ id: string; tenant_id: string }>(sql`
      UPDATE webhook_inbox w SET tenant_id = s.tenant_id, store_id = s.id
        FROM store s
       WHERE w.processed_at IS NULL AND w.tenant_id IS NULL
         AND s.channel = w.source AND s.external_shop_id = w.external_shop_id
      RETURNING w.id, w.tenant_id`);

    const dropped = await tx.execute(sql`
      UPDATE webhook_inbox SET processed_at = now(),
             last_error = CASE WHEN external_shop_id IS NULL THEN 'no_shop' ELSE 'unknown_shop' END
       WHERE processed_at IS NULL AND tenant_id IS NULL
         AND received_at < now() - ${sql.raw(`interval '${UNKNOWN_SHOP_GRACE}'`)}`);

    return { rows: [...pending.rows, ...routed.rows], dropped: dropped.rowCount ?? 0 };
  });
  for (const r of work.rows) {
    await add(
      queues,
      registry,
      "webhook",
      "webhook.process",
      { inboxId: r.id, tenantId: r.tenant_id },
      jobKey("webhook.process", r.id),
    );
  }
  return { enqueued: work.rows.length, dropped: work.dropped };
}

/**
 * `token.refresh_scan` (every 15 min): stores whose access token is past 80% of its lifetime, and
 * stores whose authorization ends within the warning window, get a `store.token_refresh` job. One id
 * per store per 15-minute slot, so overlapping scans never queue the same work twice.
 */
export async function scanTokenRefresh(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
) {
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ store_id: string; tenant_id: string }>(sql`
      SELECT s.id AS store_id, s.tenant_id
        FROM store s JOIN store_credential c ON c.store_id = s.id
       WHERE s.status IN ('active', 'token_expiring')
         AND (c.access_expires_at IS NULL
              OR c.access_expires_at - (c.access_expires_at - coalesce(c.last_refreshed_at, c.created_at)) * 0.2 <= ${now}
              OR (s.status = 'active' AND s.authorization_expires_at <= ${now}::timestamptz + interval '14 days'))
       ORDER BY c.access_expires_at NULLS FIRST
       LIMIT 2000`);
    return r.rows;
  });
  const slot = `s${Math.floor(now.getTime() / TOKEN_REFRESH_SLOT_MS)}`;
  for (const r of rows) {
    await add(
      queues,
      registry,
      "mp.outbound",
      "store.token_refresh",
      { storeId: r.store_id, tenantId: r.tenant_id },
      jobKey("store.token_refresh", r.store_id, slot),
    );
  }
  return rows.length;
}

/**
 * `mp.poll.orders` (every 5 min): an incremental order pull for every connected store, read-only ones
 * included (parallel mode still receives orders and holds stock, FR-MIG-05). It catches what webhooks
 * missed (FR-INT-05); one id per store per 5-minute slot. Manual sales channels have no marketplace.
 */
export async function scanOrderPolls(system: DbHandle, queues: QueueRegistry, registry: JobRegistry, now = new Date()) {
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ store_id: string; tenant_id: string }>(sql`
      SELECT id AS store_id, tenant_id FROM store
       WHERE status IN ('active', 'token_expiring') AND channel <> 'manual' ORDER BY id`);
    return r.rows;
  });
  const slot = `o${Math.floor(now.getTime() / ORDER_POLL_SLOT_MS)}`;
  for (const r of rows) {
    await add(
      queues,
      registry,
      "mp.poll",
      "order.pull",
      { storeId: r.store_id, tenantId: r.tenant_id, mode: "incremental" },
      jobKey("order.pull", r.store_id, slot),
    );
  }
  return rows.length;
}

/**
 * `mp.poll.warehouses` (every 6 h): refreshes the marketplace warehouse list of every usable store,
 * re-checks per-shop webhook subscriptions (new topics reach shops connected earlier), and runs the
 * incremental listing pull (`mp.poll.products`). Manual sales channels are skipped.
 */
export async function scanWarehousePolls(
  system: DbHandle,
  queues: QueueRegistry,
  registry: JobRegistry,
  now = new Date(),
) {
  const rows = await withSystemTx(system, async (tx) => {
    const r = await tx.execute<{ store_id: string; tenant_id: string }>(sql`
      SELECT id AS store_id, tenant_id FROM store
       WHERE status IN ('active', 'token_expiring') AND channel <> 'manual' ORDER BY id`);
    return r.rows;
  });
  const slot = `p${Math.floor(now.getTime() / WAREHOUSE_POLL_SLOT_MS)}`;
  for (const r of rows) {
    const payload = { storeId: r.store_id, tenantId: r.tenant_id };
    await add(
      queues,
      registry,
      "mp.poll",
      "store.warehouses_sync",
      payload,
      jobKey("store.warehouses_sync", r.store_id, slot),
    );
    await add(
      queues,
      registry,
      "mp.outbound",
      "store.webhooks_subscribe",
      payload,
      jobKey("store.webhooks_subscribe", r.store_id, slot),
    );
    await add(
      queues,
      registry,
      "mp.poll",
      "listing.pull",
      { ...payload, mode: "incremental" },
      jobKey("listing.pull", r.store_id, slot),
    );
  }
  return rows.length;
}
