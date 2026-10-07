import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { hashToken, newSecretToken } from "./tokens";

/**
 * Web sessions (technology doc 5.3): random 256-bit token in an HttpOnly cookie, state in the cache
 * Redis, 30 days sliding, at most 10 sessions per user. Redis only ever sees the token hash.
 *
 *   sess:<sha256(token)>          JSON session, EX 30 days
 *   usess:<tenantId>:<userId>     sorted set of that user's session hashes, score = created ms
 */
export interface Session {
  tenantId: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent?: string;
  ip?: string;
}

export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
export const MAX_SESSIONS_PER_USER = 10;
/** Sliding expiry is refreshed at most this often, to keep reads from becoming writes. */
const TOUCH_EVERY_MS = 3600 * 1000;

/**
 * The id a session is shown with in "Perangkat yang masuk" (backend doc 8.30): derived from the token
 * hash, so neither the token nor its storage key ever leaves the api.
 */
export function sessionIdOf(hash: string): string {
  return createHash("sha256").update(`session:${hash}`).digest("base64url").slice(0, 22);
}

export interface ListedSession extends Session {
  id: string;
  hash: string;
}

const sessKey = (hash: string) => `sess:${hash}`;
const userKey = (tenantId: string, userId: string) => `usess:${tenantId}:${userId}`;

export class SessionStore {
  constructor(private readonly redis: Redis) {}

  /** Creates a session and returns the raw token for the cookie. Evicts the oldest beyond the limit. */
  async create(input: { tenantId: string; userId: string; userAgent?: string; ip?: string }, nowMs = Date.now()) {
    const token = newSecretToken();
    const hash = hashToken(token);
    const session: Session = { ...input, createdAt: nowMs, lastSeenAt: nowMs };
    const uk = userKey(input.tenantId, input.userId);
    await this.redis
      .multi()
      .set(sessKey(hash), JSON.stringify(session), "EX", SESSION_TTL_SECONDS)
      .zadd(uk, nowMs, hash)
      .expire(uk, SESSION_TTL_SECONDS)
      .exec();
    const count = await this.redis.zcard(uk);
    if (count > MAX_SESSIONS_PER_USER) {
      const oldest = await this.redis.zrange(uk, 0, count - MAX_SESSIONS_PER_USER - 1);
      if (oldest.length > 0) {
        await this.redis
          .multi()
          .del(...oldest.map(sessKey))
          .zrem(uk, ...oldest)
          .exec();
      }
    }
    return { token, session };
  }

  /** Resolves a cookie token. Returns undefined for unknown or expired sessions. */
  async get(token: string, nowMs = Date.now()): Promise<Session | undefined> {
    const hash = hashToken(token);
    const raw = await this.redis.get(sessKey(hash));
    if (!raw) return undefined;
    const session = JSON.parse(raw) as Session;
    if (nowMs - session.lastSeenAt > TOUCH_EVERY_MS) {
      session.lastSeenAt = nowMs;
      await this.redis.set(sessKey(hash), JSON.stringify(session), "EX", SESSION_TTL_SECONDS);
      await this.redis.expire(userKey(session.tenantId, session.userId), SESSION_TTL_SECONDS);
    }
    return session;
  }

  async revoke(token: string): Promise<void> {
    const hash = hashToken(token);
    const raw = await this.redis.get(sessKey(hash));
    await this.redis.del(sessKey(hash));
    if (raw) {
      const s = JSON.parse(raw) as Session;
      await this.redis.zrem(userKey(s.tenantId, s.userId), hash);
    }
  }

  /** A user's sessions, oldest first. Sessions that expired on their own are dropped from the index. */
  async list(tenantId: string, userId: string): Promise<ListedSession[]> {
    const uk = userKey(tenantId, userId);
    const hashes = await this.redis.zrange(uk, 0, -1);
    if (hashes.length === 0) return [];
    const raws = await this.redis.mget(...hashes.map(sessKey));
    const gone = hashes.filter((_, i) => !raws[i]);
    if (gone.length > 0) await this.redis.zrem(uk, ...gone);
    return hashes.flatMap((hash, i) => {
      const raw = raws[i];
      return raw ? [{ ...(JSON.parse(raw) as Session), id: sessionIdOf(hash), hash }] : [];
    });
  }

  /** Signs one session of the user out by its listed id. False when there is no such session. */
  async revokeById(tenantId: string, userId: string, id: string): Promise<boolean> {
    const uk = userKey(tenantId, userId);
    const hash = (await this.redis.zrange(uk, 0, -1)).find((h) => sessionIdOf(h) === id);
    if (!hash) return false;
    const results = await this.redis.multi().del(sessKey(hash)).zrem(uk, hash).exec();
    return Number(results?.[0]?.[1] ?? 0) > 0;
  }

  /** Signs a user out everywhere (disabled account, password change), optionally keeping one session. */
  async revokeAll(tenantId: string, userId: string, keepToken?: string): Promise<number> {
    const uk = userKey(tenantId, userId);
    const keep = keepToken ? hashToken(keepToken) : undefined;
    const hashes = (await this.redis.zrange(uk, 0, -1)).filter((h) => h !== keep);
    if (hashes.length === 0) return 0;
    await this.redis
      .multi()
      .del(...hashes.map(sessKey))
      .zrem(uk, ...hashes)
      .exec();
    return hashes.length;
  }
}
