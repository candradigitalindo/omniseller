import { Queue, type QueueOptions } from "bullmq";
import type { Redis } from "ioredis";

/** Queues from technology doc 7.1. Names are constants, not configuration. */
export const QUEUES = [
  "webhook",
  "order.ingest",
  "stock.push",
  "mp.outbound",
  "mp.poll",
  "mp.track",
  "pdf",
  "notify",
  "ai",
  "research",
  "settlement",
  "export",
  "import",
] as const;
export type QueueName = (typeof QUEUES)[number];

/** Jobs one worker process runs at once, per queue (technology doc 7.1). */
export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
  webhook: 20,
  "order.ingest": 20,
  "stock.push": 10,
  "mp.outbound": 10,
  "mp.poll": 5,
  // parcel tracking: background reads that wait for their share of each store's request rate
  "mp.track": 2,
  pdf: 4,
  notify: 20,
  ai: 5,
  research: 5,
  settlement: 2,
  // a full data export holds one snapshot transaction and a temporary directory for minutes
  export: 1,
  // validating or importing a migration file: up to 10,000 rows in one transaction
  import: 2,
};

export function isQueueName(value: string): value is QueueName {
  return (QUEUES as readonly string[]).includes(value);
}

/** Retention for finished jobs; also the window in which BullMQ rejects a duplicate job id. */
export const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** Lazily created BullMQ queues sharing one Redis connection (the queue instance, REDIS_QUEUE_URL). */
export class QueueRegistry {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    private readonly connection: Redis,
    /** Key prefix of every queue; tests use a per-run prefix so runs never see each other's jobs. */
    readonly prefix = "bull",
  ) {}

  get(name: string): Queue {
    if (!isQueueName(name)) throw new Error(`unknown queue: ${name}`);
    let q = this.queues.get(name);
    if (!q) {
      const opts: QueueOptions = {
        connection: this.connection,
        prefix: this.prefix,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      };
      q = new Queue(name, opts);
      this.queues.set(name, q);
    }
    return q;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}
