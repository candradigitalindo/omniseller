import { Inject, Injectable } from "@nestjs/common";
import type { CallRecord } from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { describeSyncError, recordConnectorCalls } from "./connector-calls";
import { type SyncJobRow, SyncRepository } from "./sync.repository";

export interface SyncLogEntry {
  storeId: string;
  /** What was synced: `auth.exchange`, `auth.refresh`, `warehouses.pull`, `webhooks.subscribe`, ... */
  kind: string;
  direction: "pull" | "push";
  queueJobId?: string;
  attempts?: number;
  request?: Record<string, unknown>;
}

/** Calls kept per log row; enough to see what happened without storing whole catalogs. */
const MAX_CALLS = 20;

/**
 * The per-store sync log (FR-INT-06, backend doc 8.6): one sync_job row per operation against a
 * marketplace, with the redacted HTTP calls it made, its duration, and a message the seller can act on.
 * Rows are written in their own short transactions, never around the marketplace call itself.
 */
@Injectable()
export class SyncLogService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(SyncRepository) private readonly repo: SyncRepository,
  ) {}

  async run<T>(
    ctx: RequestContext,
    entry: SyncLogEntry,
    fn: () => Promise<T>,
    summarize?: (result: T) => Record<string, unknown>,
  ): Promise<T> {
    const id = newId();
    const startedAt = new Date();
    await withTenantTx(this.db, ctx, (tx) =>
      this.repo.insertSyncJob(tx, {
        id,
        tenantId: ctx.tenantId,
        storeId: entry.storeId,
        kind: entry.kind,
        direction: entry.direction,
        status: "running",
        startedAt,
        attempts: entry.attempts ?? 1,
        queueJobId: entry.queueJobId ?? null,
        traceId: ctx.traceId,
        requestSummary: entry.request ?? null,
      }),
    );
    const calls: CallRecord[] = [];
    try {
      const result = await recordConnectorCalls(calls, fn);
      await this.finish(ctx, id, startedAt, "succeeded", calls, summarize?.(result));
      return result;
    } catch (err) {
      await this.finish(ctx, id, startedAt, "failed", calls, undefined, describeSyncError(err));
      throw err;
    }
  }

  /** An operation that was deliberately not performed (store in read-only mode, nothing to do). */
  async skipped(ctx: RequestContext, entry: SyncLogEntry, reason: string): Promise<void> {
    const now = new Date();
    await withTenantTx(this.db, ctx, (tx) =>
      this.repo.insertSyncJob(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        storeId: entry.storeId,
        kind: entry.kind,
        direction: entry.direction,
        status: "skipped",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        queueJobId: entry.queueJobId ?? null,
        traceId: ctx.traceId,
        errorMessage: reason,
      }),
    );
  }

  async list(ctx: RequestContext, storeId: string, before: string | undefined, limit: number): Promise<SyncJobRow[]> {
    return withTenantTx(this.db, ctx, (tx) => this.repo.listSyncJobs(tx, storeId, before, limit));
  }

  private async finish(
    ctx: RequestContext,
    id: string,
    startedAt: Date,
    status: "succeeded" | "failed",
    calls: CallRecord[],
    result?: Record<string, unknown>,
    error?: { code: string; message: string },
  ): Promise<void> {
    const finishedAt = new Date();
    await withTenantTx(this.db, ctx, (tx) =>
      this.repo.updateSyncJob(tx, id, {
        status,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        responseSummary: {
          ...(result ? { result } : {}),
          calls: calls.slice(0, MAX_CALLS),
          ...(calls.length > MAX_CALLS ? { callsOmitted: calls.length - MAX_CALLS } : {}),
        },
        errorCode: error?.code ?? null,
        errorMessage: error?.message ?? null,
      }),
    );
  }
}
