import { Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
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

  /**
   * FR-INT-08, locked for the caller's job: stores whose connection has been down since `downSince` and
   * nobody was told yet (authorization lost, or marketplace calls failing), and stores whose announced
   * outage is over. Manual sales channels and disconnected stores have no connection to watch.
   */
  async connectionChangesIn(tx: Tx, downSince: Date): Promise<StoreRow[]> {
    return tx
      .select()
      .from(store)
      .where(
        and(
          ne(store.channel, "manual"),
          ne(store.status, "disconnected"),
          or(
            and(
              isNull(store.connectionAlertAt),
              or(
                and(eq(store.status, "reauth_required"), lte(store.statusChangedAt, downSince)),
                and(inArray(store.status, ["active", "token_expiring"]), lte(store.failingSince, downSince)),
              ),
            ),
            and(
              isNotNull(store.connectionAlertAt),
              inArray(store.status, ["active", "token_expiring"]),
              isNull(store.failingSince),
            ),
          ),
        ),
      )
      .orderBy(asc(store.id))
      .for("update");
  }

  async storeIdsWithStatus(tx: Tx, status: StoreRow["status"]): Promise<string[]> {
    const rows = await tx.select({ id: store.id }).from(store).where(eq(store.status, status));
    return rows.map((r) => r.id);
  }

  /** Starts (`failing`) or ends an outage of a store's marketplace calls; a no-op when nothing changes. */
  async markFailing(tx: Tx, storeId: string, failing: boolean): Promise<void> {
    await tx
      .update(store)
      .set({ failingSince: failing ? new Date() : null })
      .where(and(eq(store.id, storeId), failing ? isNull(store.failingSince) : isNotNull(store.failingSince)));
  }

  /** Stores in the caller's scope; those whose data was deleted (FR-INT-07) only when asked for. */
  async listStores(tx: Tx, scope: ReadonlySet<string> | null, includeDeleted = false): Promise<StoreRow[]> {
    if (scope && scope.size === 0) return [];
    return tx
      .select()
      .from(store)
      .where(
        and(
          scope ? inArray(store.id, [...scope]) : undefined,
          includeDeleted ? undefined : isNull(store.dataDeletionRequestedAt),
        ),
      )
      .orderBy(store.channel, store.name);
  }

  async getStore(tx: Tx, id: string, forUpdate = false): Promise<StoreRow | undefined> {
    const q = tx.select().from(store).where(eq(store.id, id));
    const [row] = forUpdate ? await q.for("update") : await q;
    return row;
  }

  /**
   * This tenant's store for a marketplace shop that a new authorization reconnects: the one in use, else
   * the last one disconnected with its data kept. A store whose data was deleted is never reused.
   */
  async storeByExternalId(tx: Tx, channel: string, externalShopId: string): Promise<StoreRow | undefined> {
    const [row] = await tx
      .select()
      .from(store)
      .where(
        and(
          eq(store.channel, channel as StoreRow["channel"]),
          eq(store.externalShopId, externalShopId),
          isNull(store.dataDeletionRequestedAt),
        ),
      )
      .orderBy(sql`${store.status} = 'disconnected'`, desc(store.statusChangedAt))
      .limit(1)
      .for("update");
    return row;
  }

  /**
   * Which tenant holds a marketplace shop, across tenants, through the SECURITY DEFINER lookup
   * resolve_store (backend doc 7.5): only one store per shop may be in use (unique index), so a shop in
   * use by another tenant must be detected before inserting, without being able to read that tenant. A
   * shop whose stores are all disconnected is held by nobody (FR-INT-07).
   */
  async shopOwner(
    tx: Tx,
    channel: string,
    externalShopId: string,
  ): Promise<{ tenantId: string; storeId: string } | null> {
    const r = await tx.execute<{ tenant_id: string; store_id: string; status: string }>(
      sql`SELECT tenant_id, store_id, status FROM resolve_store(${channel}, ${externalShopId})`,
    );
    const row = r.rows[0];
    return row && row.status !== "disconnected" ? { tenantId: row.tenant_id, storeId: row.store_id } : null;
  }

  /** The first manual sales channel still in use, in the caller's scope (null scope: every store). */
  async firstManualStore(tx: Tx, scope: ReadonlySet<string> | null): Promise<StoreRow | undefined> {
    if (scope && scope.size === 0) return undefined;
    const [row] = await tx
      .select()
      .from(store)
      .where(
        and(
          eq(store.channel, "manual"),
          ne(store.status, "disconnected"),
          scope ? inArray(store.id, [...scope]) : undefined,
        ),
      )
      .orderBy(asc(store.id))
      .limit(1);
    return row;
  }

  /** Stores that use a warehouse: as their default warehouse, or through a marketplace warehouse mapped to it. */
  async warehouseUsage(
    tx: Tx,
    warehouseId: string,
  ): Promise<{
    defaults: { id: string; name: string }[];
    mappings: { storeId: string; storeName: string; name: string }[];
  }> {
    const defaults = await tx
      .select({ id: store.id, name: store.name })
      .from(store)
      .where(eq(store.defaultWarehouseId, warehouseId))
      .orderBy(store.name);
    const mappings = await tx
      .select({ storeId: channelWarehouse.storeId, storeName: store.name, name: channelWarehouse.name })
      .from(channelWarehouse)
      .innerJoin(store, eq(store.id, channelWarehouse.storeId))
      .where(eq(channelWarehouse.warehouseId, warehouseId))
      .orderBy(store.name, channelWarehouse.name);
    return { defaults, mappings };
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

  /** Every marketplace warehouse of the tenant, by name (the audit log). */
  async channelWarehouseNames(tx: Tx): Promise<{ id: string; name: string }[]> {
    return tx.select({ id: channelWarehouse.id, name: channelWarehouse.name }).from(channelWarehouse);
  }

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

  /** FR-INT-07: a store's marketplace warehouses and sync cursors go; its row stays. */
  async deleteStoreMarketplaceData(tx: Tx, storeId: string): Promise<void> {
    await tx.delete(channelWarehouse).where(eq(channelWarehouse.storeId, storeId));
    await tx.delete(syncCursor).where(eq(syncCursor.storeId, storeId));
  }
}
