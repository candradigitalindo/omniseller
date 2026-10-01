import { Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import {
  channelWarehouse,
  type StoreAuthorizationStatus,
  store,
  storeAuthorization,
  storeCredential,
  syncCursor,
} from "../../db/schema";

export type StoreRow = typeof store.$inferSelect;
export type StoreAuthorizationRow = typeof storeAuthorization.$inferSelect;
export type CredentialRow = typeof storeCredential.$inferSelect;
export type ChannelWarehouseRow = typeof channelWarehouse.$inferSelect;

/** Credential columns omniseller_api may read (backend doc 7.5): expiry metadata, never tokens. */
const credentialMeta = {
  storeId: storeCredential.storeId,
  accessExpiresAt: storeCredential.accessExpiresAt,
  refreshExpiresAt: storeCredential.refreshExpiresAt,
  lastRefreshedAt: storeCredential.lastRefreshedAt,
  refreshFailCount: storeCredential.refreshFailCount,
  scopes: storeCredential.scopes,
};
export type CredentialMeta = {
  storeId: string;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  lastRefreshedAt: Date | null;
  refreshFailCount: number;
  scopes: string[];
};

/** Tables owned by the channel module (backend doc 11): store, store_credential, channel_warehouse, store_authorization. */
@Injectable()
export class ChannelRepository {
  // ---- store_authorization ----

  async insertAuthorization(tx: Tx, row: typeof storeAuthorization.$inferInsert): Promise<void> {
    await tx.insert(storeAuthorization).values(row);
  }

  async authorizationByStateHash(
    tx: Tx,
    stateHash: string,
    forUpdate = false,
  ): Promise<StoreAuthorizationRow | undefined> {
    const q = tx.select().from(storeAuthorization).where(eq(storeAuthorization.stateHash, stateHash));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  async getAuthorization(tx: Tx, id: string, forUpdate = false): Promise<StoreAuthorizationRow | undefined> {
    const q = tx.select().from(storeAuthorization).where(eq(storeAuthorization.id, id));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  async updateAuthorization(
    tx: Tx,
    id: string,
    patch: Partial<{
      status: StoreAuthorizationStatus;
      callbackAt: Date;
      completedAt: Date;
      result: Record<string, unknown>;
      errorCode: string | null;
      errorMessage: string | null;
    }>,
  ): Promise<void> {
    await tx
      .update(storeAuthorization)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${storeAuthorization.rowVersion} + 1` })
      .where(eq(storeAuthorization.id, id));
  }

  // ---- store ----

  async listStores(tx: Tx, scope: ReadonlySet<string> | null): Promise<StoreRow[]> {
    const where = scope ? inArray(store.id, [...scope]) : undefined;
    if (scope && scope.size === 0) return [];
    return tx.select().from(store).where(where).orderBy(store.channel, store.name);
  }

  async getStore(tx: Tx, id: string, forUpdate = false): Promise<StoreRow | undefined> {
    const q = tx.select().from(store).where(eq(store.id, id));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  async storeByExternalId(tx: Tx, channel: string, externalShopId: string): Promise<StoreRow | undefined> {
    const [row] = await tx
      .select()
      .from(store)
      .where(and(eq(store.channel, channel as StoreRow["channel"]), eq(store.externalShopId, externalShopId)))
      .for("update");
    return row;
  }

  /**
   * Which tenant owns a marketplace shop, across tenants, through the SECURITY DEFINER lookup
   * resolve_store (backend doc 7.5): the unique (channel, external_shop_id) is global, so a shop owned
   * by another tenant must be detected before inserting, without being able to read that tenant.
   */
  async shopOwner(
    tx: Tx,
    channel: string,
    externalShopId: string,
  ): Promise<{ tenantId: string; storeId: string } | null> {
    const r = await tx.execute<{ tenant_id: string; store_id: string }>(
      sql`SELECT tenant_id, store_id FROM resolve_store(${channel}, ${externalShopId})`,
    );
    const row = r.rows[0];
    return row ? { tenantId: row.tenant_id, storeId: row.store_id } : null;
  }

  async insertStore(tx: Tx, row: typeof store.$inferInsert): Promise<void> {
    await tx.insert(store).values(row);
  }

  async updateStore(
    tx: Tx,
    id: string,
    patch: Partial<typeof store.$inferInsert>,
    expectedRowVersion?: number,
  ): Promise<boolean> {
    const where =
      expectedRowVersion === undefined
        ? eq(store.id, id)
        : and(eq(store.id, id), eq(store.rowVersion, expectedRowVersion));
    const res = await tx
      .update(store)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${store.rowVersion} + 1` })
      .where(where)
      .returning({ id: store.id });
    return res.length > 0;
  }

  // ---- store_credential ----

  async credentialMeta(tx: Tx, storeIds: string[]): Promise<Map<string, CredentialMeta>> {
    if (storeIds.length === 0) return new Map();
    const rows = await tx
      .select(credentialMeta)
      .from(storeCredential)
      .where(inArray(storeCredential.storeId, storeIds));
    return new Map(rows.map((r) => [r.storeId, r]));
  }

  /** Worker only: the full row, locked, for a refresh or a token read that may refresh. */
  async credentialForUpdate(tx: Tx, storeId: string): Promise<CredentialRow | undefined> {
    const [row] = await tx.select().from(storeCredential).where(eq(storeCredential.storeId, storeId)).for("update");
    return row;
  }

  async credential(tx: Tx, storeId: string): Promise<CredentialRow | undefined> {
    const [row] = await tx.select().from(storeCredential).where(eq(storeCredential.storeId, storeId));
    return row;
  }

  async upsertCredential(
    tx: Tx,
    tenantId: string,
    storeId: string,
    values: Omit<typeof storeCredential.$inferInsert, "id" | "tenantId" | "storeId">,
  ): Promise<void> {
    await tx
      .insert(storeCredential)
      .values({ id: newId(), tenantId, storeId, ...values })
      .onConflictDoUpdate({
        target: storeCredential.storeId,
        set: { ...values, updatedAt: new Date(), rowVersion: sql`${storeCredential.rowVersion} + 1` },
      });
  }

  async updateCredential(tx: Tx, storeId: string, patch: Partial<typeof storeCredential.$inferInsert>): Promise<void> {
    await tx
      .update(storeCredential)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${storeCredential.rowVersion} + 1` })
      .where(eq(storeCredential.storeId, storeId));
  }

  async deleteCredential(tx: Tx, storeId: string): Promise<void> {
    await tx.delete(storeCredential).where(eq(storeCredential.storeId, storeId));
  }

  // ---- sync_cursor ----

  async syncCursor(tx: Tx, storeId: string, resource: string): Promise<string | null> {
    const [row] = await tx
      .select({ cursor: syncCursor.cursor })
      .from(syncCursor)
      .where(and(eq(syncCursor.storeId, storeId), eq(syncCursor.resource, resource)));
    return row?.cursor ?? null;
  }

  async advanceSyncCursor(tx: Tx, tenantId: string, storeId: string, resource: string, cursor: string): Promise<void> {
    const now = new Date();
    await tx
      .insert(syncCursor)
      .values({ id: newId(), tenantId, storeId, resource, cursor, advancedAt: now })
      .onConflictDoUpdate({
        target: [syncCursor.storeId, syncCursor.resource],
        set: { cursor, advancedAt: now, updatedAt: now, rowVersion: sql`${syncCursor.rowVersion} + 1` },
      });
  }

  // ---- channel_warehouse ----

  async channelWarehouses(tx: Tx, storeId: string): Promise<ChannelWarehouseRow[]> {
    return tx
      .select()
      .from(channelWarehouse)
      .where(eq(channelWarehouse.storeId, storeId))
      .orderBy(desc(channelWarehouse.active), channelWarehouse.kind, channelWarehouse.name);
  }

  async getChannelWarehouse(tx: Tx, storeId: string, id: string, forUpdate = false) {
    const q = tx
      .select()
      .from(channelWarehouse)
      .where(and(eq(channelWarehouse.storeId, storeId), eq(channelWarehouse.id, id)));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  async insertChannelWarehouse(tx: Tx, row: typeof channelWarehouse.$inferInsert): Promise<void> {
    await tx.insert(channelWarehouse).values(row);
  }

  async updateChannelWarehouse(
    tx: Tx,
    id: string,
    patch: Partial<typeof channelWarehouse.$inferInsert>,
  ): Promise<void> {
    await tx
      .update(channelWarehouse)
      .set({ ...patch, updatedAt: new Date(), rowVersion: sql`${channelWarehouse.rowVersion} + 1` })
      .where(eq(channelWarehouse.id, id));
  }

  /** Active seller warehouses without a mapping: stock sync stays off while any exists (FR-WHS-04). */
  async unmappedCount(tx: Tx, storeId: string): Promise<number> {
    const [row] = await tx
      .select({ n: count() })
      .from(channelWarehouse)
      .where(
        and(
          eq(channelWarehouse.storeId, storeId),
          eq(channelWarehouse.active, true),
          eq(channelWarehouse.kind, "seller"),
          eq(channelWarehouse.mappingStatus, "unmapped"),
        ),
      );
    return Number(row?.n ?? 0);
  }
}
