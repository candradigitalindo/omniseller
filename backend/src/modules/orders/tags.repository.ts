import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { orderTag, tag } from "../../db/schema";

export type TagRow = typeof tag.$inferSelect;

/** A tag on an order, as order lists show it. */
export interface OrderTagRef {
  orderId: string;
  id: string;
  name: string;
  color: string | null;
}

/** `tag` and `order_tag`, owned by the orders module (backend doc 7.8.6, 11). Deleted tags are hidden. */
@Injectable()
export class TagsRepository {
  async list(tx: Tx): Promise<(TagRow & { orders: number })[]> {
    const rows = await tx
      .select({
        tag,
        // fully qualified: inside the subquery a bare "id" would be order_tag's own column
        orders: sql<number>`(SELECT count(*)::int FROM order_tag t WHERE t.tag_id = ${sql.raw('"tag"."id"')})`,
      })
      .from(tag)
      .where(isNull(tag.deletedAt))
      .orderBy(sql`lower(${tag.name})`);
    return rows.map((r) => ({ ...r.tag, orders: r.orders }));
  }

  async get(tx: Tx, id: string, forUpdate = false): Promise<TagRow | undefined> {
    const q = tx
      .select()
      .from(tag)
      .where(and(eq(tag.id, id), isNull(tag.deletedAt)));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  async byIds(tx: Tx, ids: string[]): Promise<TagRow[]> {
    if (ids.length === 0) return [];
    return tx
      .select()
      .from(tag)
      .where(and(inArray(tag.id, ids), isNull(tag.deletedAt)));
  }

  async countLive(tx: Tx): Promise<number> {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(tag).where(isNull(tag.deletedAt));
    return r?.n ?? 0;
  }

  /** Names compare without case and surrounding spaces, like the unique index. */
  async nameTaken(tx: Tx, name: string, exceptId?: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: tag.id })
      .from(tag)
      .where(
        and(
          isNull(tag.deletedAt),
          sql`lower(btrim(${tag.name})) = lower(btrim(${name}))`,
          exceptId ? ne(tag.id, exceptId) : undefined,
        ),
      );
    return !!row;
  }

  async insert(tx: Tx, row: typeof tag.$inferInsert): Promise<void> {
    await tx.insert(tag).values(row);
  }

  async update(tx: Tx, id: string, patch: Partial<typeof tag.$inferInsert>): Promise<void> {
    await tx
      .update(tag)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${tag.rowVersion} + 1` })
      .where(eq(tag.id, id));
  }

  /** Takes the tag off every order, then hides it; its name can be used again. */
  async softDelete(tx: Tx, id: string): Promise<void> {
    await tx.delete(orderTag).where(eq(orderTag.tagId, id));
    await this.update(tx, id, { deletedAt: new Date() });
  }

  async ofOrders(tx: Tx, orderIds: string[]): Promise<OrderTagRef[]> {
    if (orderIds.length === 0) return [];
    return tx
      .select({ orderId: orderTag.orderId, id: tag.id, name: tag.name, color: tag.color })
      .from(orderTag)
      .innerJoin(tag, and(eq(tag.tenantId, orderTag.tenantId), eq(tag.id, orderTag.tagId)))
      .where(and(inArray(orderTag.orderId, orderIds), isNull(tag.deletedAt)))
      .orderBy(asc(orderTag.orderId), sql`lower(${tag.name})`);
  }

  /** Pairs that were not there yet. */
  async add(tx: Tx, rows: (typeof orderTag.$inferInsert)[]): Promise<{ orderId: string; tagId: string }[]> {
    if (rows.length === 0) return [];
    return tx
      .insert(orderTag)
      .values(rows)
      .onConflictDoNothing({ target: [orderTag.orderId, orderTag.tagId] })
      .returning({ orderId: orderTag.orderId, tagId: orderTag.tagId });
  }

  /** Pairs that were there. */
  async remove(tx: Tx, orderIds: string[], tagIds: string[]): Promise<{ orderId: string; tagId: string }[]> {
    if (orderIds.length === 0 || tagIds.length === 0) return [];
    return tx
      .delete(orderTag)
      .where(and(inArray(orderTag.orderId, orderIds), inArray(orderTag.tagId, tagIds)))
      .returning({ orderId: orderTag.orderId, tagId: orderTag.tagId });
  }
}
