import { Injectable } from "@nestjs/common";
import type { SyncJobStatus } from "@omniseller/shared";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { syncJob, webhookInbox } from "../../db/schema";

export type SyncJobRow = typeof syncJob.$inferSelect;
export type WebhookInboxRow = typeof webhookInbox.$inferSelect;

/** Tables owned by the sync module (backend doc 11): sync_job and webhook_inbox (outbox_event is infra). */
@Injectable()
export class SyncRepository {
  async insertSyncJob(tx: Tx, row: typeof syncJob.$inferInsert): Promise<void> {
    await tx.insert(syncJob).values(row);
  }

  async updateSyncJob(tx: Tx, id: string, patch: Partial<typeof syncJob.$inferInsert>): Promise<void> {
    await tx
      .update(syncJob)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${syncJob.rowVersion} + 1` })
      .where(eq(syncJob.id, id));
  }

  async listSyncJobs(
    tx: Tx,
    storeId: string,
    before: string | undefined,
    limit: number,
    status?: SyncJobStatus,
  ): Promise<SyncJobRow[]> {
    return tx
      .select()
      .from(syncJob)
      .where(
        and(
          eq(syncJob.storeId, storeId),
          before ? lt(syncJob.id, before) : undefined,
          status ? eq(syncJob.status, status) : undefined,
        ),
      )
      .orderBy(desc(syncJob.id))
      .limit(limit + 1);
  }

  /** webhook_inbox is global (no RLS): callers check that the row belongs to their tenant. */
  async inboxRow(tx: Tx, id: string): Promise<WebhookInboxRow | undefined> {
    const [row] = await tx.select().from(webhookInbox).where(eq(webhookInbox.id, id)).for("update");
    return row;
  }

  async markInbox(tx: Tx, id: string, outcome: { processed: boolean; error: string | null }): Promise<void> {
    await tx
      .update(webhookInbox)
      .set({
        attempts: sql`${webhookInbox.attempts} + 1`,
        lastError: outcome.error,
        ...(outcome.processed ? { processedAt: new Date() } : {}),
      })
      .where(and(eq(webhookInbox.id, id), isNull(webhookInbox.processedAt)));
  }

  /** Verified creator revocations also fence a staged grant before it creates/reauthorizes an account. */
  async accountRevokedSince(tx: Tx, kind: string, externalId: string, authorizedAt: Date, applicationId?: string) {
    // The provider reports cancel_time in seconds. A same-second cancellation wins conservatively.
    const since = new Date(Math.floor(authorizedAt.getTime() / 1000) * 1000);
    const rows = await tx
      .select({ id: webhookInbox.id })
      .from(webhookInbox)
      .where(
        and(
          eq(webhookInbox.source, "tiktokshop"),
          eq(webhookInbox.signatureValid, true),
          eq(webhookInbox.eventType, "CREATOR_DEAUTHORIZATION"),
          eq(webhookInbox.externalAccountKind, kind),
          eq(webhookInbox.externalAccountId, externalId),
          applicationId ? eq(webhookInbox.applicationId, applicationId) : isNull(webhookInbox.applicationId),
          sql`${webhookInbox.occurredAt} >= ${since}`,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Deletes up to `limit` sync log entries of a store (FR-INT-07); returns how many. */
  async deleteStoreSyncJobs(tx: Tx, storeId: string, limit: number): Promise<number> {
    const batch = tx.select({ id: syncJob.id }).from(syncJob).where(eq(syncJob.storeId, storeId)).limit(limit);
    const r = await tx.delete(syncJob).where(inArray(syncJob.id, batch)).returning({ id: syncJob.id });
    return r.length;
  }
}
