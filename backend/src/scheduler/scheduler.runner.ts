import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import { sql } from "drizzle-orm";
import pg from "pg";
import { ENV } from "../config/config.module";
import type { EnvFor } from "../config/env.schema";
import type { DbHandle } from "../db/client";
import { withSystemTx } from "../db/tenant-tx";
import { DB_SYSTEM, JOB_REGISTRY, QUEUES, STOCK_DIRTY } from "../infra/tokens";
import type { QueueRegistry } from "../jobs/queues";
import type { JobRegistry } from "../jobs/registry";
import type { StockDirtySet } from "../jobs/stock-dirty";
import {
  ORDER_POLL_SLOT_MS,
  scanOrderPolls,
  scanTokenRefresh,
  scanWarehousePolls,
  sweepWebhookInbox,
  WAREHOUSE_POLL_SLOT_MS,
} from "./channel-scans";
import { DIGEST_SCAN_MS, scanDailyDigests } from "./digest-scan";
import {
  FILE_CLEANUP_SLOT_MS,
  SLA_ALERT_SLOT_MS,
  scanExpiredFiles,
  scanNewOrderNotices,
  scanSlaAlerts,
} from "./order-scans";
import { OutboxRelayRunner } from "./outbox-relay";
import { flushStockDirty } from "./stock-flush";
import { scanTracking, TRACKING_SCAN_MS } from "./tracking-scan";

const log = logger.forModule("scheduler");

const STOCK_FLUSH_MS = 2000;
const PARTITIONS_EVERY_MS = 6 * 3600 * 1000;
const INBOX_SWEEP_MS = 30_000;
const TOKEN_REFRESH_SCAN_MS = 15 * 60_000;

/**
 * In-process loops of the scheduler (backend doc 9.5). Runs as a single ECS task; during a
 * blue/green deploy two may overlap briefly, which is safe because every loop is idempotent
 * (SKIP LOCKED relay, deterministic job ids, CREATE ... IF NOT EXISTS partitions).
 * Per-store work (token refresh, warehouse polling) is selected here with the system role and done by
 * worker jobs with per-slot ids (backend doc 9.2).
 */
@Injectable()
export class SchedulerRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private relay: OutboxRelayRunner | undefined;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(ENV) private readonly env: EnvFor<"scheduler">,
    @Inject(DB_SYSTEM) private readonly system: DbHandle,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(STOCK_DIRTY) private readonly dirty: StockDirtySet,
    @Inject(JOB_REGISTRY) private readonly registry: JobRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.relay = new OutboxRelayRunner(this.system, this.queues, new pg.Client(this.env.DATABASE_URL_SYSTEM));
    await this.relay.start();

    this.every(STOCK_FLUSH_MS, "stock.dirty_flush", () => flushStockDirty(this.dirty, this.queues, this.registry));
    await this.maintainPartitions();
    this.every(PARTITIONS_EVERY_MS, "partition.maintain", () => this.maintainPartitions());
    this.every(INBOX_SWEEP_MS, "webhook.inbox_sweep", () => sweepWebhookInbox(this.system, this.queues, this.registry));
    this.every(TOKEN_REFRESH_SCAN_MS, "token.refresh_scan", () =>
      scanTokenRefresh(this.system, this.queues, this.registry),
    );
    this.every(ORDER_POLL_SLOT_MS, "mp.poll.orders", () => scanOrderPolls(this.system, this.queues, this.registry));
    this.every(WAREHOUSE_POLL_SLOT_MS, "mp.poll.warehouses", () =>
      scanWarehousePolls(this.system, this.queues, this.registry),
    );
    this.every(SLA_ALERT_SLOT_MS, "order.sla_scan", () => scanSlaAlerts(this.system, this.queues, this.registry));
    this.every(SLA_ALERT_SLOT_MS, "order.new_scan", () => scanNewOrderNotices(this.system, this.queues, this.registry));
    this.every(DIGEST_SCAN_MS, "digest.scan", () => scanDailyDigests(this.system, this.queues, this.registry));
    this.every(TRACKING_SCAN_MS, "shipment.tracking_scan", () => scanTracking(this.system, this.queues, this.registry));
    this.every(FILE_CLEANUP_SLOT_MS, "files.cleanup_scan", () =>
      scanExpiredFiles(this.system, this.queues, this.registry),
    );
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
