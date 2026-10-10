import { Injectable } from "@nestjs/common";
import { newId, type ReturnRequestKind, type ReturnRequestStatus } from "@omniseller/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Tx } from "../../db/client";
import { returnItem, returnRequest } from "../../db/schema";
import type { PlannedItem } from "./return-plan";

export type ReturnRow = typeof returnRequest.$inferSelect;
export type ReturnItemRow = typeof returnItem.$inferSelect;

const FINAL: ReturnRequestStatus[] = ["refunded", "cancelled", "closed"];

/** Kinds of the three tabs of the returns screen (L09). */
export type ReturnGroup = "returns" | "cancellations" | "rto";
const MARKETPLACE_RETURNS: ReturnRequestKind[] = ["return_refund", "refund_only", "replacement", "exchange"];

export interface ReturnListFilter {
  group?: ReturnGroup | undefined;
  status?: ReturnRequestStatus | undefined;
  /** Requests still waiting for the seller's decision. */
  awaitingDecision?: boolean | undefined;
  /** Goods expected back and not received yet. */
  toReceive?: boolean | undefined;
  storeId?: string | undefined;
  warehouseId?: string | undefined;
  orderId?: string | undefined;
  storeScope: string[] | null;
  warehouseScope: string[] | null;
  hiddenStoreIds: string[];
}

/**
 * The seller waits on the request now, as `awaitsSeller` in the service decides it for one row: an
 * open marketplace request asking for a decision (or with a deadline running), not answered for its
 * current marketplace status, and no answer on its way.
 */
const AWAITING = and(
  ne(returnRequest.kind, "rto"),
  notInArray(returnRequest.status, FINAL),
  sql`${returnRequest.responseStatus} IS DISTINCT FROM 'pending'`,
  or(eq(returnRequest.status, "requested"), isNotNull(returnRequest.respondByAt)),
  or(
    sql`${returnRequest.decidedFor} IS DISTINCT FROM ${returnRequest.externalStatus}`,
    eq(returnRequest.responseStatus, "failed"),
  ),
);

function groupKinds(group: ReturnGroup): ReturnRequestKind[] {
  if (group === "cancellations") return ["cancellation"];
  if (group === "rto") return ["rto"];
  return MARKETPLACE_RETURNS;
}

/** return_request and return_item (backend doc 8.26). */
@Injectable()
export class ReturnsRepository {
  async get(tx: Tx, id: string, forUpdate = false): Promise<ReturnRow | undefined> {
    const q = tx.select().from(returnRequest).where(eq(returnRequest.id, id));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  async getMany(tx: Tx, ids: string[]): Promise<ReturnRow[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    return tx.select().from(returnRequest).where(inArray(returnRequest.id, unique)).orderBy(asc(returnRequest.id));
  }

  /** Requests of a store by marketplace id, cancellations and returns apart (their ids never meet). */
  async byExternal(
    tx: Tx,
    storeId: string,
    cancellation: boolean,
    externalIds: string[],
    forUpdate = false,
  ): Promise<Map<string, ReturnRow>> {
    const unique = [...new Set(externalIds.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const q = tx
      .select()
      .from(returnRequest)
      .where(
        and(
          eq(returnRequest.storeId, storeId),
          inArray(returnRequest.externalReturnId, unique),
          cancellation ? eq(returnRequest.kind, "cancellation") : ne(returnRequest.kind, "cancellation"),
        ),
      )
      .orderBy(asc(returnRequest.id));
    const rows = forUpdate ? await q.for("update") : await q;
    return new Map(rows.map((r) => [r.externalReturnId!, r]));
  }

  async rtoOf(tx: Tx, orderId: string): Promise<ReturnRow | undefined> {
    const [row] = await tx
      .select()
      .from(returnRequest)
      .where(and(eq(returnRequest.orderId, orderId), eq(returnRequest.kind, "rto")));
    return row;
  }

  async forOrder(tx: Tx, orderId: string): Promise<ReturnRow[]> {
    return tx.select().from(returnRequest).where(eq(returnRequest.orderId, orderId)).orderBy(desc(returnRequest.id));
  }

  async insert(tx: Tx, row: typeof returnRequest.$inferInsert): Promise<ReturnRow> {
    const [out] = await tx.insert(returnRequest).values(row).returning();
    return out!;
  }

  async update(tx: Tx, id: string, patch: Partial<typeof returnRequest.$inferInsert>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await tx.update(returnRequest).set(patch).where(eq(returnRequest.id, id));
  }

  /** Writes the outcome of one sent decision, only while that attempt is still pending. */
  async settleResponse(
    tx: Tx,
    id: string,
    attempt: number,
    patch: Partial<typeof returnRequest.$inferInsert>,
  ): Promise<boolean> {
    const rows = await tx
      .update(returnRequest)
      .set(patch)
      .where(
        and(
          eq(returnRequest.id, id),
          eq(returnRequest.responseStatus, "pending"),
          eq(returnRequest.responseAttempt, attempt),
        ),
      )
      .returning({ id: returnRequest.id });
    return rows.length > 0;
  }

  /** The request of each return line (stock card references, 8.13). */
  async itemRequests(
    tx: Tx,
    itemIds: string[],
  ): Promise<{ itemId: string; id: string; orderId: string; storeId: string; warehouseId: string | null }[]> {
    if (itemIds.length === 0) return [];
    return tx
      .select({
        itemId: returnItem.id,
        id: returnRequest.id,
        orderId: returnRequest.orderId,
        storeId: returnRequest.storeId,
        warehouseId: returnRequest.warehouseId,
      })
      .from(returnItem)
      .innerJoin(returnRequest, eq(returnRequest.id, returnItem.returnRequestId))
      .where(inArray(returnItem.id, itemIds));
  }

  async items(tx: Tx, requestIds: string[]): Promise<ReturnItemRow[]> {
    const unique = [...new Set(requestIds)];
    if (unique.length === 0) return [];
    return tx
      .select()
      .from(returnItem)
      .where(inArray(returnItem.returnRequestId, unique))
      .orderBy(asc(returnItem.returnRequestId), asc(returnItem.id));
  }

  async replaceItems(tx: Tx, tenantId: string, requestId: string, planned: PlannedItem[]): Promise<void> {
    await tx.delete(returnItem).where(eq(returnItem.returnRequestId, requestId));
    if (planned.length === 0) return;
    await tx.insert(returnItem).values(
      planned.map((p) => ({
        id: newId(),
        tenantId,
        returnRequestId: requestId,
        orderItemId: p.orderItemId,
        externalItemId: p.externalItemId,
        externalVariantId: p.externalVariantId,
        sku: p.sku,
        title: p.title,
        qty: p.qty,
        refundAmount: p.refundAmount,
      })),
    );
  }

  async updateItem(tx: Tx, id: string, patch: Partial<typeof returnItem.$inferInsert>): Promise<void> {
    await tx.update(returnItem).set(patch).where(eq(returnItem.id, id));
  }

  private where(f: ReturnListFilter): SQL | undefined {
    const conditions: (SQL | undefined)[] = [
      f.group ? inArray(returnRequest.kind, groupKinds(f.group)) : undefined,
      f.status ? eq(returnRequest.status, f.status) : undefined,
      f.awaitingDecision ? AWAITING : undefined,
      f.toReceive
        ? and(
            eq(returnRequest.goodsReturn, true),
            isNull(returnRequest.receivedAt),
            ne(returnRequest.status, "cancelled"),
          )
        : undefined,
      f.storeId ? eq(returnRequest.storeId, f.storeId) : undefined,
      f.warehouseId ? eq(returnRequest.warehouseId, f.warehouseId) : undefined,
      f.orderId ? eq(returnRequest.orderId, f.orderId) : undefined,
      f.storeScope ? inArray(returnRequest.storeId, f.storeScope) : undefined,
      f.warehouseScope ? inArray(returnRequest.warehouseId, f.warehouseScope) : undefined,
      f.hiddenStoreIds.length > 0 ? notInArray(returnRequest.storeId, f.hiddenStoreIds) : undefined,
    ];
    return and(...conditions);
  }

  async list(tx: Tx, f: ReturnListFilter, before: string | undefined, limit: number): Promise<ReturnRow[]> {
    if ((f.storeScope && f.storeScope.length === 0) || (f.warehouseScope && f.warehouseScope.length === 0)) return [];
    return tx
      .select()
      .from(returnRequest)
      .where(and(this.where(f), before ? lt(returnRequest.id, before) : undefined))
      .orderBy(desc(returnRequest.id))
      .limit(limit + 1);
  }

  /** Counters of the returns screen's tabs (L09). */
  async summary(tx: Tx, f: ReturnListFilter, dueBefore: Date) {
    if ((f.storeScope && f.storeScope.length === 0) || (f.warehouseScope && f.warehouseScope.length === 0)) {
      return { awaitingDecision: 0, dueSoon: 0, toReceive: 0, cancellations: 0, rto: 0, failedResponses: 0 };
    }
    const scope = this.where({ ...f, group: undefined, status: undefined, awaitingDecision: false, toReceive: false });
    const waiting = AWAITING;
    const [row] = await tx
      .select({
        awaitingDecision: sql<number>`count(*) FILTER (WHERE ${waiting})`.mapWith(Number),
        dueSoon:
          sql<number>`count(*) FILTER (WHERE ${and(waiting, isNotNull(returnRequest.respondByAt), lte(returnRequest.respondByAt, dueBefore))})`.mapWith(
            Number,
          ),
        toReceive:
          sql<number>`count(*) FILTER (WHERE ${and(eq(returnRequest.goodsReturn, true), isNull(returnRequest.receivedAt), ne(returnRequest.status, "cancelled"))})`.mapWith(
            Number,
          ),
        cancellations:
          sql<number>`count(*) FILTER (WHERE ${and(eq(returnRequest.kind, "cancellation"), eq(returnRequest.status, "requested"))})`.mapWith(
            Number,
          ),
        rto: sql<number>`count(*) FILTER (WHERE ${and(eq(returnRequest.kind, "rto"), isNull(returnRequest.receivedAt))})`.mapWith(
          Number,
        ),
        failedResponses: sql<number>`count(*) FILTER (WHERE ${eq(returnRequest.responseStatus, "failed")})`.mapWith(
          Number,
        ),
      })
      .from(returnRequest)
      .where(scope);
    return row!;
  }

  /** Open cancellation requests of a store, oldest change first, to read again. */
  async openCancellations(tx: Tx, storeId: string, limit: number): Promise<ReturnRow[]> {
    return tx
      .select()
      .from(returnRequest)
      .where(
        and(
          eq(returnRequest.storeId, storeId),
          eq(returnRequest.kind, "cancellation"),
          notInArray(returnRequest.status, FINAL),
        ),
      )
      .orderBy(asc(returnRequest.updatedAt))
      .limit(limit);
  }

  /**
   * Claims open marketplace requests of a store whose decisions were read for another marketplace
   * status, and that no other job is reading (claims older than `staleBefore` are taken over).
   */
  async claimStaleDecisions(
    tx: Tx,
    storeId: string,
    limit: number,
    now: Date,
    staleBefore: Date,
  ): Promise<ReturnRow[]> {
    const ids = await tx
      .select({ id: returnRequest.id })
      .from(returnRequest)
      .where(
        and(
          eq(returnRequest.storeId, storeId),
          ne(returnRequest.kind, "rto"),
          notInArray(returnRequest.status, FINAL),
          sql`${returnRequest.decisionsFor} IS DISTINCT FROM ${returnRequest.externalStatus}`,
          or(isNull(returnRequest.responseStatus), ne(returnRequest.responseStatus, "pending")),
          or(isNull(returnRequest.decisionsClaimedAt), lt(returnRequest.decisionsClaimedAt, staleBefore)),
        ),
      )
      .orderBy(asc(returnRequest.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (ids.length === 0) return [];
    return tx
      .update(returnRequest)
      .set({ decisionsClaimedAt: now })
      .where(
        inArray(
          returnRequest.id,
          ids.map((r) => r.id),
        ),
      )
      .returning();
  }

  /** New requests not announced yet (FR-NTF), oldest first; marked announced in the same transaction. */
  async pendingNotices(tx: Tx, limit: number): Promise<ReturnRow[]> {
    return tx
      .select()
      .from(returnRequest)
      .where(eq(returnRequest.notifyNew, true))
      .orderBy(asc(returnRequest.id))
      .limit(limit)
      .for("update", { skipLocked: true });
  }

  async clearNotices(tx: Tx, ids: string[]): Promise<void> {
    if (ids.length > 0) await tx.update(returnRequest).set({ notifyNew: false }).where(inArray(returnRequest.id, ids));
  }

  /** Requests still waiting for the seller whose deadline is before `until` and not alerted yet. */
  async dueUnalerted(tx: Tx, until: Date, limit: number): Promise<ReturnRow[]> {
    return tx
      .select()
      .from(returnRequest)
      .where(
        and(
          AWAITING,
          isNull(returnRequest.dueAlertedAt),
          isNotNull(returnRequest.respondByAt),
          lte(returnRequest.respondByAt, until),
        ),
      )
      .orderBy(asc(returnRequest.respondByAt))
      .limit(limit)
      .for("update", { skipLocked: true });
  }

  async markDueAlerted(tx: Tx, ids: string[], at: Date): Promise<void> {
    if (ids.length > 0) await tx.update(returnRequest).set({ dueAlertedAt: at }).where(inArray(returnRequest.id, ids));
  }

  /**
   * The buyer's part of these orders' requests emptied (backend doc 8.34): the reason they wrote and their
   * photos, and the seller's photos (which may show the parcel's label). Returns the seller photos' files.
   */
  async clearBuyerData(tx: Tx, orderIds: string[]): Promise<string[]> {
    if (orderIds.length === 0) return [];
    const rows = await tx
      .select({ id: returnRequest.id, sellerEvidence: returnRequest.sellerEvidence })
      .from(returnRequest)
      .where(inArray(returnRequest.orderId, orderIds));
    if (rows.length === 0) return [];
    await tx
      .update(returnRequest)
      .set({ reason: null, evidence: [], sellerEvidence: [] })
      .where(
        inArray(
          returnRequest.id,
          rows.map((r) => r.id),
        ),
      );
    return rows.flatMap((r) => r.sellerEvidence.map((f) => f.fileId));
  }

  /** FR-INT-07: a batch of a store's requests, their items with them (cascade). */
  async deleteStoreRequests(tx: Tx, storeId: string, limit: number): Promise<number> {
    const rows = await tx
      .select({ id: returnRequest.id })
      .from(returnRequest)
      .where(eq(returnRequest.storeId, storeId))
      .orderBy(asc(returnRequest.id))
      .limit(limit);
    if (rows.length === 0) return 0;
    await tx.delete(returnRequest).where(
      inArray(
        returnRequest.id,
        rows.map((r) => r.id),
      ),
    );
    return rows.length;
  }

  // ---- full data export (FR-MIG-09) ----

  async page(tx: Tx, after: string | undefined, limit: number): Promise<ReturnRow[]> {
    return tx
      .select()
      .from(returnRequest)
      .where(after ? gt(returnRequest.id, after) : undefined)
      .orderBy(asc(returnRequest.id))
      .limit(limit);
  }

  async itemsPage(tx: Tx, after: string | undefined, limit: number): Promise<ReturnItemRow[]> {
    return tx
      .select()
      .from(returnItem)
      .where(after ? gt(returnItem.id, after) : undefined)
      .orderBy(asc(returnItem.id))
      .limit(limit);
  }

  async count(tx: Tx): Promise<number> {
    const [row] = await tx.select({ n: count() }).from(returnRequest);
    return row?.n ?? 0;
  }
}
