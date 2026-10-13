import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { reportScheduleRun } from "../../db/schema";

export type ReportScheduleRunRow = typeof reportScheduleRun.$inferSelect;

/** The claim rows of scheduled report emails (backend doc 8.20): one per business, cadence, and period. */
@Injectable()
export class ScheduledReportRepository {
  /** Null when the business already had this period's reports planned. */
  async claim(tx: Tx, row: typeof reportScheduleRun.$inferInsert): Promise<ReportScheduleRunRow | null> {
    const [r] = await tx.insert(reportScheduleRun).values(row).onConflictDoNothing().returning();
    return r ?? null;
  }

  async setRecipients(tx: Tx, id: string, recipients: number): Promise<void> {
    await tx.update(reportScheduleRun).set({ recipients }).where(eq(reportScheduleRun.id, id));
  }
}
