import { Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { orderRuleSchedule } from "../../db/schema";

export type ScheduleRow = typeof orderRuleSchedule.$inferSelect;

/** A claimed row is left to its job this long; a crashed job's rows are taken again afterwards. */
export const SCHEDULE_LEASE_MS = 2 * 60_000;
/** A row whose arrange failed this often (not refused: failed) is dropped and the order told. */
export const SCHEDULE_MAX_ATTEMPTS = 3;

/** Rows of `order_rule_schedule` (owned by the automation module, backend doc 8.37). */
@Injectable()
export class ScheduleRepository {
  async insert(tx: Tx, row: typeof orderRuleSchedule.$inferInsert): Promise<void> {
    await tx.insert(orderRuleSchedule).values(row);
  }

  /**
   * Claims up to `limit` rows due by `until` that no running job holds: locked skipping others' rows,
   * then marked with the claim and one more attempt. The caller commits the claim before acting.
   */
  async claimDue(tx: Tx, until: Date, now: Date, limit: number): Promise<ScheduleRow[]> {
    const lease = new Date(now.getTime() - SCHEDULE_LEASE_MS);
    const due = await tx
      .select({ id: orderRuleSchedule.id })
      .from(orderRuleSchedule)
      .where(
        and(
          lte(orderRuleSchedule.dueAt, until),
          or(isNull(orderRuleSchedule.claimedAt), lte(orderRuleSchedule.claimedAt, lease)),
        ),
      )
      .orderBy(orderRuleSchedule.dueAt, orderRuleSchedule.id)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(orderRuleSchedule)
      .set({ claimedAt: now, attempts: sql`${orderRuleSchedule.attempts} + 1` })
      .where(
        inArray(
          orderRuleSchedule.id,
          due.map((r) => r.id),
        ),
      )
      .returning();
  }

  async remove(tx: Tx, ids: string[]): Promise<void> {
    if (ids.length > 0) await tx.delete(orderRuleSchedule).where(inArray(orderRuleSchedule.id, ids));
  }

  /** How many orders wait for each rule (UI L55). */
  async countByRule(tx: Tx): Promise<Map<string, number>> {
    const rows = await tx
      .select({ ruleId: orderRuleSchedule.ruleId, n: sql<number>`count(*)::int` })
      .from(orderRuleSchedule)
      .groupBy(orderRuleSchedule.ruleId);
    return new Map(rows.filter((r) => r.ruleId).map((r) => [r.ruleId!, r.n]));
  }

  /** The waiting row of an order, if any. */
  async ofOrder(tx: Tx, orderId: string): Promise<ScheduleRow | undefined> {
    const [r] = await tx.select().from(orderRuleSchedule).where(eq(orderRuleSchedule.orderId, orderId));
    return r;
  }
}
