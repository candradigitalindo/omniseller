import type { JobsOptions } from "bullmq";
import type { z } from "zod";
import type { RequestContext } from "../common/context/request-context";
import type { QueueName } from "./queues";

/**
 * Events and jobs (backend doc 8.5 and 9.1).
 *
 * An event is a fact (`order.status_changed`) or a request to the outside (`order.accept_requested`).
 * Services write it with outbox.enqueue(tx, ctx, event, payload) in the same transaction as the data
 * change. Each job that lists the event in `triggeredBy` gets its own outbox row, and the relay moves
 * it to BullMQ with the job's deterministic id.
 */
export interface EventDef<S extends z.ZodType = z.ZodType> {
  readonly type: string;
  readonly aggregate: string;
  readonly schema: S;
}

export function defineEvent<S extends z.ZodType>(def: EventDef<S>): EventDef<S> {
  if (!/^[a-z_]+\.[a-z_]+$/.test(def.type)) throw new Error(`event type must be <aggregate>.<verb>: ${def.type}`);
  return def;
}

/** Every job payload carries the tenant; the framework adds it, definitions never declare it. */
export type WithTenant<P> = P & { tenantId: string };

export interface JobIdMeta {
  /** Outbox event id for jobs created from an event; undefined for jobs enqueued directly. */
  eventId?: string;
}

/**
 * Services for job handlers. Handlers call services, never repositories (backend doc 3.2):
 * `run.deps.resolve(InvitationsService).send(run.ctx, id)`. Backed by the Nest container in the
 * worker; tests pass their own resolver.
 */
export interface JobDeps {
  resolve<T>(token: abstract new (...args: never[]) => T): T;
}

export interface JobRun {
  ctx: RequestContext;
  jobId: string;
  attemptsMade: number;
  deps: JobDeps;
}

export interface JobDef<S extends z.ZodType = z.ZodType> {
  readonly queue: QueueName;
  readonly name: string;
  readonly schema: S;
  readonly options?: JobsOptions;
  readonly triggeredBy?: readonly EventDef[];
  /** Deterministic id; see job-id.ts for once-per-entity vs per-occurrence ids. */
  readonly jobId: (payload: WithTenant<z.infer<S>>, meta: JobIdMeta) => string;
  /** Must be idempotent: reload current state, check it, then act. */
  readonly handler: (payload: WithTenant<z.infer<S>>, run: JobRun) => Promise<void>;
}

export function defineJob<S extends z.ZodType>(def: JobDef<S>): JobDef<S> {
  if (!/^[a-z_]+(\.[a-z_]+)+$/.test(def.name)) throw new Error(`job name must be dotted lowercase: ${def.name}`);
  return def;
}
