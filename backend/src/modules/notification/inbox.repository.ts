import { Injectable } from "@nestjs/common";
import { and, count, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { notification } from "../../db/schema";

export type NotificationRow = typeof notification.$inferSelect;

/** A recipient's notifications: addressed to them, or to every user of the tenant. */
const mine = (userId: string) => or(eq(notification.userId, userId), isNull(notification.userId));

@Injectable()
export class InboxRepository {
  async insertMany(tx: Tx, rows: (typeof notification.$inferInsert)[]): Promise<void> {
    if (rows.length > 0) await tx.insert(notification).values(rows);
  }

  async list(tx: Tx, userId: string, unreadOnly: boolean, before: string | undefined, limit: number) {
    return tx
      .select()
      .from(notification)
      .where(
        and(
          mine(userId),
          unreadOnly ? isNull(notification.readAt) : undefined,
          before ? lt(notification.id, before) : undefined,
        ),
      )
      .orderBy(desc(notification.id))
      .limit(limit + 1);
  }

  async unreadCount(tx: Tx, userId: string): Promise<number> {
    const [r] = await tx
      .select({ n: count() })
      .from(notification)
      .where(and(mine(userId), isNull(notification.readAt)));
    return Number(r?.n ?? 0);
  }

  /** Marks the user's own notifications read; ids of other users' notifications are ignored. */
  async markRead(tx: Tx, userId: string, ids: string[] | null): Promise<number> {
    const r = await tx
      .update(notification)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notification.userId, userId),
          isNull(notification.readAt),
          ids ? inArray(notification.id, ids) : undefined,
        ),
      )
      .returning({ id: notification.id });
    return r.length;
  }
}
