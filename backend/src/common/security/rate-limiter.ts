import type { Redis } from "ioredis";

/**
 * Token bucket in Redis, atomic via Lua (technology doc 5.2, 7.1). Used for per-tenant API limits and
 * for login / signup / password reset per IP and per email.
 */
const TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then tokens = capacity; ts = now end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * refill_per_ms)
local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) / refill_per_ms)
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refill_per_ms) + 1000)
return { allowed, math.floor(tokens), retry_ms }
`;

export interface BucketRule {
  /** Maximum burst. */
  capacity: number;
  /** Tokens refilled per window. */
  refill: number;
  windowMs: number;
}

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export const RATE_RULES = {
  /** technology doc 5.2: 600 requests per minute per tenant for the UI */
  tenantApi: { capacity: 600, refill: 600, windowMs: 60_000 },
  loginPerIp: { capacity: 20, refill: 20, windowMs: 60_000 },
  loginPerEmail: { capacity: 10, refill: 10, windowMs: 15 * 60_000 },
  signupPerIp: { capacity: 5, refill: 5, windowMs: 3600_000 },
  resetPerIp: { capacity: 5, refill: 5, windowMs: 15 * 60_000 },
  resetPerEmail: { capacity: 3, refill: 3, windowMs: 3600_000 },
} satisfies Record<string, BucketRule>;

export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "rl",
  ) {}

  async take(key: string, rule: BucketRule, cost = 1, nowMs = Date.now()): Promise<RateDecision> {
    const [allowed, remaining, retryMs] = (await this.redis.eval(
      TOKEN_BUCKET,
      1,
      `${this.prefix}:${key}`,
      rule.capacity,
      rule.refill / rule.windowMs,
      nowMs,
      cost,
    )) as [number, number, number];
    return { allowed: allowed === 1, remaining, retryAfterSeconds: Math.ceil(retryMs / 1000) };
  }
}
