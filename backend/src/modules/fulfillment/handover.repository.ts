import { Injectable } from "@nestjs/common";
import type { HandoverStatus } from "@omniseller/shared";
import { and, asc, count, desc, eq, gt, inArray, lt, ne, type SQL, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { handover, handoverItem } from "../../db/schema";

export type HandoverRow = typeof handover.$inferSelect;
export type HandoverItemRow = typeof handoverItem.$inferSelect;

/** Courier handover manifests and their parcels (FR-SHP-05, backend doc 8.24). */
@Injectable()
export class HandoverRepository {
  /** Undefined when another request just opened the same warehouse and courier (the partial unique index). */
  async insert(tx: Tx, row: typeof handover.$inferInsert): Promise<HandoverRow | undefined> {
    const [r] = await tx.insert(handover).values(row).onConflictDoNothing().returning();
    return r;
  }

  /** The open manifest of this warehouse and courier (courier names without case). */
  async openFor(tx: Tx, warehouseId: string, courier: string): Promise<HandoverRow | undefined> {
    const [r] = await tx
      .select()
      .from(handover)
      .where(
        and(
          eq(handover.warehouseId, warehouseId),
          eq(handover.status, "open"),
          sql`lower(${handover.courier}) = lower(${courier})`,
        ),
      );
    return r;
  }

  async get(tx: Tx, id: string, forUpdate = false): Promise<HandoverRow | undefined> {
    const q = tx.select().from(handover).where(eq(handover.id, id));
    const [r] = forUpdate ? await q.for("update") : await q;
    return r;
  }

  async update(tx: Tx, id: string, patch: Partial<typeof handover.$inferInsert>): Promise<HandoverRow> {
    const [r] = await tx.update(handover).set(patch).where(eq(handover.id, id)).returning();
    return r!;
  }

  /** Manifests newest first (UI L08 "Riwayat manifest"); `warehouseIds` null: every warehouse. */
  async page(
    tx: Tx,
    f: { status?: HandoverStatus | undefined; warehouseIds: string[] | null },
    before: string | undefined,
    limit: number,
  ): Promise<HandoverRow[]> {
    if (f.warehouseIds?.length === 0) return [];
    const where: (SQL | undefined)[] = [
      f.status ? eq(handover.status, f.status) : undefined,
      f.warehouseIds ? inArray(handover.warehouseId, f.warehouseIds) : undefined,
      before ? lt(handover.id, before) : undefined,
    ];
    return tx
      .select()
      .from(handover)
      .where(and(...where))
      .orderBy(desc(handover.id))
      .limit(limit + 1);
  }

  async items(tx: Tx, handoverId: string): Promise<HandoverItemRow[]> {
    return tx.select().from(handoverItem).where(eq(handoverItem.handoverId, handoverId)).orderBy(asc(handoverItem.id));
  }

  async itemCounts(tx: Tx, handoverIds: string[]): Promise<Map<string, number>> {
    if (handoverIds.length === 0) return new Map();
    const rows = await tx
      .select({ id: handoverItem.handoverId, n: count() })
      .from(handoverItem)
      .where(inArray(handoverItem.handoverId, handoverIds))
      .groupBy(handoverItem.handoverId);
    return new Map(rows.map((r) => [r.id, Number(r.n)]));
  }

  /** Where this order already is in an open manifest other than `exceptId`. */
  async openElsewhere(tx: Tx, orderId: string, exceptId: string): Promise<HandoverRow | undefined> {
    const [r] = await tx
      .select({ h: handover })
      .from(handoverItem)
      .innerJoin(handover, eq(handover.id, handoverItem.handoverId))
      .where(and(eq(handoverItem.orderId, orderId), eq(handover.status, "open"), ne(handover.id, exceptId)))
      .limit(1);
    return r?.h;
  }

  async itemOf(tx: Tx, handoverId: string, orderId: string): Promise<HandoverItemRow | undefined> {
    const [r] = await tx
      .select()
      .from(handoverItem)
      .where(and(eq(handoverItem.handoverId, handoverId), eq(handoverItem.orderId, orderId)));
    return r;
  }

  async insertItem(tx: Tx, row: typeof handoverItem.$inferInsert): Promise<HandoverItemRow> {
    const [r] = await tx.insert(handoverItem).values(row).returning();
    return r!;
  }

  /** False when the item is not in this manifest. */
  async deleteItem(tx: Tx, handoverId: string, itemId: string): Promise<boolean> {
    const rows = await tx
      .delete(handoverItem)
      .where(and(eq(handoverItem.id, itemId), eq(handoverItem.handoverId, handoverId)))
      .returning({ id: handoverItem.id });
    return rows.length > 0;
  }

  /** Parcels of every manifest in id order with their manifest (full data export, FR-MIG-09). */
  async exportPage(
    tx: Tx,
    after: string | undefined,
    limit: number,
  ): Promise<{ id: string; item: HandoverItemRow; h: HandoverRow }[]> {
    const rows = await tx
      .select({ item: handoverItem, h: handover })
      .from(handoverItem)
      .innerJoin(handover, eq(handover.id, handoverItem.handoverId))
      .where(after ? gt(handoverItem.id, after) : undefined)
      .orderBy(asc(handoverItem.id))
      .limit(limit);
    return rows.map((r) => ({ id: r.item.id, ...r }));
  }
}
