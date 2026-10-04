import { Injectable } from "@nestjs/common";
import type { PrintJobStatus } from "@omniseller/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, type SQL } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { printJob } from "../../db/schema";

export type PrintJobRow = typeof printJob.$inferSelect;

/** What the agent still has to print: queued with its file, or taken and not reported. */
const PENDING = or(and(eq(printJob.status, "queued"), isNotNull(printJob.fileObjectId)), eq(printJob.status, "sent"));

@Injectable()
export class PrintRepository {
  async insert(tx: Tx, row: typeof printJob.$inferInsert): Promise<PrintJobRow> {
    const [r] = await tx.insert(printJob).values(row).returning();
    return r!;
  }

  async get(tx: Tx, id: string, forUpdate = false): Promise<PrintJobRow | undefined> {
    const q = tx.select().from(printJob).where(eq(printJob.id, id));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  async update(tx: Tx, id: string, patch: Partial<typeof printJob.$inferInsert>): Promise<PrintJobRow> {
    const [r] = await tx.update(printJob).set(patch).where(eq(printJob.id, id)).returning();
    return r!;
  }

  /** The print queue (UI L07), newest first. */
  async page(
    tx: Tx,
    f: { deviceId?: string | undefined; status?: PrintJobStatus | undefined; requestedBy?: string | undefined },
    before: string | undefined,
    limit: number,
  ): Promise<PrintJobRow[]> {
    const where: (SQL | undefined)[] = [
      f.deviceId ? eq(printJob.deviceId, f.deviceId) : undefined,
      f.status ? eq(printJob.status, f.status) : undefined,
      f.requestedBy ? eq(printJob.requestedBy, f.requestedBy) : undefined,
      before ? lt(printJob.id, before) : undefined,
    ];
    return tx
      .select()
      .from(printJob)
      .where(and(...where))
      .orderBy(desc(printJob.id))
      .limit(limit + 1);
  }

  /** The newest print job of each of these documents. */
  async latestOfDocuments(tx: Tx, documentIds: string[]): Promise<Map<string, PrintJobRow>> {
    if (documentIds.length === 0) return new Map();
    const rows = await tx
      .select()
      .from(printJob)
      .where(inArray(printJob.documentId, documentIds))
      .orderBy(desc(printJob.id));
    const out = new Map<string, PrintJobRow>();
    for (const r of rows) if (r.documentId && !out.has(r.documentId)) out.set(r.documentId, r);
    return out;
  }

  /** Jobs still waiting for this document's file, locked. */
  async waitingFor(tx: Tx, documentId: string): Promise<PrintJobRow[]> {
    return tx
      .select()
      .from(printJob)
      .where(and(eq(printJob.documentId, documentId), eq(printJob.status, "queued"), isNull(printJob.fileObjectId)))
      .orderBy(asc(printJob.id))
      .for("update");
  }

  /** What this agent still has to print, oldest first. */
  async pendingFor(tx: Tx, deviceId: string, limit: number): Promise<PrintJobRow[]> {
    return tx
      .select()
      .from(printJob)
      .where(and(eq(printJob.deviceId, deviceId), PENDING))
      .orderBy(asc(printJob.id))
      .limit(limit);
  }

  /** Jobs of this device that have not printed, failed, or been cancelled (a revoked agent's queue). */
  async openFor(tx: Tx, deviceId: string): Promise<PrintJobRow[]> {
    return tx
      .select()
      .from(printJob)
      .where(and(eq(printJob.deviceId, deviceId), inArray(printJob.status, ["queued", "sent"])))
      .for("update");
  }
}
