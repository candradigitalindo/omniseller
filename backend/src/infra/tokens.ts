/** Injection tokens for infrastructure shared across modules. */
export const DB_API = Symbol("DB_API"); // omniseller_api pool (api, webhook)
export const DB_WORKER = Symbol("DB_WORKER"); // omniseller_worker pool (worker, scheduler per-tenant jobs)
export const DB_SYSTEM = Symbol("DB_SYSTEM"); // omniseller_system pool (scheduler cross-tenant jobs)
/** The tenant-scoped pool of this process: DB_API in api/webhook, DB_WORKER elsewhere. Services inject this. */
export const DB_TENANT = Symbol("DB_TENANT");
export const SESSIONS = Symbol("SESSIONS");
export const RATE_LIMITER = Symbol("RATE_LIMITER");
export const REDIS_QUEUE = Symbol("REDIS_QUEUE");
export const REDIS_CACHE = Symbol("REDIS_CACHE");
export const QUEUES = Symbol("QUEUES");
export const JOB_REGISTRY = Symbol("JOB_REGISTRY");
export const OUTBOX = Symbol("OUTBOX");
export const TOKEN_VAULT = Symbol("TOKEN_VAULT");
/** StockDirtySet on the queue Redis: stock push debounce and per-variant push locks (backend doc 9.4). */
export const STOCK_DIRTY = Symbol("STOCK_DIRTY");
