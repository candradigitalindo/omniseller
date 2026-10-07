import { Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { invoice, subscription, usageCounter } from "../../db/schema";

export type SubscriptionRow = typeof subscription.$inferSelect;
export type InvoiceRow = typeof invoice.$inferSelect;
export type UsageRow = typeof usageCounter.$inferSelect;

/** The statuses of a subscription in force; a tenant has at most one such row. */
export const LIVE_STATUSES = ["trialing", "active", "past_due"] as const;

/** Rows of `subscription`, `invoice`, and `usage_counter` (owned by the billing module, backend doc 11). */
@Injectable()
export class BillingRepository {
  // ---- subscriptions ----

  async live(tx: Tx, forUpdate = false): Promise<SubscriptionRow | undefined> {
    const q = tx
      .select()
      .from(subscription)
      .where(inArray(subscription.status, [...LIVE_STATUSES]))
      .limit(1);
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  async subscriptions(tx: Tx): Promise<SubscriptionRow[]> {
    return tx.select().from(subscription).orderBy(desc(subscription.id));
  }

  async insertSubscription(tx: Tx, row: typeof subscription.$inferInsert): Promise<void> {
    await tx.insert(subscription).values(row);
  }

  async updateSubscription(tx: Tx, id: string, patch: Partial<typeof subscription.$inferInsert>): Promise<void> {
    await tx.update(subscription).set(patch).where(eq(subscription.id, id));
  }

  // ---- invoices ----

  async invoice(tx: Tx, id: string, forUpdate = false): Promise<InvoiceRow | undefined> {
    const q = tx.select().from(invoice).where(eq(invoice.id, id));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  async invoices(tx: Tx, limit = 60): Promise<InvoiceRow[]> {
    return tx.select().from(invoice).orderBy(desc(invoice.id)).limit(limit);
  }

  /** Invoices still to be paid of one subscription, oldest first. */
  async pendingInvoices(tx: Tx, subscriptionId: string): Promise<InvoiceRow[]> {
    return tx
      .select()
      .from(invoice)
      .where(and(eq(invoice.subscriptionId, subscriptionId), eq(invoice.status, "pending")))
      .orderBy(invoice.id);
  }

  /** Invoices of one subscription that still count (waiting, paid, or refused by Xendit), newest first. */
  async openInvoices(tx: Tx, subscriptionId: string): Promise<InvoiceRow[]> {
    return tx
      .select()
      .from(invoice)
      .where(and(eq(invoice.subscriptionId, subscriptionId), inArray(invoice.status, ["pending", "paid", "failed"])))
      .orderBy(desc(invoice.id));
  }

  async insertInvoice(tx: Tx, row: typeof invoice.$inferInsert): Promise<void> {
    await tx.insert(invoice).values(row);
  }

  async updateInvoice(tx: Tx, id: string, patch: Partial<typeof invoice.$inferInsert>): Promise<void> {
    await tx.update(invoice).set(patch).where(eq(invoice.id, id));
  }

  // ---- usage ----

  /** Adds to a month's counter, creating it at `by`; returns the counter as it stands. */
  async bumpUsage(tx: Tx, tenantId: string, id: string, metric: string, period: string, by: number): Promise<UsageRow> {
    const [row] = await tx
      .insert(usageCounter)
      .values({ id, tenantId, metric, period, value: by })
      .onConflictDoUpdate({
        target: [usageCounter.tenantId, usageCounter.metric, usageCounter.period],
        set: { value: sql`${usageCounter.value} + ${by}` },
      })
      .returning();
    return row!;
  }

  async usage(tx: Tx, metric: string, period: string): Promise<UsageRow | undefined> {
    const [row] = await tx
      .select()
      .from(usageCounter)
      .where(and(eq(usageCounter.metric, metric), eq(usageCounter.period, period)));
    return row;
  }

  async markWarned(tx: Tx, id: string, pct: number): Promise<void> {
    await tx.update(usageCounter).set({ warnedPct: pct }).where(eq(usageCounter.id, id));
  }

  async usageRows(tx: Tx): Promise<UsageRow[]> {
    return tx.select().from(usageCounter).orderBy(desc(usageCounter.period), usageCounter.metric);
  }
}
