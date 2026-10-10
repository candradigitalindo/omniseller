import { Injectable } from "@nestjs/common";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { orderRule } from "../../db/schema";

export type OrderRuleRow = typeof orderRule.$inferSelect;

/** Rows of `order_rule` (owned by the automation module, backend doc 11). `touch_row` moves `row_version`. */
@Injectable()
export class OrderRulesRepository {
  /** Every rule in the order they are checked: priority, then age. */
  list(tx: Tx, onlyActive = false): Promise<OrderRuleRow[]> {
    return tx
      .select()
      .from(orderRule)
      .where(onlyActive ? eq(orderRule.active, true) : undefined)
      .orderBy(asc(orderRule.priority), asc(orderRule.id));
  }

  async get(tx: Tx, id: string, forUpdate = false): Promise<OrderRuleRow | undefined> {
    const q = tx.select().from(orderRule).where(eq(orderRule.id, id));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  async count(tx: Tx): Promise<{ rules: number; lastPriority: number }> {
    const [r] = await tx
      .select({
        rules: sql<number>`count(*)::int`,
        lastPriority: sql<number>`coalesce(max(${orderRule.priority}), 0)::int`,
      })
      .from(orderRule);
    return { rules: r?.rules ?? 0, lastPriority: r?.lastPriority ?? 0 };
  }

  /** Names compare without case, like the unique index. */
  async nameTaken(tx: Tx, name: string, exceptId?: string): Promise<boolean> {
    const [r] = await tx
      .select({ id: orderRule.id })
      .from(orderRule)
      .where(and(sql`lower(${orderRule.name}) = lower(${name})`, exceptId ? ne(orderRule.id, exceptId) : undefined));
    return !!r;
  }

  async insert(tx: Tx, row: typeof orderRule.$inferInsert): Promise<void> {
    await tx.insert(orderRule).values(row);
  }

  async update(tx: Tx, id: string, patch: Partial<typeof orderRule.$inferInsert>): Promise<void> {
    await tx.update(orderRule).set(patch).where(eq(orderRule.id, id));
  }

  async remove(tx: Tx, id: string): Promise<void> {
    await tx.delete(orderRule).where(eq(orderRule.id, id));
  }
}
