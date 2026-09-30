import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { logger } from "@omniseller/logging";
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { attachContext, runWithAmbient, systemContext } from "../common/context/request-context";
import { JOB_REGISTRY, REDIS_QUEUE } from "../infra/tokens";
import type { JobDeps } from "../jobs/define";
import type { JobRegistry } from "../jobs/registry";

const log = logger.forModule("worker");

/** Starts one BullMQ Worker per queue that has registered jobs (backend doc 9.1, 9.3). */
@Injectable()
export class WorkerRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly workers: Worker[] = [];

  constructor(
    @Inject(JOB_REGISTRY) private readonly registry: JobRegistry,
    @Inject(REDIS_QUEUE) private readonly connection: Redis,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  /** Handlers resolve the services they call from the Nest container (see JobDeps). */
  protected deps(): JobDeps {
    return { resolve: (token) => this.moduleRef.get(token, { strict: false }) };
  }

  onApplicationBootstrap(): void {
    const queues = this.registry.queues();
    if (queues.length === 0) {
      log.info("no jobs registered yet; worker is idle");
      return;
    }
    for (const queue of queues) {
      const worker = new Worker(
        queue,
        async (job) => {
          const def = this.registry.get(queue, job.name);
          if (!def) throw new Error(`no handler for ${queue}/${job.name}`);
          const payload = def.schema.parse(job.data) as { tenantId?: unknown };
          const tenantId = (job.data as { tenantId?: unknown }).tenantId;
          if (typeof tenantId !== "string") throw new Error(`job ${job.id} has no tenantId`);
          const ctx = systemContext(tenantId, { requestId: job.id ?? undefined });
          return runWithAmbient({ requestId: ctx.requestId }, async () => {
            attachContext(ctx);
            await def.handler({ ...(payload as object), tenantId } as never, {
              ctx,
              jobId: job.id ?? "",
              attemptsMade: job.attemptsMade,
              deps: this.deps(),
            });
          });
        },
        { connection: this.connection, concurrency: 10, prefix: "bull" },
      );
      worker.on("failed", (job, err) => log.warn({ err, job_id: job?.id, queue }, "job failed"));
      this.workers.push(worker);
    }
    log.info({ queues }, "workers started");
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
