import { newId, ulidSchema } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { systemContext } from "../common/context/request-context";
import type { DbHandle } from "../db/client";
import { withSystemTx, withTenantTx } from "../db/tenant-tx";
import type { QueueRegistry } from "../jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../jobs/registry";
import { tenantDekRotationRequested } from "../modules/channel/channel.events";
import { tenantForOpsIn } from "../modules/identity/tenant-ops";
import { requestStockPushIn } from "../modules/inventory/stock-repush";
import { tenantPurgeRequested } from "../modules/retention/retention.events";
import { replayWebhooksIn } from "../modules/sync/webhook-replay";
import { Outbox } from "../outbox/outbox";
import { guardOps, type OpsCommand } from "./ops-plan";

export interface OpsResources {
  worker?: DbHandle;
  system?: DbHandle;
  queues?: QueueRegistry;
}
const registry = new JobRegistry(JOB_DEFINITIONS);

/** Failed jobs stay in BullMQ's failed set. Never print payloads, results, stack traces, or error text. */
async function failedJobs(command: OpsCommand, queues: QueueRegistry) {
  const queue = queues.get(command.queue!);
  const total = await queue.getFailedCount();
  const jobs = command.id ? [await queue.getJob(command.id)] : await queue.getFailed(0, command.limit - 1);
  if (command.id && (!jobs[0] || (await jobs[0].getState()) !== "failed"))
    throw new Error("job is missing or not failed");
  if (command.name === "jobs:dlq")
    return {
      total,
      more: total > command.limit,
      jobs: jobs
        .filter((j) => !!j)
        .map((j) => ({
          id: j.id,
          name: registry.get(command.queue!, j.name)?.name ?? "unregistered",
          attempts: j.attemptsMade,
          finishedAt: j.finishedOn,
        })),
    };
  let retried = 0;
  let skipped = 0;
  for (const job of jobs) {
    const def = job && registry.get(command.queue!, job.name);
    // Only retry known jobs with valid tenant payloads; other entries remain available for inspection.
    if (!job || !def?.schema.safeParse(job.data).success || !ulidSchema.safeParse(job.data?.tenantId).success) {
      if (command.id) throw new Error("job has an unregistered name or invalid payload");
      skipped++;
      continue;
    }
    if (command.dryRun) {
      retried++;
      continue;
    }
    try {
      await job.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
      retried++;
    } catch {
      // A second operator may already have retried it; never remove or recreate the original job.
      if (command.id) throw new Error("job could not be retried from failed state");
      skipped++;
    }
  }
  return { selected: jobs.length, retried, skipped, more: !command.id && total > command.limit };
}

/** One-shot operational entry point; tenant requests commit to outbox and are executed by workers. */
export async function executeOps(
  command: OpsCommand,
  resources: OpsResources,
  env: Record<string, string | undefined>,
) {
  guardOps(command, env);
  if (command.name.startsWith("jobs:")) {
    if (!resources.queues) throw new Error("queue connection is required");
    return failedJobs(command, resources.queues);
  }
  if (command.name === "partition:maintain") {
    if (!resources.system) throw new Error("system database connection is required");
    if (command.dryRun) return { operation: "maintain_partitions", selected: 1 };
    return withSystemTx(resources.system, async (tx) => {
      const result = await tx.execute<{ created: number }>(sql`SELECT maintain_partitions(now()) AS created`);
      return { created: Number(result.rows[0]?.created ?? 0) };
    });
  }
  if (!resources.worker || !command.tenantId) throw new Error("worker database connection and tenant are required");
  const ctx = systemContext(command.tenantId);
  const outbox = new Outbox(registry);
  return withTenantTx(resources.worker, ctx, async (tx) => {
    const tenant = await tenantForOpsIn(tx, ctx.tenantId);
    if (command.name === "tenant:purge") {
      if (
        !["closing", "closed"].includes(tenant.status) ||
        !tenant.purgeAfter ||
        tenant.purgeAfter.getTime() > Date.now()
      ) {
        throw new Error("tenant must be closed and past its purge date");
      }
      if (!command.dryRun)
        await outbox.enqueue(tx, ctx, tenantPurgeRequested, { slot: `ops-${newId()}` }, ctx.tenantId);
      return { selected: 1 };
    }
    if (tenant.status !== "active") throw new Error("operation requires an active tenant");
    if (command.name === "webhook:replay") return replayWebhooksIn(tx, ctx, outbox, command);
    if (command.name === "stock:push")
      return requestStockPushIn(
        tx,
        ctx,
        outbox,
        { variantId: command.variantId!, warehouseId: command.warehouseId! },
        command.dryRun,
      );
    const rotationId = newId();
    if (!command.dryRun) await outbox.enqueue(tx, ctx, tenantDekRotationRequested, { rotationId }, ctx.tenantId);
    return { selected: 1, rotationId: command.dryRun ? undefined : rotationId };
  });
}
