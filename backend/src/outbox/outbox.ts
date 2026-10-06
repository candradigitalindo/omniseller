import { newId } from "@omniseller/shared";
import type { z } from "zod";
import type { RequestContext } from "../common/context/request-context";
import type { Tx } from "../db/client";
import { outboxEvent } from "../db/schema";
import type { EventDef } from "../jobs/define";
import { requesterOf } from "../jobs/job-context";
import type { JobRegistry } from "../jobs/registry";

/**
 * Transactional outbox (backend doc 8.5, ADR-024). Services never call queue.add() directly:
 * they record the event in the same transaction as the data change, one row per consumer job.
 * If the transaction rolls back, no job exists; if Redis is down, the rows wait for the relay.
 */
export class Outbox {
  constructor(private readonly registry: JobRegistry) {}

  /** Returns the outbox row ids written (one per consumer; none when nothing consumes the event). */
  async enqueue<S extends z.ZodType>(
    tx: Tx,
    ctx: RequestContext,
    event: EventDef<S>,
    payload: z.infer<S>,
    aggregateId: string,
  ): Promise<string[]> {
    const parsed = event.schema.parse(payload) as Record<string, unknown>;
    const consumers = this.registry.consumersOf(event);
    if (consumers.length === 0) return [];
    const withTenant = { ...parsed, tenantId: ctx.tenantId };
    const rows = consumers.map((job) => {
      const id = newId();
      const jobPayload = job.schema.parse(withTenant) as Record<string, unknown>;
      return {
        id,
        tenantId: ctx.tenantId,
        aggregateType: event.aggregate,
        aggregateId,
        eventType: event.type,
        payload: { ...jobPayload, tenantId: ctx.tenantId, ...requesterOf(job, ctx) },
        queue: job.queue,
        jobName: job.name,
        jobId: job.jobId({ ...jobPayload, tenantId: ctx.tenantId } as never, { eventId: id }),
        jobOptions: (job.options ?? {}) as Record<string, unknown>,
      };
    });
    await tx.insert(outboxEvent).values(rows);
    return rows.map((r) => r.id);
  }
}
