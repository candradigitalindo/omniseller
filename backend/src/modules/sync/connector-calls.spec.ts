import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimiter } from "../../common/security/rate-limiter";

const { waits } = vi.hoisted(() => ({ waits: [] as number[] }));
vi.mock("node:timers/promises", () => ({
  setTimeout: async (ms: number) => {
    waits.push(ms);
  },
}));

import { backgroundRule, connectorRequestGate, withRequestGate } from "./connector-calls";

/** A token bucket that records what was taken and refuses the keys it is told to. */
function limiter(refuse: (key: string) => boolean = () => false) {
  const taken: { key: string; capacity: number; refill: number }[] = [];
  const fake = {
    taken,
    async take(key: string, rule: { capacity: number; refill: number; windowMs: number }) {
      taken.push({ key, capacity: rule.capacity, refill: rule.refill });
      return refuse(key)
        ? { allowed: false, remaining: 0, retryAfterSeconds: 1 }
        : { allowed: true, remaining: 1, retryAfterSeconds: 0 };
    },
  };
  return fake as typeof fake & RateLimiter;
}

const rule = { capacity: 10, refillPerSecond: 10 };

describe("per-store request gate (technology doc 7.1)", () => {
  beforeEach(() => {
    waits.length = 0;
  });

  it("takes a token from the store's bucket for every request", async () => {
    const l = limiter();
    await withRequestGate({ limiter: l, key: "mp:shopee:S", rule }, async () => {
      await connectorRequestGate();
      await connectorRequestGate();
    });
    expect(l.taken).toEqual([
      { key: "mp:shopee:S", capacity: 10, refill: 10 },
      { key: "mp:shopee:S", capacity: 10, refill: 10 },
    ]);
  });

  it("makes background work take from its own smaller share too (backend doc 8.22)", async () => {
    const l = limiter();
    await withRequestGate({ limiter: l, key: "mp:shopee:S", rule, background: true }, () => connectorRequestGate());
    expect(l.taken).toEqual([
      { key: "mp:shopee:S:background", capacity: 3, refill: 3 },
      { key: "mp:shopee:S", capacity: 10, refill: 10 },
    ]);
    expect(backgroundRule({ capacity: 2, refillPerSecond: 1 })).toEqual({ capacity: 1, refillPerSecond: 1 });
  });

  it("waits for a token, then gives up with a temporary error; background work waits longer", async () => {
    // the store's bucket is empty for everyone; the background share alone would allow the call
    const run = (background: boolean) =>
      withRequestGate(
        { limiter: limiter((key) => !key.endsWith(":background")), key: "mp:shopee:S", rule, background },
        () => connectorRequestGate(),
      );
    await expect(run(false)).rejects.toMatchObject({ kind: "transient", code: "local_rate_limit" });
    expect(waits.reduce((n, w) => n + w, 0)).toBe(30_000);
    waits.length = 0;
    await expect(run(true)).rejects.toMatchObject({ kind: "transient", code: "local_rate_limit" });
    expect(waits.reduce((n, w) => n + w, 0)).toBe(120_000);
  });
});
