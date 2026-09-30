import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import { sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import pg from "pg";
import { ENV } from "../config/config.module";
import type { EnvFor } from "../config/env.schema";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { DB_SYSTEM, QUEUES, REDIS_QUEUE } from "../infra/tokens";
import type { QueueRegistry } from "../jobs/queues";
import { StockDirtySet } from "../jobs/stock-dirty";
import { OutboxRelayRunner } from "./outbox-relay";
import { flushStockDirty } from "./stock-flush";

const log = logger.forModule("scheduler");

const STOCK_FLUSH_MS = 2000;
const PARTITIONS_EVERY_MS = 6 * 3600 * 1000;

/**
 * In-process loops of the scheduler (backend doc 9.5). Runs as a single ECS task; during a
 * blue/green deploy two may overlap briefly, which is safe because every loop is idempotent
 * (SKIP LOCKED relay, deterministic job ids, CREATE ... IF NOT EXISTS partitions).
 * Per-store periodic jobs (polling, token refresh) arrive with their modules as BullMQ job schedulers.
 */
@Injectable()
export class SchedulerRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private relay: OutboxRelayRunner | undefined;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(ENV) private readonly env: EnvFor<"scheduler">,
    @Inject(DB_SYSTEM) private readonly system: DbHandle,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(REDIS_QUEUE) private readonly redis: Redis,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.relay = new OutboxRelayRunner(this.system, this.queues, new pg.Client(this.env.DATABASE_URL_SYSTEM));
    await this.relay.start();

    const dirty = new StockDirtySet(this.redis);
    this.every(STOCK_FLUSH_MS, "stock.dirty_flush", () => flushStockDirty(dirty, this.queues));
    await this.maintainPartitions();
    this.every(PARTITIONS_EVERY_MS, "partition.maintain", () => this.maintainPartitions());
    log.info("scheduler started");
  }

  private async maintainPartitions(): Promise<void> {
    const created = await withSystemTx(this.system, async (tx) => {
      const r = await tx.execute<{ n: number }>(sql`SELECT maintain_partitions(now()) AS n`);
      return Number(r.rows[0]?.n ?? 0);
    });
    if (created > 0) log.info({ created }, "partitions created");
  }

  private every(ms: number, name: string, fn: () => Promise<unknown>): void {
    let running = false;
    this.timers.push(
      setInterval(() => {
        if (running) return;
        running = true;
        fn()
          .catch((err) => log.error({ err, schedule: name }, "schedule failed"))
          .finally(() => {
            running = false;
          });
      }, ms),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await this.relay?.stop();
  }
}
