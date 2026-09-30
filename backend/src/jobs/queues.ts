import { Queue, type QueueOptions } from "bullmq";
import type { Redis } from "ioredis";

/** Queues from technology doc 7.1. Names are constants, not configuration. */
export const QUEUES = [
  "order.ingest",
  "stock.push",
  "mp.outbound",
  "mp.poll",
  "pdf",
  "notify",
  "ai",
  "research",
  "settlement",
] as const;
export type QueueName = (typeof QUEUES)[number];

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
    private readonly prefix = "bull",
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
