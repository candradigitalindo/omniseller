import { setTimeout as sleep } from "node:timers/promises";
import type { DbHandle } from "./client";

export class LockNotAcquiredError extends Error {
  constructor(readonly key: string) {
    super(`advisory lock busy: ${key}`);
    this.name = "LockNotAcquiredError";
  }
}

/**
 * Runs `fn` while holding a session-level PostgreSQL advisory lock on `key` (backend doc 8.6).
 *
 * Used where a lock must span a call to a marketplace: a row lock would keep a transaction open during
 * the HTTP call, and the worker role ends sessions idle in a transaction after 10 seconds. The lock is
 * taken on a dedicated pool connection outside any transaction and always released. Waits up to
 * `waitMs` for another holder, polling, then throws LockNotAcquiredError.
 */
export async function withAdvisoryLock<T>(
  handle: DbHandle,
  key: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<T> {
  const client = await handle.pool.connect();
  let locked = false;
  try {
    const deadline = Date.now() + (opts.waitMs ?? 10_000);
    for (;;) {
      const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [
        key,
      ]);
      if (r.rows[0]?.ok) {
        locked = true;
        break;
      }
      if (Date.now() >= deadline) throw new LockNotAcquiredError(key);
      await sleep(opts.pollMs ?? 200);
    }
    return await fn();
  } finally {
    let broken = false;
    if (locked) {
      // A connection that could not unlock still holds the lock; destroy it instead of pooling it.
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => {
        broken = true;
      });
    }
    client.release(broken);
  }
}
