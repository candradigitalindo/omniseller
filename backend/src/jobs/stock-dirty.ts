import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { jobKey } from "./job-id";

/**
 * Stock push debounce (backend doc 9.4, ADR-006).
 *
 * `mark` records that (variant, warehouse) changed; re-marking moves its score forward, so a key
 * becomes ready only after it has been quiet for `quietMs`. The scheduler reads ready keys, enqueues
 * `stock.push` jobs whose ids include the scores, then acknowledges. The ack removes a key only if its
 * score is unchanged, so a change that lands in between is never lost, and a crash before the ack
 * re-enqueues the same job ids, which BullMQ drops. A later change gets a new score and so a new job
 * id, so it is never mistaken for a duplicate of an earlier, already finished push.
 *
 * The same set holds the per-variant push locks: one pusher at a time per variant, so a slower job can
 * never overwrite a newer value at the marketplace with an older one.
 */
export const STOCK_DIRTY_KEY = "stock:dirty";

const ACK_IF_UNCHANGED = `
local current = redis.call('ZSCORE', KEYS[1], ARGV[1])
if current == ARGV[2] then
  return redis.call('ZREM', KEYS[1], ARGV[1])
end
return 0
`;

const UNLOCK_IF_OWNER = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
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

export interface StockPair {
  variantId: string;
  warehouseId: string;
}

export class StockDirtySet {
  constructor(
    private readonly redis: Redis,
    readonly key = STOCK_DIRTY_KEY,
  ) {}

  static member(tenantId: string, variantId: string, warehouseId: string): string {
    return `${tenantId}:${variantId}:${warehouseId}`;
  }

  async mark(tenantId: string, variantId: string, warehouseId: string, nowMs = Date.now()): Promise<void> {
    await this.redis.zadd(this.key, nowMs, StockDirtySet.member(tenantId, variantId, warehouseId));
  }

  async markMany(tenantId: string, pairs: readonly StockPair[], nowMs = Date.now()): Promise<void> {
    for (let i = 0; i < pairs.length; i += 500) {
      const args = pairs
        .slice(i, i + 500)
        .flatMap((p) => [nowMs, StockDirtySet.member(tenantId, p.variantId, p.warehouseId)]);
      if (args.length > 0) await this.redis.zadd(this.key, ...args);
    }
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

  private lockKey(tenantId: string, variantId: string): string {
    return `${this.key}:lock:${tenantId}:${variantId}`;
  }

  /** Takes the push lock of a variant; false when another pusher holds it. */
  async tryLock(tenantId: string, variantId: string, token: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.set(this.lockKey(tenantId, variantId), token, "PX", ttlMs, "NX")) === "OK";
  }

  async unlock(tenantId: string, variantId: string, token: string): Promise<void> {
    await this.redis.eval(UNLOCK_IF_OWNER, 1, this.lockKey(tenantId, variantId), token);
  }
}

/** One debounced change, as carried by a stock.push job. */
export interface StockMark extends StockPair {
  score: string;
}

/**
 * Id of a stock.push job for a batch of marks: the same marks with the same scores always give the
 * same id (a repeated flush is dropped by BullMQ), any new score gives a new one.
 */
export function stockPushJobId(tenantId: string, marks: readonly StockMark[]): string {
  const digest = createHash("sha256")
    .update(
      marks
        .map((m) => `${m.variantId}:${m.warehouseId}:${m.score}`)
        .sort()
        .join(","),
    )
    .digest("hex")
    .slice(0, 24);
  return jobKey("stock.push", tenantId, digest);
}
