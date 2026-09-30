import { logger } from "@omniseller/logging";
import { inArray, sql } from "drizzle-orm";
import type pg from "pg";
import type { DbHandle } from "../db/client";
import { outboxEvent } from "../db/schema";
import { withSystemTx } from "../db/tenant-tx";
import type { QueueRegistry } from "../jobs/queues";

const log = logger.forModule("outbox-relay");

interface OutboxRow extends Record<string, unknown> {
  id: string;
  queue: string;
  job_name: string;
  job_id: string;
  payload: Record<string, unknown>;
  job_options: Record<string, unknown>;
}

/**
 * Moves unpublished outbox rows to BullMQ (backend doc 7.8.8). Delivery is at least once: a crash
 * after queue.add and before the commit re-adds the job, which BullMQ drops by its job id.
 * Rows that fail to enqueue stay unpublished with attempts/last_error and are retried next round.
 */
export async function relayOnce(system: DbHandle, queues: QueueRegistry, batchSize = 500): Promise<number> {
  return withSystemTx(system, async (tx) => {
    const result = await tx.execute<OutboxRow>(sql`
      SELECT id, queue, job_name, job_id, payload, job_options
        FROM outbox_event
       WHERE published_at IS NULL
       ORDER BY id
       LIMIT ${batchSize}
       FOR UPDATE SKIP LOCKED`);
    const published: string[] = [];
    for (const row of result.rows) {
      try {
        await queues.get(row.queue).add(row.job_name, row.payload, { ...row.job_options, jobId: row.job_id });
        published.push(row.id);
      } catch (err) {
        log.warn({ err, outbox_id: row.id, queue: row.queue }, "outbox relay failed for row");
        await tx.execute(
          sql`UPDATE outbox_event SET attempts = attempts + 1, last_error = ${String(err)} WHERE id = ${row.id}`,
        );
      }
    }
    if (published.length > 0) {
      await tx.update(outboxEvent).set({ publishedAt: sql`now()` }).where(inArray(outboxEvent.id, published));
    }
    return result.rows.length;
  });
}

/**
 * Long-running relay loop for the scheduler process: wakes on NOTIFY outbox and at least every
 * second, and drains until a round finds nothing. LISTEN needs a direct connection to PostgreSQL
 * (not through RDS Proxy, which pins or drops LISTEN sessions).
 */
export class OutboxRelayRunner {
  private stopped = false;
  private wake: (() => void) | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly system: DbHandle,
    private readonly queues: QueueRegistry,
    private readonly listenClient: pg.Client,
    private readonly intervalMs = 1000,
  ) {}

  async start(): Promise<void> {
    await this.listenClient.connect();
    this.listenClient.on("notification", () => this.wake?.());
    await this.listenClient.query("LISTEN outbox");
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        while (!this.stopped && (await relayOnce(this.system, this.queues)) > 0) {
          // keep draining while there is work
        }
      } catch (err) {
        log.error({ err }, "outbox relay round failed");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.intervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
    await this.listenClient.end().catch(() => {});
  }
}
