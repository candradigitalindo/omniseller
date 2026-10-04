import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from "@nestjs/common";
import { Redis } from "ioredis";
import { RateLimiter } from "../common/security/rate-limiter";
import { SessionStore } from "../common/security/session-store";
import type { Env } from "../config/env.schema";
import { createDb, type DbHandle } from "../db/client";
import { QueueRegistry } from "../jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../jobs/registry";
import { STOCK_DIRTY_KEY, StockDirtySet } from "../jobs/stock-dirty";
import { Outbox } from "../outbox/outbox";
import { REALTIME, RedisRealtime, realtimeKey } from "../realtime/realtime";
import {
  DB_API,
  DB_SYSTEM,
  DB_TENANT,
  DB_WORKER,
  JOB_REGISTRY,
  OUTBOX,
  QUEUES,
  RATE_LIMITER,
  REDIS_CACHE,
  REDIS_QUEUE,
  SESSIONS,
  STOCK_DIRTY,
} from "./tokens";

/** Closes pools and connections when the process shuts down (SIGTERM from ECS). */
@Injectable()
class InfraShutdown implements OnApplicationShutdown {
  constructor(@Inject("INFRA_CLOSERS") private readonly closers: (() => Promise<unknown>)[]) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.closers.map((close) => close()));
  }
}

/**
 * Infrastructure for one process role. Only the database roles the process is allowed to use are
 * created: api and webhook get omniseller_api, worker gets omniseller_worker, scheduler gets
 * omniseller_worker and omniseller_system.
 */
@Global()
@Module({})
export class InfraModule {
  static forEnv(env: Env, opts: { queuePrefix?: string } = {}): DynamicModule {
    const closers: (() => Promise<unknown>)[] = [];
    const providers: Provider[] = [];
    const exports: symbol[] = [
      REDIS_QUEUE,
      REDIS_CACHE,
      QUEUES,
      JOB_REGISTRY,
      OUTBOX,
      SESSIONS,
      RATE_LIMITER,
      STOCK_DIRTY,
      REALTIME,
    ];

    const addDb = (token: symbol, handle: DbHandle) => {
      closers.push(() => handle.close());
      providers.push({ provide: token, useValue: handle });
      exports.push(token);
      return handle;
    };
    let tenantDb: DbHandle | undefined;
    if ("DATABASE_URL" in env) tenantDb = addDb(DB_API, createDb("api", env.DATABASE_URL));
    if ("DATABASE_URL_WORKER" in env) {
      const worker = addDb(DB_WORKER, createDb("worker", env.DATABASE_URL_WORKER));
      tenantDb ??= worker;
    }
    if ("DATABASE_URL_SYSTEM" in env) addDb(DB_SYSTEM, createDb("system", env.DATABASE_URL_SYSTEM, { max: 4 }));
    if (tenantDb) {
      providers.push({ provide: DB_TENANT, useValue: tenantDb });
      exports.push(DB_TENANT);
    }

    // BullMQ workers need maxRetriesPerRequest: null on their connection.
    const redisQueue = new Redis(env.REDIS_QUEUE_URL, { maxRetriesPerRequest: null, lazyConnect: true });
    const redisCache = new Redis(env.REDIS_CACHE_URL, { lazyConnect: true });
    const queues = new QueueRegistry(redisQueue, opts.queuePrefix);
    const registry = new JobRegistry(JOB_DEFINITIONS);
    closers.push(
      () => queues.close(),
      () => redisQueue.quit(),
      () => redisCache.quit(),
    );

    providers.push(
      { provide: REDIS_QUEUE, useValue: redisQueue },
      { provide: REDIS_CACHE, useValue: redisCache },
      { provide: QUEUES, useValue: queues },
      // Tests run with a per-run queue prefix; the dirty set follows it so runs never share stock keys.
      {
        provide: STOCK_DIRTY,
        useValue: new StockDirtySet(
          redisQueue,
          opts.queuePrefix ? `${opts.queuePrefix}:${STOCK_DIRTY_KEY}` : STOCK_DIRTY_KEY,
        ),
      },
      { provide: JOB_REGISTRY, useValue: registry },
      { provide: OUTBOX, useValue: new Outbox(registry) },
      { provide: SESSIONS, useValue: new SessionStore(redisCache) },
      { provide: RATE_LIMITER, useValue: new RateLimiter(redisCache) },
      // Socket.IO's pub/sub runs on the cache Redis (technology doc 7.2); every process can push.
      { provide: REALTIME, useValue: new RedisRealtime(redisCache, realtimeKey(opts.queuePrefix)) },
      { provide: "INFRA_CLOSERS", useValue: closers },
      InfraShutdown,
    );

    return { module: InfraModule, providers, exports };
  }
}
