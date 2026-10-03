import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";
import type { DirtyKey, StockDirtySet } from "../jobs/stock-dirty";

/** Marks per stock.push job: enough to batch the variants of one item into one marketplace call. */
export const STOCK_PUSH_BATCH = 50;

/**
 * stock.dirty_flush (backend doc 9.4, 9.5): every 2 seconds, enqueue stock.push for keys that have
 * been quiet for 5 seconds, in batches per tenant. Keys are sorted, so variants created together (one
 * product) usually land in one batch and one marketplace call per item. Enqueue first, acknowledge
 * second; see StockDirtySet for why that order never loses a change.
 */
export async function flushStockDirty(
  dirty: StockDirtySet,
  queues: QueueRegistry,
  registry: JobRegistry,
  nowMs = Date.now(),
  quietMs = 5000,
): Promise<number> {
  const ready = await dirty.ready(nowMs, quietMs);
  if (ready.length === 0) return 0;
  const def = registry.get("stock.push", "stock.push");
  if (!def) throw new Error("job stock.push/stock.push is not registered");

  const byTenant = new Map<string, DirtyKey[]>();
  for (const k of ready) byTenant.set(k.tenantId, [...(byTenant.get(k.tenantId) ?? []), k]);
  const jobs: { name: string; data: object; opts: object }[] = [];
  for (const [tenantId, keys] of byTenant) {
    keys.sort((a, b) => (a.variantId + a.warehouseId < b.variantId + b.warehouseId ? -1 : 1));
    for (let i = 0; i < keys.length; i += STOCK_PUSH_BATCH) {
      const marks = keys
        .slice(i, i + STOCK_PUSH_BATCH)
        .map((k) => ({ variantId: k.variantId, warehouseId: k.warehouseId, score: k.score }));
      const data = { tenantId, marks };
      jobs.push({ name: def.name, data, opts: { ...def.options, jobId: def.jobId(data, {}) } });
    }
  }
  await queues.get(def.queue).addBulk(jobs);
  for (const k of ready) await dirty.ack(k);
  return ready.length;
}
