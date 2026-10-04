import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { dailyDigest } from "../../db/schema";

export type DailyDigestRow = typeof dailyDigest.$inferSelect;

@Injectable()
export class DigestRepository {
  /** Null when the business already had its email of that local date. */
  async claim(tx: Tx, row: typeof dailyDigest.$inferInsert): Promise<DailyDigestRow | null> {
    const [r] = await tx.insert(dailyDigest).values(row).onConflictDoNothing().returning();
    return r ?? null;
  }

  async setRecipients(tx: Tx, id: string, recipients: number): Promise<void> {
    await tx.update(dailyDigest).set({ recipients }).where(eq(dailyDigest.id, id));
  }
}
