import { Controller, Get, Inject, Optional, Res } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Response } from "express";
import type { Redis } from "ioredis";
import { Public } from "../../common/http/decorators";
import type { DbHandle } from "../../db/client";
import { DB_API, REDIS_CACHE, REDIS_QUEUE } from "../../infra/tokens";

type Check = "ok" | "fail";

async function probe(fn: () => Promise<unknown>, timeoutMs = 2000): Promise<Check> {
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))]);
    return "ok";
  } catch {
    return "fail";
  }
}

/** /healthz: the process is alive. /readyz: its database and Redis are reachable (backend doc 10.1). */
@Controller()
export class HealthController {
  constructor(
    @Optional() @Inject(DB_API) private readonly db: DbHandle | undefined,
    @Inject(REDIS_QUEUE) private readonly redisQueue: Redis,
    @Inject(REDIS_CACHE) private readonly redisCache: Redis,
  ) {}

  @Get("healthz")
  @Public()
  healthz(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("readyz")
  @Public()
  async readyz(@Res({ passthrough: true }) res: Response): Promise<{ status: Check; checks: Record<string, Check> }> {
    const checks: Record<string, Check> = {
      redis_queue: await probe(() => this.redisQueue.ping()),
      redis_cache: await probe(() => this.redisCache.ping()),
    };
    if (this.db) {
      const db = this.db;
      checks.database = await probe(() => db.db.execute(sql`SELECT 1`));
    }
    const status: Check = Object.values(checks).every((c) => c === "ok") ? "ok" : "fail";
    res.status(status === "ok" ? 200 : 503);
    return { status, checks };
  }
}
