import { Injectable } from "@nestjs/common";
import type { StockCountStatus, StockTransferStatus } from "@omniseller/shared";
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import {
  catalogVariantV,
  inventory,
  stockCount,
  stockCountLine,
  stockTransfer,
  stockTransferLine,
} from "../../db/schema";

export type StockCountRow = typeof stockCount.$inferSelect;
export type StockCountLineRow = typeof stockCountLine.$inferSelect;
export type StockTransferRow = typeof stockTransfer.$inferSelect;
export type StockTransferLineRow = typeof stockTransferLine.$inferSelect;

/** Tabs of the counting screen: every line, not counted yet, counted, counted with a difference. */
export type CountLineFilter = "all" | "uncounted" | "counted" | "differences";

export interface CountStats {
  lines: number;
  counted: number;
  /** Counted lines whose count differs from the system's quantity. */
  differences: number;
  /** Lines found on the shelf during the count, not on the list. */
  added: number;
}

/** A count line with the units of open orders at its warehouse now, for the review screen. */
export interface CountLineDetail {
  line: StockCountLineRow;
  /** Units of open orders in this warehouse now: still on hand, possibly packed and off the shelf. */
  reserved: number;
}

/** A variant as a count line keeps it: what the catalog said when the line was listed or found. */
export interface VariantSnapshot {
  variantId: string;
  sku: string;
  productName: string;
  variantName: string;
  barcode: string | null;
}

/** A variant a new count lists, with the system's quantity now. */
export interface CountCandidate extends VariantSnapshot {
  onHand: number;
  binLocation: string | null;
}

/** A variant as the catalog's view shows it now. */
export interface VariantInfo extends VariantSnapshot {
  active: boolean;
  costPrice: number;
}

const OPEN_COUNT: StockCountStatus[] = ["counting", "review"];
const OPEN_TRANSFER: StockTransferStatus[] = ["draft", "sent"];
/** Rows per insert, and ids per lookup by key. */
const CHUNK = 1_000;

const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");

/** Rack by rack (lines without a rack last), then SKU: the order a counter walks the warehouse. */
function walkingOrder(a: CountCandidate, b: CountCandidate): number {
  if (a.binLocation !== b.binLocation) {
    if (a.binLocation === null) return 1;
    if (b.binLocation === null) return -1;
    const byBin = a.binLocation.localeCompare(b.binLocation);
    if (byBin !== 0) return byBin;
  }
  return a.sku.localeCompare(b.sku) || (a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0);
}

const LINE_FILTERS: Record<CountLineFilter, SQL | undefined> = {
  all: undefined,
  uncounted: isNull(stockCountLine.countedQty),
  counted: isNotNull(stockCountLine.countedQty),
  differences: ne(stockCountLine.diff, 0),
};

/**
 * Stock counts and transfers (backend doc 8.27). Quantities still change only through InventoryService
 * (apply_stock_movement); these tables hold the documents: what was counted, approved, sent, received.
 *
 * Every query here reads one table, and other tables by key (`IN` lists of ids), never a join of
 * inventory or count lines with the catalog's view: right after a bulk import, before autovacuum has
 * analyzed the new rows, the planner misjudged such a join into a nested loop over every row of the
 * warehouse per variant (7 seconds for 12,000 SKUs, past the 5-second statement timeout). Count lines
 * keep the variant's SKU, names, barcode, and rack for the same reason.
 */
@Injectable()
export class StockOpsRepository {
  // ---- stock counts ----

  async insertCount(tx: Tx, row: typeof stockCount.$inferInsert): Promise<StockCountRow> {
    const [created] = await tx.insert(stockCount).values(row).returning();
    return created!;
  }

  /** `share` keeps the status still while counters record lines; `update` is for status changes. */
  async count(tx: Tx, id: string, lock?: "share" | "update"): Promise<StockCountRow | undefined> {
    const q = tx.select().from(stockCount).where(eq(stockCount.id, id));
    const [row] = lock ? await q.for(lock) : await q;
    return row;
  }

  async openCountOf(tx: Tx, warehouseId: string): Promise<StockCountRow | undefined> {
    const [row] = await tx
      .select()
      .from(stockCount)
      .where(and(eq(stockCount.warehouseId, warehouseId), inArray(stockCount.status, OPEN_COUNT)));
    return row;
  }

  async updateCount(tx: Tx, id: string, patch: Partial<typeof stockCount.$inferInsert>): Promise<StockCountRow> {
    const [row] = await tx.update(stockCount).set(patch).where(eq(stockCount.id, id)).returning();
    return row!;
  }

  /** Newest first, in the given warehouses (null: every warehouse). */
  async listCounts(
    tx: Tx,
    f: { warehouseIds: string[] | null; status?: StockCountStatus | undefined },
    before: string | undefined,
    limit: number,
  ): Promise<StockCountRow[]> {
    if (f.warehouseIds?.length === 0) return [];
    return tx
      .select()
      .from(stockCount)
      .where(
        and(
          f.warehouseIds ? inArray(stockCount.warehouseId, f.warehouseIds) : undefined,
          f.status ? eq(stockCount.status, f.status) : undefined,
          before ? lt(stockCount.id, before) : undefined,
        ),
      )
      .orderBy(desc(stockCount.id))
      .limit(limit + 1);
  }

  async countStats(tx: Tx, ids: string[]): Promise<Map<string, CountStats>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({
        id: stockCountLine.stockCountId,
        lines: sql<number>`count(*)::int`,
        counted: sql<number>`count(${stockCountLine.countedQty})::int`,
        differences: sql<number>`(count(*) FILTER (WHERE ${stockCountLine.diff} <> 0))::int`,
        added: sql<number>`(count(*) FILTER (WHERE ${stockCountLine.added}))::int`,
      })
      .from(stockCountLine)
      .where(inArray(stockCountLine.stockCountId, ids))
      .groupBy(stockCountLine.stockCountId);
    return new Map(
      rows.map((r) => [r.id, { lines: r.lines, counted: r.counted, differences: r.differences, added: r.added }]),
    );
  }

  /** Units found over and under the system's quantity, and their value at today's cost price. */
  async countDifference(tx: Tx, id: string): Promise<{ unitsOver: number; unitsUnder: number; value: number }> {
    const l = stockCountLine;
    const differing = await tx
      .select({ variantId: l.variantId, diff: l.diff })
      .from(l)
      .where(and(eq(l.stockCountId, id), ne(l.diff, 0)));
    const cost = await this.variantInfo(
      tx,
      differing.map((d) => d.variantId),
    );
    let unitsOver = 0;
    let unitsUnder = 0;
    let value = 0;
    for (const d of differing) {
      const diff = d.diff ?? 0;
      if (diff > 0) unitsOver += diff;
      else unitsUnder -= diff;
      value += diff * (cost.get(d.variantId)?.costPrice ?? 0);
    }
    return { unitsOver, unitsUnder, value };
  }

  /**
   * Variants a new count lists, in walking order (rack, then SKU), at most `limit`. Full: every row the
   * warehouse has for a live variant, and for an archived one still on hand. Partial: the given variants
   * (listed even without a row) and the rows whose rack starts with `binPrefix`. Deleted variants never.
   */
  async countCandidates(
    tx: Tx,
    warehouseId: string,
    sel: { full: true } | { variantIds: string[]; binPrefix: string | undefined },
    limit: number,
  ): Promise<CountCandidate[]> {
    const shelf = (cond: SQL | undefined) =>
      tx
        .select({ variantId: inventory.variantId, onHand: inventory.onHand, binLocation: inventory.binLocation })
        .from(inventory)
        .where(and(eq(inventory.warehouseId, warehouseId), cond));
    let rows: { variantId: string; onHand: number; binLocation: string | null }[];
    if ("full" in sel) {
      rows = await shelf(undefined);
    } else {
      rows = sel.binPrefix ? await shelf(ilike(inventory.binLocation, `${escapeLike(sel.binPrefix)}%`)) : [];
      const listed = new Set(rows.map((r) => r.variantId));
      const chosen = [...new Set(sel.variantIds)].filter((id) => !listed.has(id));
      const held = new Map<string, { variantId: string; onHand: number; binLocation: string | null }>();
      for (let i = 0; i < chosen.length; i += CHUNK) {
        for (const r of await shelf(inArray(inventory.variantId, chosen.slice(i, i + CHUNK)))) held.set(r.variantId, r);
      }
      rows.push(...chosen.map((id) => held.get(id) ?? { variantId: id, onHand: 0, binLocation: null }));
    }
    const info = await this.variantInfo(
      tx,
      rows.map((r) => r.variantId),
    );
    const out: CountCandidate[] = [];
    for (const r of rows) {
      const v = info.get(r.variantId);
      if (!v || ("full" in sel && !v.active && r.onHand === 0)) continue;
      out.push({
        variantId: v.variantId,
        sku: v.sku,
        productName: v.productName,
        variantName: v.variantName,
        barcode: v.barcode,
        onHand: r.onHand,
        binLocation: r.binLocation,
      });
    }
    return out.sort(walkingOrder).slice(0, limit);
  }

  /** Variants by id from the catalog's view, a key lookup per chunk; deleted variants are missing. */
  async variantInfo(tx: Tx, ids: string[]): Promise<Map<string, VariantInfo>> {
    const v = catalogVariantV;
    const unique = [...new Set(ids)];
    const out = new Map<string, VariantInfo>();
    for (let i = 0; i < unique.length; i += CHUNK) {
      const rows = await tx
        .select({
          variantId: v.variantId,
          sku: v.sku,
          productName: v.productName,
          variantName: v.variantName,
          barcode: v.barcode,
          variantStatus: v.variantStatus,
          productStatus: v.productStatus,
          costPrice: v.costPrice,
        })
        .from(v)
        .where(inArray(v.variantId, unique.slice(i, i + CHUNK)));
      for (const r of rows) {
        out.set(r.variantId, {
          variantId: r.variantId,
          sku: r.sku,
          productName: r.productName,
          variantName: r.variantName,
          barcode: r.barcode,
          active: r.variantStatus === "active" && r.productStatus === "active",
          costPrice: r.costPrice,
        });
      }
    }
    return out;
  }

  async insertCountLines(tx: Tx, rows: (typeof stockCountLine.$inferInsert)[]): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) await tx.insert(stockCountLine).values(rows.slice(i, i + CHUNK));
  }

  /**
   * The variant a scanner read, by the rule of the catalog's lookup (FR-PRD-12): its barcode exactly, or
   * else its SKU ignoring case and spaces at the ends when only one variant has it.
   */
  async variantByCode(tx: Tx, code: string): Promise<{ variantId: string; matchedBy: "barcode" | "sku" } | null> {
    const v = catalogVariantV;
    const [byBarcode] = await tx.select({ id: v.variantId }).from(v).where(eq(v.barcode, code)).limit(1);
    if (byBarcode) return { variantId: byBarcode.id, matchedBy: "barcode" };
    const norm = code.trim().toLowerCase();
    if (!norm) return null;
    const bySku = await tx
      .select({ id: v.variantId })
      .from(v)
      .where(eq(sql`lower(btrim(${v.sku}))`, norm))
      .limit(2);
    return bySku.length === 1 ? { variantId: bySku[0]!.id, matchedBy: "sku" } : null;
  }

  /** On hand, rack, and units of open orders now, per variant in the warehouse. */
  async shelfOf(
    tx: Tx,
    warehouseId: string,
    variantIds: string[],
  ): Promise<Map<string, { onHand: number; binLocation: string | null; reserved: number }>> {
    const unique = [...new Set(variantIds)];
    const out = new Map<string, { onHand: number; binLocation: string | null; reserved: number }>();
    for (let i = 0; i < unique.length; i += CHUNK) {
      const rows = await tx
        .select({
          variantId: inventory.variantId,
          onHand: inventory.onHand,
          binLocation: inventory.binLocation,
          reserved: inventory.reserved,
        })
        .from(inventory)
        .where(and(eq(inventory.warehouseId, warehouseId), inArray(inventory.variantId, unique.slice(i, i + CHUNK))));
      for (const r of rows)
        out.set(r.variantId, { onHand: r.onHand, binLocation: r.binLocation, reserved: r.reserved });
    }
    return out;
  }

  /**
   * Records a count of one variant. `set` replaces what was counted and takes the system's quantity of
   * this moment as expected; `add` adds scanned units, and takes the expected quantity at the line's
   * first count. A variant not on the list joins it as an added line, with the catalog's names of now.
   * One statement, so two counters scanning the same shelf add up instead of overwriting each other.
   */
  async recordCount(
    tx: Tx,
    e: {
      id: string;
      tenantId: string;
      stockCountId: string;
      variant: VariantSnapshot;
      binLocation: string | null;
      qty: number;
      mode: "set" | "add";
      onHand: number;
      userId: string | null;
    },
  ): Promise<StockCountLineRow> {
    const l = stockCountLine;
    const counted =
      e.mode === "set" ? sql`excluded.counted_qty` : sql`coalesce(${l.countedQty}, 0) + excluded.counted_qty`;
    const expected =
      e.mode === "set"
        ? sql`excluded.expected_qty`
        : sql`CASE WHEN ${l.countedQty} IS NULL THEN excluded.expected_qty ELSE ${l.expectedQty} END`;
    const [row] = await tx
      .insert(l)
      .values({
        id: e.id,
        tenantId: e.tenantId,
        stockCountId: e.stockCountId,
        variantId: e.variant.variantId,
        sku: e.variant.sku,
        productName: e.variant.productName,
        variantName: e.variant.variantName,
        barcode: e.variant.barcode,
        binLocation: e.binLocation,
        expectedQty: e.onHand,
        countedQty: e.qty,
        countedAt: new Date(),
        countedBy: e.userId,
        added: true,
      })
      .onConflictDoUpdate({
        target: [l.stockCountId, l.variantId],
        set: {
          countedQty: counted,
          expectedQty: expected,
          countedAt: sql`excluded.counted_at`,
          countedBy: sql`excluded.counted_by`,
        },
      })
      .returning();
    return row!;
  }

  /**
   * Lines in walking order (by id), with the units of open orders at the warehouse now; `after` is the
   * last line seen. `q` looks in the line's SKU, product name, and rack, or is its barcode.
   */
  async countLines(
    tx: Tx,
    c: { id: string; warehouseId: string },
    f: { filter: CountLineFilter; q?: string | undefined; lineIds?: string[] },
    after: string | undefined,
    limit: number,
  ): Promise<CountLineDetail[]> {
    const l = stockCountLine;
    const q = f.q?.trim();
    const like = q ? `%${escapeLike(q)}%` : null;
    const rows = await tx
      .select()
      .from(l)
      .where(
        and(
          eq(l.stockCountId, c.id),
          LINE_FILTERS[f.filter],
          f.lineIds ? inArray(l.id, f.lineIds) : undefined,
          like
            ? or(ilike(l.sku, like), ilike(l.productName, like), ilike(l.binLocation, like), eq(l.barcode, q!))
            : undefined,
          after ? gt(l.id, after) : undefined,
        ),
      )
      .orderBy(asc(l.id))
      .limit(limit + 1);
    const shelf = await this.shelfOf(
      tx,
      c.warehouseId,
      rows.map((r) => r.variantId),
    );
    return rows.map((line) => ({ line, reserved: shelf.get(line.variantId)?.reserved ?? 0 }));
  }

  /**
   * The next lines a count's approval moves, in variant order (the order stock rows are locked in):
   * counted lines, and with `zeroUncounted` the uncounted ones too, not applied yet.
   */
  async linesToApply(tx: Tx, countId: string, zeroUncounted: boolean, limit: number): Promise<StockCountLineRow[]> {
    return tx
      .select()
      .from(stockCountLine)
      .where(
        and(
          eq(stockCountLine.stockCountId, countId),
          isNull(stockCountLine.appliedDelta),
          zeroUncounted ? undefined : isNotNull(stockCountLine.countedQty),
        ),
      )
      .orderBy(asc(stockCountLine.variantId))
      .limit(limit);
  }

  /**
   * What applying did per line: the move, and the expected quantity it was measured against. A line
   * not counted is recorded as counted none at this moment.
   */
  async markApplied(tx: Tx, applied: { id: string; delta: number; expected: number }[]): Promise<void> {
    if (applied.length === 0) return;
    const values = sql.join(
      applied.map((a) => sql`(${a.id}, ${a.delta}::bigint, ${a.expected}::bigint)`),
      sql`, `,
    );
    await tx.execute(sql`
      UPDATE stock_count_line l
         SET applied_delta = v.delta, expected_qty = v.expected,
             counted_qty = coalesce(l.counted_qty, 0), counted_at = coalesce(l.counted_at, now())
        FROM (VALUES ${values}) AS v(id, delta, expected)
       WHERE l.id = v.id`);
  }

  // ---- stock transfers ----

  async insertTransfer(tx: Tx, row: typeof stockTransfer.$inferInsert): Promise<void> {
    await tx.insert(stockTransfer).values(row);
  }

  async transfer(tx: Tx, id: string, lock = false): Promise<StockTransferRow | undefined> {
    const q = tx.select().from(stockTransfer).where(eq(stockTransfer.id, id));
    const [row] = lock ? await q.for("update") : await q;
    return row;
  }

  /** False when `expectedRowVersion` no longer matches (8.8). */
  async updateTransfer(
    tx: Tx,
    id: string,
    patch: Partial<typeof stockTransfer.$inferInsert>,
    expectedRowVersion?: number,
  ): Promise<boolean> {
    const r = await tx
      .update(stockTransfer)
      .set(patch)
      .where(
        and(
          eq(stockTransfer.id, id),
          expectedRowVersion === undefined ? undefined : eq(stockTransfer.rowVersion, expectedRowVersion),
        ),
      )
      .returning({ id: stockTransfer.id });
    return r.length > 0;
  }

  /**
   * Newest first. A transfer is listed for the caller when either warehouse is in `warehouseIds` (null:
   * every warehouse); `warehouseId` narrows to transfers leaving or reaching that one.
   */
  async listTransfers(
    tx: Tx,
    f: {
      warehouseIds: string[] | null;
      status?: StockTransferStatus | undefined;
      warehouseId?: string | undefined;
      direction?: "out" | "in" | undefined;
    },
    before: string | undefined,
    limit: number,
  ): Promise<StockTransferRow[]> {
    const t = stockTransfer;
    if (f.warehouseIds?.length === 0) return [];
    const side = (w: string) =>
      f.direction === "out"
        ? eq(t.fromWarehouseId, w)
        : f.direction === "in"
          ? eq(t.toWarehouseId, w)
          : or(eq(t.fromWarehouseId, w), eq(t.toWarehouseId, w));
    return tx
      .select()
      .from(t)
      .where(
        and(
          f.warehouseIds
            ? f.direction === "out"
              ? inArray(t.fromWarehouseId, f.warehouseIds)
              : f.direction === "in"
                ? inArray(t.toWarehouseId, f.warehouseIds)
                : or(inArray(t.fromWarehouseId, f.warehouseIds), inArray(t.toWarehouseId, f.warehouseIds))
            : undefined,
          f.warehouseId ? side(f.warehouseId) : undefined,
          f.status ? eq(t.status, f.status) : undefined,
          before ? lt(t.id, before) : undefined,
        ),
      )
      .orderBy(desc(t.id))
      .limit(limit + 1);
  }

  /** The stock count of each count line (stock card references, 8.13). */
  async countsOfLines(tx: Tx, lineIds: string[]): Promise<{ lineId: string; id: string; number: string }[]> {
    if (lineIds.length === 0) return [];
    return tx
      .select({ lineId: stockCountLine.id, id: stockCount.id, number: stockCount.number })
      .from(stockCountLine)
      .innerJoin(stockCount, eq(stockCount.id, stockCountLine.stockCountId))
      .where(inArray(stockCountLine.id, lineIds));
  }

  /** The transfer of each transfer line (stock card references, 8.13). */
  async transfersOfLines(tx: Tx, lineIds: string[]): Promise<{ lineId: string; id: string; number: string }[]> {
    if (lineIds.length === 0) return [];
    return tx
      .select({ lineId: stockTransferLine.id, id: stockTransfer.id, number: stockTransfer.number })
      .from(stockTransferLine)
      .innerJoin(stockTransfer, eq(stockTransfer.id, stockTransferLine.stockTransferId))
      .where(inArray(stockTransferLine.id, lineIds));
  }

  async transferLines(tx: Tx, transferIds: string[]): Promise<StockTransferLineRow[]> {
    if (transferIds.length === 0) return [];
    return tx
      .select()
      .from(stockTransferLine)
      .where(inArray(stockTransferLine.stockTransferId, transferIds))
      .orderBy(asc(stockTransferLine.stockTransferId), asc(stockTransferLine.id));
  }

  /** A draft's lines replaced as a whole. */
  async replaceTransferLines(
    tx: Tx,
    tenantId: string,
    transferId: string,
    lines: { id: string; variantId: string; qty: number }[],
  ): Promise<void> {
    await tx.delete(stockTransferLine).where(eq(stockTransferLine.stockTransferId, transferId));
    if (lines.length === 0) return;
    await tx
      .insert(stockTransferLine)
      .values(
        lines.map((l) => ({ id: l.id, tenantId, stockTransferId: transferId, variantId: l.variantId, qty: l.qty })),
      );
  }

  async setReceived(tx: Tx, received: Map<string, number>): Promise<void> {
    for (const [id, qty] of received) {
      await tx.update(stockTransferLine).set({ receivedQty: qty }).where(eq(stockTransferLine.id, id));
    }
  }

  // ---- warehouses ----

  /** Counts and transfers not finished that involve the warehouse: it cannot be deleted while they last. */
  async openDocumentsIn(tx: Tx, warehouseId: string): Promise<{ counts: number; transfers: number }> {
    const [c] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(stockCount)
      .where(and(eq(stockCount.warehouseId, warehouseId), inArray(stockCount.status, OPEN_COUNT)));
    const [t] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(stockTransfer)
      .where(
        and(
          or(eq(stockTransfer.fromWarehouseId, warehouseId), eq(stockTransfer.toWarehouseId, warehouseId)),
          inArray(stockTransfer.status, OPEN_TRANSFER),
        ),
      );
    return { counts: c?.n ?? 0, transfers: t?.n ?? 0 };
  }

  // ---- full data export (FR-MIG-09): keyset pages in id order ----

  async countsPage(tx: Tx, after: string | undefined, limit: number): Promise<StockCountRow[]> {
    return tx
      .select()
      .from(stockCount)
      .where(after ? gt(stockCount.id, after) : undefined)
      .orderBy(asc(stockCount.id))
      .limit(limit);
  }

  /** A page of count lines with their count's number. */
  async countLinesPage(tx: Tx, after: string | undefined, limit: number) {
    const rows = await tx
      .select()
      .from(stockCountLine)
      .where(after ? gt(stockCountLine.id, after) : undefined)
      .orderBy(asc(stockCountLine.id))
      .limit(limit);
    const ids = [...new Set(rows.map((r) => r.stockCountId))];
    const numbers = new Map(
      ids.length === 0
        ? []
        : (
            await tx
              .select({ id: stockCount.id, number: stockCount.number })
              .from(stockCount)
              .where(inArray(stockCount.id, ids))
          ).map((r) => [r.id, r.number]),
    );
    return rows.map((r) => ({ ...r, number: numbers.get(r.stockCountId) ?? null }));
  }

  async transfersPage(tx: Tx, after: string | undefined, limit: number): Promise<StockTransferRow[]> {
    return tx
      .select()
      .from(stockTransfer)
      .where(after ? gt(stockTransfer.id, after) : undefined)
      .orderBy(asc(stockTransfer.id))
      .limit(limit);
  }

  /** A page of transfer lines with their transfer's number and the variant's names. */
  async transferLinesPage(tx: Tx, after: string | undefined, limit: number) {
    const rows = await tx
      .select()
      .from(stockTransferLine)
      .where(after ? gt(stockTransferLine.id, after) : undefined)
      .orderBy(asc(stockTransferLine.id))
      .limit(limit);
    const ids = [...new Set(rows.map((r) => r.stockTransferId))];
    const numbers = new Map(
      ids.length === 0
        ? []
        : (
            await tx
              .select({ id: stockTransfer.id, number: stockTransfer.number })
              .from(stockTransfer)
              .where(inArray(stockTransfer.id, ids))
          ).map((r) => [r.id, r.number]),
    );
    const variants = await this.variantInfo(
      tx,
      rows.map((r) => r.variantId),
    );
    return rows.map((r) => {
      const v = variants.get(r.variantId);
      return {
        ...r,
        number: numbers.get(r.stockTransferId) ?? null,
        sku: v?.sku ?? null,
        productName: v?.productName ?? null,
        variantName: v?.variantName ?? null,
      };
    });
  }
}
