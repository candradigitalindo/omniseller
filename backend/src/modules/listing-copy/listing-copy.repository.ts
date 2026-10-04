import { Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { categoryMapping, channelCategory, listingCopy, listingDraft } from "../../db/schema";

export type CategoryRow = typeof channelCategory.$inferSelect;
export type CategoryMappingRow = typeof categoryMapping.$inferSelect;
export type CopyRow = typeof listingCopy.$inferSelect;
export type DraftRow = typeof listingDraft.$inferSelect;

export interface CategoryInput {
  externalId: string;
  externalParentId: string | null;
  name: string;
  path: string;
  isLeaf: boolean;
  permitted: boolean;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Tables of copying listings (backend doc 8.25): category caches, category choices, copies, drafts. */
@Injectable()
export class ListingCopyRepository {
  // ---- channel_category ----

  async categories(
    tx: Tx,
    storeId: string,
    f: { parentId?: string | null | undefined; q?: string | undefined; leafOnly?: boolean | undefined },
    limit: number,
  ): Promise<CategoryRow[]> {
    const where: (SQL | undefined)[] = [eq(channelCategory.storeId, storeId)];
    if (f.q) where.push(ilike(channelCategory.path, `%${escapeLike(f.q)}%`));
    else if (f.parentId) where.push(eq(channelCategory.externalParentId, f.parentId));
    else if (!f.leafOnly) where.push(isNull(channelCategory.externalParentId));
    if (f.leafOnly) where.push(eq(channelCategory.isLeaf, true));
    return tx
      .select()
      .from(channelCategory)
      .where(and(...where))
      .orderBy(asc(channelCategory.path))
      .limit(limit);
  }

  async category(tx: Tx, storeId: string, externalId: string): Promise<CategoryRow | undefined> {
    const [row] = await tx
      .select()
      .from(channelCategory)
      .where(and(eq(channelCategory.storeId, storeId), eq(channelCategory.externalId, externalId)));
    return row;
  }

  async categoriesByIds(tx: Tx, storeId: string, ids: string[]): Promise<Map<string, CategoryRow>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await tx
      .select()
      .from(channelCategory)
      .where(and(eq(channelCategory.storeId, storeId), inArray(channelCategory.externalId, unique)));
    return new Map(rows.map((r) => [r.externalId, r]));
  }

  async upsertCategories(tx: Tx, tenantId: string, storeId: string, rows: CategoryInput[], seenAt: Date) {
    for (let i = 0; i < rows.length; i += 500) {
      await tx
        .insert(channelCategory)
        .values(rows.slice(i, i + 500).map((r) => ({ id: newId(), tenantId, storeId, ...r, seenAt })))
        .onConflictDoUpdate({
          target: [channelCategory.tenantId, channelCategory.storeId, channelCategory.externalId],
          set: {
            externalParentId: sql.raw("excluded.external_parent_id"),
            name: sql.raw("excluded.name"),
            path: sql.raw("excluded.path"),
            isLeaf: sql.raw("excluded.is_leaf"),
            permitted: sql.raw("excluded.permitted"),
            seenAt,
            updatedAt: seenAt,
            rowVersion: sql`${channelCategory.rowVersion} + 1`,
          },
        });
    }
  }

  async deleteUnseenCategories(tx: Tx, storeId: string, before: Date): Promise<number> {
    const r = await tx
      .delete(channelCategory)
      .where(and(eq(channelCategory.storeId, storeId), lt(channelCategory.seenAt, before)))
      .returning({ id: channelCategory.id });
    return r.length;
  }

  async saveRules(tx: Tx, storeId: string, externalId: string, rules: Record<string, unknown>, at: Date) {
    await tx
      .update(channelCategory)
      .set({ rules, rulesReadAt: at, updatedAt: at, rowVersion: sql`${channelCategory.rowVersion} + 1` })
      .where(and(eq(channelCategory.storeId, storeId), eq(channelCategory.externalId, externalId)));
  }

  /** How many categories a store has cached, and when they were last read. */
  async categoryStats(tx: Tx, storeId: string): Promise<{ count: number; refreshedAt: Date | null }> {
    const [row] = await tx
      .select({ n: count(), at: sql<string | null>`max(${channelCategory.seenAt})` })
      .from(channelCategory)
      .where(eq(channelCategory.storeId, storeId));
    return { count: row?.n ?? 0, refreshedAt: row?.at ? new Date(row.at) : null };
  }

  async deleteStoreCategories(tx: Tx, storeId: string, limit: number): Promise<number> {
    const batch = tx
      .select({ id: channelCategory.id })
      .from(channelCategory)
      .where(eq(channelCategory.storeId, storeId))
      .limit(limit);
    const r = await tx
      .delete(channelCategory)
      .where(inArray(channelCategory.id, batch))
      .returning({ id: channelCategory.id });
    return r.length;
  }

  // ---- category_mapping ----

  async mappingFor(
    tx: Tx,
    sourceChannel: string,
    sourceCategoryId: string,
    targetChannel: string,
  ): Promise<CategoryMappingRow | undefined> {
    const [row] = await tx
      .select()
      .from(categoryMapping)
      .where(
        and(
          eq(categoryMapping.sourceChannel, sourceChannel),
          eq(categoryMapping.externalSourceCategoryId, sourceCategoryId),
          eq(categoryMapping.targetChannel, targetChannel),
        ),
      );
    return row;
  }

  /** Remembers a choice; choosing the same category again counts it, another one replaces it. */
  async rememberMapping(
    tx: Tx,
    tenantId: string,
    m: {
      sourceChannel: string;
      externalSourceCategoryId: string;
      targetChannel: string;
      externalTargetCategoryId: string;
      targetCategoryPath: string | null;
    },
  ): Promise<void> {
    const now = new Date();
    await tx
      .insert(categoryMapping)
      .values({ id: newId(), tenantId, ...m, lastUsedAt: now })
      .onConflictDoUpdate({
        target: [
          categoryMapping.tenantId,
          categoryMapping.sourceChannel,
          categoryMapping.externalSourceCategoryId,
          categoryMapping.targetChannel,
        ],
        set: {
          uses: sql`CASE WHEN ${categoryMapping.externalTargetCategoryId} = excluded.external_target_category_id
                         THEN ${categoryMapping.uses} + 1 ELSE 1 END`,
          externalTargetCategoryId: sql.raw("excluded.external_target_category_id"),
          targetCategoryPath: sql.raw("excluded.target_category_path"),
          lastUsedAt: now,
          updatedAt: now,
          rowVersion: sql`${categoryMapping.rowVersion} + 1`,
        },
      });
  }

  async mappingsPage(tx: Tx, after: string | undefined, limit: number): Promise<CategoryMappingRow[]> {
    return tx
      .select()
      .from(categoryMapping)
      .where(after ? gt(categoryMapping.id, after) : undefined)
      .orderBy(asc(categoryMapping.id))
      .limit(limit);
  }

  // ---- listing_copy ----

  async insertCopies(tx: Tx, rows: (typeof listingCopy.$inferInsert)[]): Promise<void> {
    if (rows.length > 0) await tx.insert(listingCopy).values(rows);
  }

  async getCopy(tx: Tx, id: string, forUpdate = false): Promise<CopyRow | undefined> {
    const q = tx.select().from(listingCopy).where(eq(listingCopy.id, id));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  /** The copies one request made (one per target store): same creator, source, and transaction time. */
  async copiesMadeWith(tx: Tx, first: CopyRow): Promise<CopyRow[]> {
    return tx
      .select()
      .from(listingCopy)
      .where(
        and(
          eq(listingCopy.sourceStoreId, first.sourceStoreId),
          // compared in the database: created_at has microseconds, a JS Date only milliseconds
          sql`"listing_copy"."created_at" = (SELECT lc.created_at FROM listing_copy lc WHERE lc.id = ${first.id})`,
          first.createdBy ? eq(listingCopy.createdBy, first.createdBy) : isNull(listingCopy.createdBy),
        ),
      )
      .orderBy(asc(listingCopy.id));
  }

  async listCopies(
    tx: Tx,
    f: {
      targetStoreId?: string | undefined;
      sourceStoreId?: string | undefined;
      status?: string | undefined;
      scope: ReadonlySet<string> | null;
    },
    before: string | undefined,
    limit: number,
  ): Promise<CopyRow[]> {
    const scope = f.scope ? [...f.scope] : null;
    if (scope && scope.length === 0) return [];
    return tx
      .select()
      .from(listingCopy)
      .where(
        and(
          f.targetStoreId ? eq(listingCopy.targetStoreId, f.targetStoreId) : undefined,
          f.sourceStoreId ? eq(listingCopy.sourceStoreId, f.sourceStoreId) : undefined,
          f.status ? eq(listingCopy.status, f.status as CopyRow["status"]) : undefined,
          scope ? and(inArray(listingCopy.targetStoreId, scope), inArray(listingCopy.sourceStoreId, scope)) : undefined,
          before ? lt(listingCopy.id, before) : undefined,
        ),
      )
      .orderBy(desc(listingCopy.id))
      .limit(limit + 1);
  }

  async updateCopy(tx: Tx, id: string, patch: Partial<typeof listingCopy.$inferInsert>): Promise<void> {
    await tx
      .update(listingCopy)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${listingCopy.rowVersion} + 1` })
      .where(eq(listingCopy.id, id));
  }

  /** Drafts of each status per copy. */
  async draftCounts(tx: Tx, copyIds: string[]): Promise<Map<string, Record<string, number>>> {
    const out = new Map<string, Record<string, number>>();
    if (copyIds.length === 0) return out;
    const rows = await tx
      .select({ copyId: listingDraft.copyId, status: listingDraft.status, n: count() })
      .from(listingDraft)
      .where(inArray(listingDraft.copyId, copyIds))
      .groupBy(listingDraft.copyId, listingDraft.status);
    for (const r of rows) out.set(r.copyId, { ...(out.get(r.copyId) ?? {}), [r.status]: r.n });
    return out;
  }

  /** Deletes up to `limit` copies (with their drafts) from or to a store; returns how many. */
  async deleteStoreCopies(tx: Tx, storeId: string, limit: number): Promise<number> {
    const batch = tx
      .select({ id: listingCopy.id })
      .from(listingCopy)
      .where(or(eq(listingCopy.sourceStoreId, storeId), eq(listingCopy.targetStoreId, storeId)))
      .limit(limit);
    const r = await tx.delete(listingCopy).where(inArray(listingCopy.id, batch)).returning({ id: listingCopy.id });
    return r.length;
  }

  // ---- listing_draft ----

  /** Inserts a draft unless one for the same item still waits in that store; true when inserted. */
  async insertDraft(tx: Tx, row: typeof listingDraft.$inferInsert): Promise<boolean> {
    const r = await tx.insert(listingDraft).values(row).onConflictDoNothing().returning({ id: listingDraft.id });
    return r.length > 0;
  }

  async getDraft(tx: Tx, id: string, forUpdate = false): Promise<DraftRow | undefined> {
    const q = tx.select().from(listingDraft).where(eq(listingDraft.id, id));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  async draftsByIds(tx: Tx, ids: string[], forUpdate = false): Promise<DraftRow[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const q = tx.select().from(listingDraft).where(inArray(listingDraft.id, unique)).orderBy(asc(listingDraft.id));
    return forUpdate ? q.for("update") : q;
  }

  async listDrafts(
    tx: Tx,
    f: {
      copyId?: string | undefined;
      targetStoreId?: string | undefined;
      status?: string | undefined;
      q?: string | undefined;
      blocking?: boolean | undefined;
      scope: ReadonlySet<string> | null;
    },
    before: string | undefined,
    limit: number,
  ): Promise<DraftRow[]> {
    const scope = f.scope ? [...f.scope] : null;
    if (scope && scope.length === 0) return [];
    const blocking = sql`${listingDraft.problems} @> '[{"blocking": true}]'::jsonb`;
    return tx
      .select()
      .from(listingDraft)
      .where(
        and(
          f.copyId ? eq(listingDraft.copyId, f.copyId) : undefined,
          f.targetStoreId ? eq(listingDraft.targetStoreId, f.targetStoreId) : undefined,
          f.status ? eq(listingDraft.status, f.status as DraftRow["status"]) : undefined,
          f.q ? ilike(listingDraft.title, `%${escapeLike(f.q)}%`) : undefined,
          f.blocking === true ? blocking : f.blocking === false ? sql`NOT (${blocking})` : undefined,
          scope
            ? and(inArray(listingDraft.targetStoreId, scope), inArray(listingDraft.sourceStoreId, scope))
            : undefined,
          before ? lt(listingDraft.id, before) : undefined,
        ),
      )
      .orderBy(desc(listingDraft.id))
      .limit(limit + 1);
  }

  /** Writes a draft; with `expectedVersion`, only when nobody changed it since (If-Match). */
  async updateDraft(
    tx: Tx,
    id: string,
    patch: Partial<typeof listingDraft.$inferInsert>,
    expectedVersion?: number,
  ): Promise<boolean> {
    const r = await tx
      .update(listingDraft)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${listingDraft.rowVersion} + 1` })
      .where(
        and(
          eq(listingDraft.id, id),
          expectedVersion !== undefined ? eq(listingDraft.rowVersion, expectedVersion) : undefined,
        ),
      )
      .returning({ id: listingDraft.id });
    return r.length > 0;
  }

  /**
   * A publish run takes the draft: one run at a time, without holding a connection for the whole
   * publish. A claim older than `leaseMs` belongs to a run that stopped and may be taken over.
   */
  async claimPublish(tx: Tx, id: string, attempt: number, leaseMs: number): Promise<boolean> {
    const r = await tx
      .update(listingDraft)
      .set({ publishingStartedAt: new Date(), updatedAt: new Date(), rowVersion: sql`${listingDraft.rowVersion} + 1` })
      .where(
        and(
          eq(listingDraft.id, id),
          eq(listingDraft.status, "publishing"),
          eq(listingDraft.publishAttempt, attempt),
          or(
            isNull(listingDraft.publishingStartedAt),
            lt(listingDraft.publishingStartedAt, new Date(Date.now() - leaseMs)),
          ),
        ),
      )
      .returning({ id: listingDraft.id });
    return r.length > 0;
  }

  /** Gives the claim back, so the retry of a run that hit a temporary failure can take it at once. */
  async releasePublish(tx: Tx, id: string): Promise<void> {
    await tx
      .update(listingDraft)
      .set({ publishingStartedAt: null, updatedAt: new Date(), rowVersion: sql`${listingDraft.rowVersion} + 1` })
      .where(and(eq(listingDraft.id, id), eq(listingDraft.status, "publishing")));
  }

  async deleteDraft(tx: Tx, id: string): Promise<void> {
    await tx.delete(listingDraft).where(eq(listingDraft.id, id));
  }

  /** Source items with a draft still waiting (not published) in the target store. */
  async openDraftItems(tx: Tx, targetStoreId: string, sourceStoreId: string, itemIds: string[]): Promise<Set<string>> {
    if (itemIds.length === 0) return new Set();
    const rows = await tx
      .select({ itemId: listingDraft.externalSourceItemId })
      .from(listingDraft)
      .where(
        and(
          eq(listingDraft.targetStoreId, targetStoreId),
          eq(listingDraft.sourceStoreId, sourceStoreId),
          inArray(listingDraft.externalSourceItemId, itemIds),
          ne(listingDraft.status, "published"),
        ),
      );
    return new Set(rows.map((r) => r.itemId));
  }

  /** Source items already published to the target store, with the item each became. */
  async publishedItems(
    tx: Tx,
    targetStoreId: string,
    sourceStoreId: string,
    itemIds: string[],
  ): Promise<Map<string, string>> {
    if (itemIds.length === 0) return new Map();
    const rows = await tx
      .select({ itemId: listingDraft.externalSourceItemId, target: listingDraft.externalTargetItemId })
      .from(listingDraft)
      .where(
        and(
          eq(listingDraft.targetStoreId, targetStoreId),
          eq(listingDraft.sourceStoreId, sourceStoreId),
          inArray(listingDraft.externalSourceItemId, itemIds),
          eq(listingDraft.status, "published"),
        ),
      );
    return new Map(rows.map((r) => [r.itemId, r.target ?? ""]));
  }

  async draftsPage(tx: Tx, after: string | undefined, limit: number): Promise<DraftRow[]> {
    return tx
      .select()
      .from(listingDraft)
      .where(after ? gt(listingDraft.id, after) : undefined)
      .orderBy(asc(listingDraft.id))
      .limit(limit);
  }
}
