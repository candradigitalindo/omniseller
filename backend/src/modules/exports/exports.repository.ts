import { Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { dataExport } from "../../db/schema";

export type DataExportRow = typeof dataExport.$inferSelect;

@Injectable()
export class ExportsRepository {
  /** Inserts the export unless the business already has one queued or running (partial unique index). */
  async insertIfNoneOpen(tx: Tx, row: typeof dataExport.$inferInsert): Promise<DataExportRow | undefined> {
    const [r] = await tx
      .insert(dataExport)
      .values(row)
      // the predicate repeats the index's, literally, so Postgres infers the partial unique index
      .onConflictDoNothing({ target: dataExport.tenantId, where: sql`status IN ('queued', 'running')` })
      .returning();
    return r;
  }

  /** The export still queued or running, if any. */
  async open(tx: Tx, forUpdate = false): Promise<DataExportRow | undefined> {
    const q = tx
      .select()
      .from(dataExport)
      .where(inArray(dataExport.status, ["queued", "running"]));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  async get(tx: Tx, id: string, forUpdate = false): Promise<DataExportRow | undefined> {
    const q = tx.select().from(dataExport).where(eq(dataExport.id, id));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  async list(tx: Tx, limit: number): Promise<DataExportRow[]> {
    return tx.select().from(dataExport).orderBy(desc(dataExport.id)).limit(limit);
  }

  async update(tx: Tx, id: string, patch: Partial<typeof dataExport.$inferInsert>): Promise<void> {
    if (Object.keys(patch).length > 0) await tx.update(dataExport).set(patch).where(eq(dataExport.id, id));
  }

  /** Counts a download of a ready export; the audit trigger records who downloaded it. */
  async countDownload(tx: Tx, id: string): Promise<void> {
    await tx
      .update(dataExport)
      .set({ downloadCount: sql`${dataExport.downloadCount} + 1`, lastDownloadedAt: new Date() })
      .where(and(eq(dataExport.id, id), eq(dataExport.status, "ready")));
  }
}
