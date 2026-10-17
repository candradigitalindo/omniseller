import type { Redis } from "ioredis";

// State is shared by workers; an endpoint cooldown must survive process restarts.
const TAKE = `
local now=tonumber(ARGV[1]); local capacity=tonumber(ARGV[2]); local refill=tonumber(ARGV[3])
local s=redis.call('HMGET',KEYS[1],'tokens','ts','scale','blocked')
local scale=tonumber(s[3]) or 1; local burst=math.max(1,capacity*scale)
local tokens=math.min(burst,(tonumber(s[1]) or burst)+math.max(0,now-(tonumber(s[2]) or now))*refill*scale/1000)
local wait=math.max(0,(tonumber(s[4]) or 0)-now)
if wait==0 and tokens<1 then wait=math.ceil((1-tokens)*1000/(refill*scale)) end
local allowed=0; if wait==0 then allowed=1;tokens=tokens-1 end
redis.call('HSET',KEYS[1],'tokens',tokens,'ts',now,'scale',scale)
redis.call('PEXPIRE',KEYS[1],math.max(86400000,wait+86400000))
return {allowed,wait,tostring(scale)}
`;
const FEEDBACK = `
local now=tonumber(ARGV[1]);local throttled=tonumber(ARGV[2]);local minimum=tonumber(ARGV[3]);local jitter=tonumber(ARGV[4])
local s=redis.call('HMGET',KEYS[1],'scale','last_throttle','last_recovery','failures','blocked')
local scale=tonumber(s[1]) or 1;local last=tonumber(s[2]) or 0;local recovery=tonumber(s[3]) or 0
local failures=tonumber(s[4]) or 0;local blocked=tonumber(s[5]) or 0
if throttled==1 then
 failures=math.min(7,failures+1);scale=math.max(0.1,scale/2)
 blocked=math.max(blocked,now+math.max(minimum,math.min(60000,1000*2^(failures-1)+jitter)))
 redis.call('HSET',KEYS[1],'scale',scale,'last_throttle',now,'failures',failures,'blocked',blocked,'tokens',0,'ts',now)
elseif now-last>=600000 and now-recovery>=600000 and blocked<=now then
 scale=math.min(1,scale*1.2);failures=math.max(0,failures-1)
 redis.call('HSET',KEYS[1],'scale',scale,'last_recovery',now,'failures',failures)
end
redis.call('PEXPIRE',KEYS[1],math.max(86400000,blocked-now+86400000))
return {math.max(0,blocked-now),tostring(scale)}
`;

/** Local adaptive dispatch targets, never claims about a platform's granted QPS. */
export class MarketplaceLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "mp-adaptive",
  ) {}
  async take(key: string, rule: { capacity: number; refillPerSecond: number }, now = Date.now()) {
    const [allowed, retryAfterMs, scale] = (await this.redis.eval(
      TAKE,
      1,
      `${this.prefix}:${key}`,
      now,
      rule.capacity,
      rule.refillPerSecond,
    )) as [number, number, string];
    return { allowed: allowed === 1, retryAfterMs, scale: Number(scale) };
  }
  async feedback(
    key: string,
    throttled: boolean,
    retryAfterMs = 0,
    now = Date.now(),
    jitter = Math.floor(Math.random() * 501),
  ) {
    const minimum = Number.isFinite(retryAfterMs) ? Math.max(0, Math.ceil(retryAfterMs)) : 0;
    await this.redis.eval(FEEDBACK, 1, `${this.prefix}:${key}`, now, throttled ? 1 : 0, minimum, jitter);
  }
}
