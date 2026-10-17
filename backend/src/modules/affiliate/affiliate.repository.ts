import { Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { affiliateProductQuery } from "../../db/schema";
export type AffiliateQueryRow = typeof affiliateProductQuery.$inferSelect;
@Injectable()
export class AffiliateRepository {
  async lockStore(tx: Tx, storeId: string) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`affiliate-read:${storeId}`},0))`);
  }
  async get(tx: Tx, id: string) {
    return (await tx.select().from(affiliateProductQuery).where(eq(affiliateProductQuery.id, id)))[0];
  }
  async latest(tx: Tx, storeId: string) {
    return (
      await tx
        .select()
        .from(affiliateProductQuery)
        .where(eq(affiliateProductQuery.storeId, storeId))
        .orderBy(desc(affiliateProductQuery.id))
        .limit(1)
    )[0];
  }
  async pending(tx: Tx, storeId: string) {
    return (
      await tx
        .select({ id: affiliateProductQuery.id })
        .from(affiliateProductQuery)
        .where(
          and(eq(affiliateProductQuery.storeId, storeId), inArray(affiliateProductQuery.status, ["queued", "running"])),
        )
        .limit(1)
    )[0];
  }
  async insert(tx: Tx, values: typeof affiliateProductQuery.$inferInsert) {
    return (await tx.insert(affiliateProductQuery).values(values).returning())[0]!;
  }
  async claim(tx: Tx, id: string, claimId: string) {
    return (
      await tx
        .update(affiliateProductQuery)
        .set({ status: "running", claimId, claimedAt: new Date() })
        .where(
          and(
            eq(affiliateProductQuery.id, id),
            or(
              eq(affiliateProductQuery.status, "queued"),
              and(
                eq(affiliateProductQuery.status, "running"),
                lt(affiliateProductQuery.claimedAt, new Date(Date.now() - 300_000)),
              ),
            ),
          ),
        )
        .returning()
    )[0];
  }
  async finish(tx: Tx, id: string, claimId: string, values: Partial<AffiliateQueryRow>) {
    await tx
      .update(affiliateProductQuery)
      .set({ ...values, claimId: null, claimedAt: null })
      .where(
        and(
          eq(affiliateProductQuery.id, id),
          eq(affiliateProductQuery.claimId, claimId),
          eq(affiliateProductQuery.status, "running"),
        ),
      );
  }
  async expire(tx: Tx, storeId: string) {
    await tx
      .update(affiliateProductQuery)
      .set({
        status: "failed",
        errorCode: "expired",
        errorMessage: "Permintaan kedaluwarsa. Jalankan pencarian kembali.",
        finishedAt: new Date(),
        claimId: null,
        claimedAt: null,
      })
      .where(
        and(
          eq(affiliateProductQuery.storeId, storeId),
          lt(affiliateProductQuery.expiresAt, new Date()),
          inArray(affiliateProductQuery.status, ["queued", "running"]),
        ),
      );
    await tx
      .delete(affiliateProductQuery)
      .where(
        and(
          eq(affiliateProductQuery.storeId, storeId),
          lt(affiliateProductQuery.expiresAt, new Date(Date.now() - 7 * 86_400_000)),
        ),
      );
  }
  page(tx: Tx, after: string | undefined, limit: number) {
    return tx
      .select()
      .from(affiliateProductQuery)
      .where(after ? gt(affiliateProductQuery.id, after) : undefined)
      .orderBy(affiliateProductQuery.id)
      .limit(limit);
  }
  async deleteStore(tx: Tx, storeId: string, limit: number) {
    const rows = await tx
      .select({ id: affiliateProductQuery.id })
      .from(affiliateProductQuery)
      .where(eq(affiliateProductQuery.storeId, storeId))
      .limit(limit);
    if (rows.length)
      await tx.delete(affiliateProductQuery).where(
        inArray(
          affiliateProductQuery.id,
          rows.map((r) => r.id),
        ),
      );
    return rows.length;
  }
}
