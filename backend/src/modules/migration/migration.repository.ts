import { Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { and, asc, desc, eq, gt, inArray, or } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { migrationJob, migrationPreset, migrationRowError, storeCutover } from "../../db/schema";

export type MigrationJobRow = typeof migrationJob.$inferSelect;
export type RowErrorRow = typeof migrationRowError.$inferSelect;
export type PresetRow = typeof migrationPreset.$inferSelect;
export type CutoverRow = typeof storeCutover.$inferSelect;

export interface NewRowError {
  rowNumber: number;
  field: string | null;
  message: string;
  raw: string[];
}

@Injectable()
export class MigrationRepository {
  // ---- import jobs ----

  async insertJob(tx: Tx, row: typeof migrationJob.$inferInsert): Promise<MigrationJobRow> {
    const [r] = await tx.insert(migrationJob).values(row).returning();
    return r!;
  }

  async getJob(tx: Tx, id: string, forUpdate = false): Promise<MigrationJobRow | undefined> {
    const q = tx.select().from(migrationJob).where(eq(migrationJob.id, id));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  async listJobs(tx: Tx, limit: number): Promise<MigrationJobRow[]> {
    return tx.select().from(migrationJob).orderBy(desc(migrationJob.id)).limit(limit);
  }

  async updateJob(tx: Tx, id: string, patch: Partial<typeof migrationJob.$inferInsert>): Promise<void> {
    if (Object.keys(patch).length > 0) await tx.update(migrationJob).set(patch).where(eq(migrationJob.id, id));
  }

  /** The problems of the job's last validation replace those of the one before. */
  async replaceErrors(tx: Tx, tenantId: string, jobId: string, errors: NewRowError[]): Promise<void> {
    await tx.delete(migrationRowError).where(eq(migrationRowError.migrationJobId, jobId));
    for (let i = 0; i < errors.length; i += 500) {
      await tx
        .insert(migrationRowError)
        .values(errors.slice(i, i + 500).map((e) => ({ id: newId(), tenantId, migrationJobId: jobId, ...e })));
    }
  }

  /** Problems in row order; the cursor is the last (row, id) seen. */
  async errors(
    tx: Tx,
    jobId: string,
    after: { row: number; id: string } | undefined,
    limit: number,
  ): Promise<RowErrorRow[]> {
    return tx
      .select()
      .from(migrationRowError)
      .where(
        and(
          eq(migrationRowError.migrationJobId, jobId),
          after
            ? or(
                gt(migrationRowError.rowNumber, after.row),
                and(eq(migrationRowError.rowNumber, after.row), gt(migrationRowError.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(migrationRowError.rowNumber), asc(migrationRowError.id))
      .limit(limit);
  }

  // ---- presets ----

  async presets(tx: Tx): Promise<PresetRow[]> {
    return tx.select().from(migrationPreset).orderBy(asc(migrationPreset.name));
  }

  async getPreset(tx: Tx, id: string): Promise<PresetRow | undefined> {
    const [r] = await tx.select().from(migrationPreset).where(eq(migrationPreset.id, id));
    return r;
  }

  /** Null when the business already has a preset with that name (case and spaces ignored). */
  async insertPreset(tx: Tx, row: typeof migrationPreset.$inferInsert): Promise<PresetRow | null> {
    // the only unique index besides the key is (tenant_id, lower(btrim(name)))
    const [r] = await tx.insert(migrationPreset).values(row).onConflictDoNothing().returning();
    return r ?? null;
  }

  async deletePreset(tx: Tx, id: string): Promise<boolean> {
    const r = await tx.delete(migrationPreset).where(eq(migrationPreset.id, id)).returning({ id: migrationPreset.id });
    return r.length > 0;
  }

  // ---- cutovers ----

  async insertCutover(tx: Tx, row: typeof storeCutover.$inferInsert): Promise<CutoverRow> {
    const [r] = await tx.insert(storeCutover).values(row).returning();
    return r!;
  }

  async getCutover(tx: Tx, id: string, forUpdate = false): Promise<CutoverRow | undefined> {
    const q = tx.select().from(storeCutover).where(eq(storeCutover.id, id));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  async cutovers(tx: Tx, storeIds: string[] | null, limit: number): Promise<CutoverRow[]> {
    if (storeIds && storeIds.length === 0) return [];
    return tx
      .select()
      .from(storeCutover)
      .where(storeIds ? inArray(storeCutover.storeId, storeIds) : undefined)
      .orderBy(desc(storeCutover.id))
      .limit(limit);
  }

  async updateCutover(tx: Tx, id: string, patch: Partial<typeof storeCutover.$inferInsert>): Promise<void> {
    await tx.update(storeCutover).set(patch).where(eq(storeCutover.id, id));
  }
}
