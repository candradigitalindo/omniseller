import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { fileObject } from "../../db/schema";

export type FileRow = typeof fileObject.$inferSelect;

@Injectable()
export class FilesRepository {
  async insert(tx: Tx, row: typeof fileObject.$inferInsert): Promise<FileRow> {
    const [r] = await tx.insert(fileObject).values(row).returning();
    return r!;
  }

  async get(tx: Tx, id: string): Promise<FileRow | undefined> {
    const [r] = await tx.select().from(fileObject).where(eq(fileObject.id, id));
    return r;
  }

  async expired(tx: Tx, now: Date, limit: number): Promise<FileRow[]> {
    return tx
      .select()
      .from(fileObject)
      .where(and(isNotNull(fileObject.expiresAt), lte(fileObject.expiresAt, now)))
      .orderBy(asc(fileObject.expiresAt))
      .limit(limit);
  }

  async delete(tx: Tx, ids: string[]): Promise<void> {
    if (ids.length > 0) await tx.delete(fileObject).where(inArray(fileObject.id, ids));
  }
}
