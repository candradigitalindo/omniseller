import { Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { listingPriceChange } from "../../db/schema";

export type PriceChangeRow = typeof listingPriceChange.$inferSelect;

@Injectable()
export class ListingPriceRepository {
  async lockListing(tx: Tx, listingId: string): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`listing-price:${listingId}`}, 0))`);
  }

  async get(tx: Tx, id: string): Promise<PriceChangeRow | undefined> {
    const [row] = await tx.select().from(listingPriceChange).where(eq(listingPriceChange.id, id));
    return row;
  }

  history(tx: Tx, listingId: string) {
    return tx
      .select()
      .from(listingPriceChange)
      .where(eq(listingPriceChange.listingId, listingId))
      .orderBy(desc(listingPriceChange.id))
      .limit(10);
  }

  async pending(tx: Tx, listingId: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: listingPriceChange.id })
      .from(listingPriceChange)
      .where(
        and(eq(listingPriceChange.listingId, listingId), inArray(listingPriceChange.status, ["queued", "processing"])),
      )
      .limit(1);
    return !!row;
  }

  async create(tx: Tx, values: typeof listingPriceChange.$inferInsert): Promise<PriceChangeRow> {
    const [row] = await tx.insert(listingPriceChange).values(values).returning();
    return row!;
  }

  async claim(tx: Tx, id: string, claimId: string): Promise<PriceChangeRow | undefined> {
    const [row] = await tx
      .update(listingPriceChange)
      .set({ status: "processing", claimId, claimedAt: new Date() })
      .where(
        and(
          eq(listingPriceChange.id, id),
          or(
            eq(listingPriceChange.status, "queued"),
            and(
              eq(listingPriceChange.status, "processing"),
              lt(listingPriceChange.claimedAt, new Date(Date.now() - 300_000)),
            ),
          ),
        ),
      )
      .returning();
    return row;
  }

  async finish(tx: Tx, id: string, claimId: string, values: Partial<PriceChangeRow>): Promise<void> {
    await tx
      .update(listingPriceChange)
      .set({ ...values, claimId: null, claimedAt: null })
      .where(
        and(
          eq(listingPriceChange.id, id),
          eq(listingPriceChange.claimId, claimId),
          eq(listingPriceChange.status, "processing"),
        ),
      );
  }

  async cancel(tx: Tx, listingId: string, id: string): Promise<boolean> {
    const rows = await tx
      .update(listingPriceChange)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(listingPriceChange.id, id),
          eq(listingPriceChange.listingId, listingId),
          eq(listingPriceChange.status, "queued"),
          isNull(listingPriceChange.sentAt),
        ),
      )
      .returning({ id: listingPriceChange.id });
    return rows.length > 0;
  }

  page(tx: Tx, after: string | undefined, limit: number) {
    return tx
      .select()
      .from(listingPriceChange)
      .where(after ? gt(listingPriceChange.id, after) : undefined)
      .orderBy(listingPriceChange.id)
      .limit(limit);
  }
}
