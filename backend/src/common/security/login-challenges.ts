import type { Redis } from "ioredis";
import { hashToken, newSecretToken } from "./tokens";

/**
 * The second step of a login with two-step verification (backend doc 8.30). Once the password is right,
 * a random 256-bit challenge stands for "this person knows the password" for 5 minutes and 5 codes;
 * the client sends it back with a code. Redis keeps only its hash.
 *
 *   mfa:<sha256(challenge)>        JSON challenge, EX 300
 *   mfa:<sha256(challenge)>:tries  wrong codes so far, same expiry
 */
export interface LoginChallenge {
  tenantId: string;
  userId: string;
  ip: string;
  userAgent?: string;
  /** A stronger password hash computed at the first step, saved once the second step passes. */
  rehash?: string;
}

export const CHALLENGE_TTL_SECONDS = 300;
export const CHALLENGE_TRIES = 5;

const key = (hash: string) => `mfa:${hash}`;

export class LoginChallenges {
  constructor(private readonly redis: Redis) {}

  async create(challenge: LoginChallenge): Promise<string> {
    const token = newSecretToken();
    await this.redis.set(key(hashToken(token)), JSON.stringify(challenge), "EX", CHALLENGE_TTL_SECONDS);
    return token;
  }

  async get(token: string): Promise<LoginChallenge | undefined> {
    const raw = await this.redis.get(key(hashToken(token)));
    return raw ? (JSON.parse(raw) as LoginChallenge) : undefined;
  }

  /** Counts a wrong code. Returns false when that was the last try: the challenge is gone. */
  async miss(token: string): Promise<boolean> {
    const k = key(hashToken(token));
    const results = await this.redis.multi().incr(`${k}:tries`).expire(`${k}:tries`, CHALLENGE_TTL_SECONDS).exec();
    const tries = Number(results?.[0]?.[1] ?? CHALLENGE_TRIES);
    if (tries < CHALLENGE_TRIES) return true;
    await this.redis.del(k, `${k}:tries`);
    return false;
  }

  /** Ends the challenge after its second step passed. False when another request ended it first. */
  async consume(token: string): Promise<boolean> {
    const k = key(hashToken(token));
    return (await this.redis.del(k, `${k}:tries`)) > 0;
  }
}
