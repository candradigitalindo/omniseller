import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { businessDocument, businessProfile } from "../../db/schema";

export type BusinessProfileRow = typeof businessProfile.$inferSelect;
export type BusinessDocumentRow = typeof businessDocument.$inferSelect;

/** Rows of `business_profile` and `business_document` (owned by the business module, backend doc 11). */
@Injectable()
export class BusinessRepository {
  async profile(tx: Tx, forUpdate = false): Promise<BusinessProfileRow | undefined> {
    const q = tx.select().from(businessProfile).limit(1);
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  async insertProfile(tx: Tx, row: typeof businessProfile.$inferInsert): Promise<void> {
    await tx.insert(businessProfile).values(row);
  }

  /** False when the row changed since `expected` (If-Match). */
  async updateProfile(
    tx: Tx,
    id: string,
    patch: Partial<typeof businessProfile.$inferInsert>,
    expected?: number,
  ): Promise<boolean> {
    const res = await tx
      .update(businessProfile)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${businessProfile.rowVersion} + 1` })
      .where(
        expected === undefined
          ? eq(businessProfile.id, id)
          : and(eq(businessProfile.id, id), eq(businessProfile.rowVersion, expected)),
      )
      .returning({ id: businessProfile.id });
    return res.length > 0;
  }

  async documents(tx: Tx): Promise<BusinessDocumentRow[]> {
    return tx.select().from(businessDocument).orderBy(asc(businessDocument.validUntil), desc(businessDocument.id));
  }

  async document(tx: Tx, id: string, forUpdate = false): Promise<BusinessDocumentRow | undefined> {
    const q = tx.select().from(businessDocument).where(eq(businessDocument.id, id));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  async insertDocument(tx: Tx, row: typeof businessDocument.$inferInsert): Promise<void> {
    await tx.insert(businessDocument).values(row);
  }

  async updateDocument(tx: Tx, id: string, patch: Partial<typeof businessDocument.$inferInsert>): Promise<void> {
    await tx
      .update(businessDocument)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${businessDocument.rowVersion} + 1` })
      .where(eq(businessDocument.id, id));
  }

  async deleteDocument(tx: Tx, id: string): Promise<void> {
    await tx.delete(businessDocument).where(eq(businessDocument.id, id));
  }

  /** Keyset page of documents for the full data export. */
  async documentsAfter(tx: Tx, after: string | undefined, limit: number): Promise<BusinessDocumentRow[]> {
    return tx
      .select()
      .from(businessDocument)
      .where(after ? gt(businessDocument.id, after) : undefined)
      .orderBy(asc(businessDocument.id))
      .limit(limit);
  }
}
