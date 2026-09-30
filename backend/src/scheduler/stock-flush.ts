import type { QueueRegistry } from "../jobs/queues";
import { StockDirtySet } from "../jobs/stock-dirty";

/**
 * stock.dirty_flush (backend doc 9.4, 9.5): every 2 seconds, enqueue stock.push for keys that have
 * been quiet for 5 seconds. Enqueue first, acknowledge second; see StockDirtySet for why that order
 * never loses a change.
 */
export async function flushStockDirty(
  dirty: StockDirtySet,
  queues: QueueRegistry,
  nowMs = Date.now(),
  quietMs = 5000,
): Promise<number> {
  const ready = await dirty.ready(nowMs, quietMs);
  if (ready.length === 0) return 0;
  const queue = queues.get("stock.push");
  await queue.addBulk(
    ready.map((k) => ({
      name: "stock.push",
      data: { tenantId: k.tenantId, variantId: k.variantId, warehouseId: k.warehouseId },
      opts: { jobId: StockDirtySet.jobId(k) },
    })),
  );
  for (const k of ready) await dirty.ack(k);
  return ready.length;
}
