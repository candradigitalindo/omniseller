import type { Redis } from "ioredis";
import { jobKey } from "./job-id";

/**
 * Stock push debounce (backend doc 9.4, ADR-006).
 *
 * `mark` records that (variant, warehouse) changed; re-marking moves its score forward, so a key
 * becomes ready only after it has been quiet for `quietMs`. The scheduler reads ready keys, enqueues
 * `stock.push` with an id that includes the score, then acknowledges. The ack removes the key only if
 * its score is unchanged, so a change that lands in between is never lost, and a crash before the ack
 * re-enqueues the same job id, which BullMQ drops. A later change gets a new score and a new job id,
 * so it is never mistaken for a duplicate of an earlier, already finished push.
 */
export const STOCK_DIRTY_KEY = "stock:dirty";

const ACK_IF_UNCHANGED = `
local current = redis.call('ZSCORE', KEYS[1], ARGV[1])
if current == ARGV[2] then
  return redis.call('ZREM', KEYS[1], ARGV[1])
end
return 0
`;

export interface DirtyKey {
  tenantId: string;
  variantId: string;
  warehouseId: string;
  /** score as Redis returned it; used verbatim for the conditional ack */
  score: string;
}

export class StockDirtySet {
  constructor(
    private readonly redis: Redis,
    private readonly key = STOCK_DIRTY_KEY,
  ) {}

  static member(tenantId: string, variantId: string, warehouseId: string): string {
    return `${tenantId}:${variantId}:${warehouseId}`;
  }

  async mark(tenantId: string, variantId: string, warehouseId: string, nowMs = Date.now()): Promise<void> {
    await this.redis.zadd(this.key, nowMs, StockDirtySet.member(tenantId, variantId, warehouseId));
  }

  /** Keys quiet for at least `quietMs`, oldest first. Does not remove them. */
  async ready(nowMs = Date.now(), quietMs = 5000, limit = 500): Promise<DirtyKey[]> {
    const flat = await this.redis.zrangebyscore(
      this.key,
      "-inf",
      `(${nowMs - quietMs}`,
      "WITHSCORES",
      "LIMIT",
      0,
      limit,
    );
    const out: DirtyKey[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      const [tenantId, variantId, warehouseId] = (flat[i] as string).split(":");
      if (!tenantId || !variantId || !warehouseId) continue;
      out.push({ tenantId, variantId, warehouseId, score: flat[i + 1] as string });
    }
    return out;
  }

  /** Removes the key only if it was not marked again since `ready` returned it. */
  async ack(k: DirtyKey): Promise<boolean> {
    const removed = await this.redis.eval(
      ACK_IF_UNCHANGED,
      1,
      this.key,
      StockDirtySet.member(k.tenantId, k.variantId, k.warehouseId),
      k.score,
    );
    return removed === 1;
  }

  static jobId(k: DirtyKey): string {
    return jobKey("stock.push", k.variantId, k.warehouseId, k.score);
  }
}
