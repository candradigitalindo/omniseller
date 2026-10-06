import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import { ConflictError } from "../../common/errors/domain-errors";
import { type ExportSheet, singlePage } from "../../common/export-sheet";
import { ENV } from "../../config/config.module";
import type { Env } from "../../config/env.schema";
import type { DbHandle, Tx } from "../../db/client";
import type { StoreStatus } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { WarehousesService } from "../inventory/warehouses.service";
import {
  channelWarehouseNotFound,
  manualStoreNotFound,
  marketplaceManagedWarehouse,
  STORE_STATUS_REASONS,
  type StoreStatusReason,
  storeAlreadyDisconnected,
  storeIsManual,
  storeNotActive,
  storeNotFound,
  storeUnmappedWarehouses,
  warehouseNotFound,
} from "./channel.errors";
import {
  channelWarehouseMappingChanged,
  storeAuthorizationExpiring,
  storeDataDeletionRequested,
  storeDisconnected,
  storeReauthRequired,
  storeSyncModeChanged,
  storeWarehousesSyncRequested,
} from "./channel.events";
import { ChannelRepository, type ChannelWarehouseRow, type CredentialMeta, type StoreRow } from "./channel.repository";
import { CONNECTORS, type ConnectorRegistry, isSupportedChannel, MANIFESTS } from "./connector-registry";

/** A store shows "token_expiring" this long before the seller's authorization ends (FR-INT-03). */
export const AUTH_EXPIRY_WARNING_DAYS = 14;
const USABLE: StoreStatus[] = ["active", "token_expiring"];

export interface StoreView {
  store: StoreRow;
  credential: CredentialMeta | null;
  unmappedWarehouses: number;
}

/** What the stock pusher needs about a store (backend doc 9.4). */
export interface StockTarget {
  store: StoreRow;
  /** active or token_expiring */
  usable: boolean;
  maxStockQuantity: number | null;
  warehouses: ChannelWarehouseRow[];
}

/** Orders taken outside marketplaces (WhatsApp, Instagram, a shop counter) live in stores of this channel. */
export const MANUAL_CHANNEL = "manual";
export const isManualChannel = (channel: string): boolean => channel === MANUAL_CHANNEL;

export function channelDisplayName(channel: string): string {
  if (isManualChannel(channel)) return "Manual";
  return isSupportedChannel(channel) ? MANIFESTS[channel].displayName : channel;
}

export function statusMessage(reason: string | null): string | null {
  return reason && reason in STORE_STATUS_REASONS ? STORE_STATUS_REASONS[reason as StoreStatusReason] : null;
}

/** Origin of the web app in processes that have it (api, worker). */
export function publicWebUrl(env: Env): string {
  return "PUBLIC_WEB_URL" in env ? env.PUBLIC_WEB_URL : "";
}

/** active or token_expiring, from when the seller's authorization ends. */
export function usableStatus(authorizationExpiresAt: Date | null, now = new Date()): "active" | "token_expiring" {
  if (!authorizationExpiresAt) return "active";
  const warnFrom = authorizationExpiresAt.getTime() - AUTH_EXPIRY_WARNING_DAYS * 86_400_000;
  return now.getTime() >= warnFrom ? "token_expiring" : "active";
}

/**
 * Connected stores (backend doc 7.8.2, PRD 6.1): what sellers see and change, and the status changes
 * that webhooks and token refreshes cause. Every read respects the caller's store scope: a store
 * outside it does not exist for that user.
 */
@Injectable()
export class StoresService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ChannelRepository) private readonly repo: ChannelRepository,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(CONNECTORS) private readonly connectors: ConnectorRegistry,
    @Inject(ENV) private readonly env: Env,
  ) {}

  inScope(ctx: RequestContext, storeId: string): boolean {
    return ctx.storeScope === null || ctx.storeScope.has(storeId);
  }

  private async load(tx: Tx, ctx: RequestContext, id: string, forUpdate = false): Promise<StoreRow> {
    if (!this.inScope(ctx, id)) throw storeNotFound();
    const store = await this.repo.getStore(tx, id, forUpdate);
    if (!store) throw storeNotFound();
    return store;
  }

  private async view(tx: Tx, stores: StoreRow[]): Promise<StoreView[]> {
    const creds = await this.repo.credentialMeta(
      tx,
      stores.map((s) => s.id),
    );
    const out: StoreView[] = [];
    for (const store of stores) {
      out.push({
        store,
        credential: creds.get(store.id) ?? null,
        unmappedWarehouses: await this.repo.unmappedCount(tx, store.id),
      });
    }
    return out;
  }

  async list(ctx: RequestContext): Promise<StoreView[]> {
    return withTenantTx(this.db, ctx, async (tx) => this.view(tx, await this.repo.listStores(tx, ctx.storeScope)));
  }

  async get(ctx: RequestContext, id: string): Promise<StoreView> {
    return withTenantTx(this.db, ctx, async (tx) => (await this.view(tx, [await this.load(tx, ctx, id)]))[0]!);
  }

  /**
   * Name, default warehouse, sync mode, and automatic allocation (FR-ORD-12). `live` turns on stock push
   * and order processing, so it needs a usable connection and every active seller warehouse mapped
   * (FR-WHS-04). Manual sales channels have neither sync mode nor allocation setting: they are always
   * live, and their orders are always allocated when no warehouse is chosen.
   */
  async update(
    ctx: RequestContext,
    id: string,
    patch: {
      name?: string;
      defaultWarehouseId?: string | null;
      syncMode?: "read_only" | "live";
      autoAllocate?: boolean;
    },
    ifMatch?: number,
  ): Promise<StoreView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const store = await this.load(tx, ctx, id, true);
      if (isManualChannel(store.channel) && (patch.syncMode !== undefined || patch.autoAllocate !== undefined)) {
        throw storeIsManual();
      }
      if (patch.defaultWarehouseId && !(await this.warehouses.findActiveIn(tx, patch.defaultWarehouseId))) {
        throw warehouseNotFound("defaultWarehouseId");
      }
      const modeChanges = patch.syncMode !== undefined && patch.syncMode !== store.syncMode;
      if (patch.syncMode === "live" && modeChanges) await this.requireLiveReady(tx, store);
      const ok = await this.repo.updateStore(
        tx,
        id,
        {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.defaultWarehouseId !== undefined ? { defaultWarehouseId: patch.defaultWarehouseId } : {}),
          ...(modeChanges ? { syncMode: patch.syncMode, syncModeChangedAt: new Date() } : {}),
          ...(patch.autoAllocate !== undefined
            ? { settings: { ...store.settings, autoAllocate: patch.autoAllocate } }
            : {}),
        },
        ifMatch,
      );
      if (!ok) throw new ConflictError("row.stale", "Data sudah diubah orang lain. Muat ulang lalu coba lagi.");
      if (modeChanges) {
        await this.outbox.enqueue(tx, ctx, storeSyncModeChanged, { storeId: id, syncMode: patch.syncMode! }, id);
      }
      return (await this.view(tx, [(await this.repo.getStore(tx, id))!]))[0]!;
    });
  }

  /** Live needs a usable store whose active seller warehouses are all mapped (FR-WHS-04). */
  private async requireLiveReady(tx: Tx, store: StoreRow): Promise<void> {
    if (!USABLE.includes(store.status)) throw storeNotActive();
    const unmapped = await this.repo.unmappedCount(tx, store.id);
    if (unmapped > 0) throw storeUnmappedWarehouses(unmapped);
  }

  /** Active marketplace warehouses of the store without a mapping; going live needs 0 (FR-WHS-04). */
  unmappedWarehousesIn(tx: Tx, storeId: string): Promise<number> {
    return this.repo.unmappedCount(tx, storeId);
  }

  /** The caller's stores with these ids, locked for an update in the caller's transaction (cutover). */
  async lockIn(tx: Tx, ctx: RequestContext, ids: string[]): Promise<StoreRow[]> {
    const out: StoreRow[] = [];
    for (const id of [...new Set(ids)].sort()) out.push(await this.load(tx, ctx, id, true));
    return out;
  }

  /**
   * Parallel mode (read_only) or live, in the caller's transaction, for a store it locked (FR-MIG-05,
   * 06). Going live has the same conditions as `update`; the pusher resyncs the store when it does.
   */
  async setSyncModeIn(tx: Tx, ctx: RequestContext, store: StoreRow, mode: "read_only" | "live"): Promise<void> {
    if (store.syncMode === mode) return;
    if (mode === "live") await this.requireLiveReady(tx, store);
    await this.repo.updateStore(tx, store.id, { syncMode: mode, syncModeChangedAt: new Date() });
    await this.outbox.enqueue(tx, ctx, storeSyncModeChanged, { storeId: store.id, syncMode: mode }, store.id);
  }

  /**
   * Local disconnect (FR-INT-07): tokens are deleted at once and sync stops; the orders module then
   * releases the stock its open orders hold (`store.disconnected`). With `keepData` the orders, listings,
   * and sync log stay as history; without it the retention module deletes them in the background and
   * the store row stays as a marker (user store scopes may name it). Either way the marketplace shop is
   * free to be connected again, here or by another business. Marketplaces keep the app authorized until
   * the seller revokes it there; for Shopee the cancel link is returned.
   */
  async disconnect(
    ctx: RequestContext,
    id: string,
    keepData = true,
  ): Promise<{ view: StoreView; revokeUrl: string | null }> {
    const view = await withTenantTx(this.db, ctx, async (tx) => {
      const store = await this.load(tx, ctx, id, true);
      // a manual sales channel has no marketplace: disconnecting it archives it
      if (store.status === "disconnected") throw storeAlreadyDisconnected();
      const now = new Date();
      await this.repo.deleteCredential(tx, id);
      await this.repo.updateStore(tx, id, {
        status: "disconnected",
        statusReason: "disconnected_by_user",
        statusChangedAt: now,
        disconnectedAt: now,
        syncMode: "read_only",
        ...(store.syncMode !== "read_only" ? { syncModeChangedAt: now } : {}),
        failingSince: null,
        connectionAlertAt: null,
        ...(keepData ? {} : { dataDeletionRequestedAt: now }),
      });
      await this.outbox.enqueue(
        tx,
        ctx,
        storeDisconnected,
        { storeId: id, reason: "disconnected_by_user", keepData },
        id,
      );
      if (!keepData) await this.outbox.enqueue(tx, ctx, storeDataDeletionRequested, { storeId: id }, id);
      return (await this.view(tx, [(await this.repo.getStore(tx, id))!]))[0]!;
    });
    let revokeUrl: string | null = null;
    if (isSupportedChannel(view.store.channel) && this.connectors.isConfigured(view.store.channel)) {
      revokeUrl = this.connectors
        .get(view.store.channel)
        .auth.revokeUrl({ redirectUri: `${publicWebUrl(this.env)}/integrasi` });
    }
    return { view, revokeUrl };
  }

  async requestWarehouseSync(ctx: RequestContext, id: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const store = await this.load(tx, ctx, id);
      if (isManualChannel(store.channel)) throw storeIsManual();
      if (!USABLE.includes(store.status)) throw storeNotActive();
      await this.outbox.enqueue(tx, ctx, storeWarehousesSyncRequested, { storeId: id }, id);
    });
  }

  async channelWarehouses(ctx: RequestContext, storeId: string): Promise<ChannelWarehouseRow[]> {
    return withTenantTx(this.db, ctx, async (tx) => {
      await this.load(tx, ctx, storeId);
      return this.repo.channelWarehouses(tx, storeId);
    });
  }

  /**
   * Maps a marketplace warehouse to one OmniSeller warehouse, or removes the mapping (FR-WHS-02).
   * Removing a mapping of a live store would silently stop stock sync for part of it, so it is refused;
   * pointing it at another warehouse is fine.
   */
  async mapChannelWarehouse(
    ctx: RequestContext,
    storeId: string,
    channelWarehouseId: string,
    warehouseId: string | null,
  ): Promise<ChannelWarehouseRow> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const store = await this.load(tx, ctx, storeId, true);
      const cw = await this.repo.getChannelWarehouse(tx, storeId, channelWarehouseId, true);
      if (!cw) throw channelWarehouseNotFound();
      if (cw.kind === "fulfillment") throw marketplaceManagedWarehouse();
      if (warehouseId === null) {
        if (store.syncMode === "live" && cw.active) {
          throw new ConflictError(
            "store.live_mapping_required",
            "Toko sedang sinkron stok. Ubah ke mode baca saja sebelum melepas pemetaan gudang.",
          );
        }
        await this.repo.updateChannelWarehouse(tx, cw.id, { warehouseId: null, mappingStatus: "unmapped" });
      } else {
        if (!(await this.warehouses.findActiveIn(tx, warehouseId))) throw warehouseNotFound("warehouseId");
        await this.repo.updateChannelWarehouse(tx, cw.id, { warehouseId, mappingStatus: "mapped" });
      }
      if (cw.warehouseId !== warehouseId) {
        await this.outbox.enqueue(
          tx,
          ctx,
          channelWarehouseMappingChanged,
          { storeId, channelWarehouseId, warehouseId },
          storeId,
        );
      }
      return (await this.repo.getChannelWarehouse(tx, storeId, channelWarehouseId))!;
    });
  }

  /**
   * Stores with their marketplace warehouses, inside the caller's transaction (stock pusher, initial
   * stock). Ignores the caller's store scope: callers check scope themselves where a user is involved.
   */
  async stockTargetsIn(tx: Tx, storeIds: string[]): Promise<Map<string, StockTarget>> {
    const out = new Map<string, StockTarget>();
    for (const id of [...new Set(storeIds)]) {
      const store = await this.repo.getStore(tx, id);
      if (!store) continue;
      out.set(id, {
        store,
        usable: USABLE.includes(store.status),
        maxStockQuantity: isSupportedChannel(store.channel) ? MANIFESTS[store.channel].maxStockQuantity : null,
        warehouses: await this.repo.channelWarehouses(tx, id),
      });
    }
    return out;
  }

  /**
   * FR-INT-07: ids of the tenant's disconnected stores, whatever the caller's scope: their orders stop
   * holding stock and leave the work queues.
   */
  async disconnectedIdsIn(tx: Tx): Promise<Set<string>> {
    return new Set(await this.repo.storeIdsWithStatus(tx, "disconnected"));
  }

  /** A store row whatever the caller's scope, in the caller's transaction (module retention). */
  rowIn(tx: Tx, storeId: string, forUpdate = false): Promise<StoreRow | undefined> {
    return this.repo.getStore(tx, storeId, forUpdate);
  }

  /**
   * FR-INT-07, last step of deleting a store's data: its marketplace warehouses and sync cursors go, and
   * the store is marked as deleted. The row stays: user store scopes may name it.
   */
  async finishDataDeletionIn(tx: Tx, storeId: string): Promise<void> {
    await this.repo.deleteStoreMarketplaceData(tx, storeId);
    await this.repo.updateStore(tx, storeId, { dataDeletedAt: new Date() });
  }

  /** Stores of the caller's scope, inside the caller's transaction. */
  async listIn(tx: Tx, ctx: RequestContext): Promise<StoreRow[]> {
    return this.repo.listStores(tx, ctx.storeScope);
  }

  // ---- manual sales channels (FR-ORD-09, backend doc 8.21) ----

  /** A sales channel for orders taken outside marketplaces: WhatsApp, Instagram, a shop counter. */
  async createManual(ctx: RequestContext, input: { name: string; defaultWarehouseId?: string | null }) {
    return withTenantTx(
      this.db,
      ctx,
      async (tx) => (await this.view(tx, [await this.insertManualIn(tx, ctx, input)]))[0]!,
    );
  }

  private async insertManualIn(
    tx: Tx,
    ctx: RequestContext,
    input: { name: string; defaultWarehouseId?: string | null },
  ): Promise<StoreRow> {
    if (input.defaultWarehouseId && !(await this.warehouses.findActiveIn(tx, input.defaultWarehouseId))) {
      throw warehouseNotFound("defaultWarehouseId");
    }
    const id = newId();
    const now = new Date();
    await this.repo.insertStore(tx, {
      id,
      tenantId: ctx.tenantId,
      channel: MANUAL_CHANNEL,
      // unique across tenants like a marketplace shop id; nothing outside OmniSeller knows it
      externalShopId: id,
      name: input.name,
      status: "active",
      syncMode: "live",
      defaultWarehouseId: input.defaultWarehouseId ?? null,
      connectedAt: now,
      statusChangedAt: now,
    });
    return (await this.repo.getStore(tx, id))!;
  }

  /**
   * The manual sales channel an order is taken in, inside the caller's transaction: the one asked for
   * (in the caller's scope, not disconnected), else the first one. A business without any gets
   * "Pesanan Manual" with its first manual order, unless the caller is limited to some stores.
   */
  async manualStoreIn(tx: Tx, ctx: RequestContext, storeId?: string): Promise<StoreRow> {
    if (storeId) {
      const s = this.inScope(ctx, storeId) ? await this.repo.getStore(tx, storeId) : undefined;
      if (!s || !isManualChannel(s.channel) || s.status === "disconnected") throw manualStoreNotFound();
      return s;
    }
    // two first manual orders at once must not create two channels
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}:manual_store`}, 0))`);
    const first = await this.repo.firstManualStore(tx, ctx.storeScope);
    if (first) return first;
    if (ctx.storeScope !== null) throw manualStoreNotFound();
    return this.insertManualIn(tx, ctx, { name: "Pesanan Manual" });
  }

  /** Stores that use a warehouse (default warehouse, mapped marketplace warehouses): it cannot be deleted. */
  warehouseUsageIn(tx: Tx, warehouseId: string) {
    return this.repo.warehouseUsage(tx, warehouseId);
  }

  // ---- sync bookkeeping for other modules' pulls (worker) ----

  /** Where the last pull of `resource` (`listings`, later `orders`) left off. */
  async syncCursor(ctx: RequestContext, storeId: string, resource: string): Promise<string | null> {
    return withTenantTx(this.db, ctx, (tx) => this.repo.syncCursor(tx, storeId, resource));
  }

  /** Records where a pull of another resource (`returns`) got to; the store row is left alone. */
  async saveSyncCursor(ctx: RequestContext, storeId: string, resource: string, cursor: string): Promise<void> {
    await withTenantTx(this.db, ctx, (tx) => this.repo.advanceSyncCursor(tx, ctx.tenantId, storeId, resource, cursor));
  }

  /** Records a finished pull: its cursor and `last_product_sync_at` or `last_order_sync_at`. */
  async recordPull(
    ctx: RequestContext,
    storeId: string,
    resource: "listings" | "orders",
    cursor: string,
  ): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      await this.repo.advanceSyncCursor(tx, ctx.tenantId, storeId, resource, cursor);
      await this.repo.updateStore(
        tx,
        storeId,
        resource === "listings" ? { lastProductSyncAt: new Date() } : { lastOrderSyncAt: new Date() },
      );
    });
  }

  // ---- status changes from webhooks and token refreshes (worker) ----

  /**
   * The seller must authorize again. Tokens are deleted: they no longer work, and TikTok Shop's
   * disconnect guide asks for immediate removal.
   */
  async markReauthRequired(ctx: RequestContext, storeId: string, reason: StoreStatusReason): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const store = await this.repo.getStore(tx, storeId, true);
      if (!store || store.status === "disconnected") return;
      if (store.status === "reauth_required" && store.statusReason === reason) return;
      await this.repo.deleteCredential(tx, storeId);
      await this.repo.updateStore(tx, storeId, {
        status: "reauth_required",
        statusReason: reason,
        statusChangedAt: new Date(),
      });
      await this.outbox.enqueue(tx, ctx, storeReauthRequired, { storeId, reason }, storeId);
    });
  }

  /**
   * FR-INT-08: a call to the store's marketplace failed for a temporary reason (busy, unreachable); the
   * outage starts now unless it started already. Only state changes write.
   */
  async noteCallFailed(ctx: RequestContext, storeId: string): Promise<void> {
    await withTenantTx(this.db, ctx, (tx) => this.repo.markFailing(tx, storeId, true));
  }

  /** A call to the store's marketplace worked: an outage in progress is over. */
  async noteCallWorked(ctx: RequestContext, storeId: string): Promise<void> {
    await withTenantTx(this.db, ctx, (tx) => this.repo.markFailing(tx, storeId, false));
  }

  /** The marketplace announced when the seller's authorization ends. */
  async noteAuthorizationExpiry(ctx: RequestContext, storeId: string, expiresAt: Date | undefined): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      const store = await this.repo.getStore(tx, storeId, true);
      if (!store || !USABLE.includes(store.status)) return;
      const at = expiresAt ?? store.authorizationExpiresAt;
      const status = at ? usableStatus(at) : "token_expiring";
      await this.repo.updateStore(tx, storeId, {
        ...(expiresAt ? { authorizationExpiresAt: expiresAt } : {}),
        ...(status !== store.status
          ? {
              status,
              statusReason: status === "token_expiring" ? "authorization_expiring" : null,
              statusChangedAt: new Date(),
            }
          : {}),
      });
      if (status === "token_expiring" && store.status !== "token_expiring") {
        await this.outbox.enqueue(
          tx,
          ctx,
          storeAuthorizationExpiring,
          { storeId, expiresAt: at?.toISOString() ?? null },
          storeId,
        );
      }
    });
  }

  /** Re-evaluates active versus token_expiring from the stored authorization end (refresh scan). */
  async reevaluateStatus(ctx: RequestContext, storeId: string): Promise<void> {
    await withTenantTx(this.db, ctx, (tx) => this.refreshStatus(tx, ctx, storeId));
  }

  /** After a successful refresh: back to active (or token_expiring near the authorization's end). */
  async refreshStatus(tx: Tx, ctx: RequestContext, storeId: string): Promise<void> {
    const store = await this.repo.getStore(tx, storeId, true);
    if (!store || !USABLE.includes(store.status)) return;
    const status = usableStatus(store.authorizationExpiresAt);
    if (status === store.status) return;
    await this.repo.updateStore(tx, storeId, {
      status,
      statusReason: status === "token_expiring" ? "authorization_expiring" : null,
      statusChangedAt: new Date(),
    });
    if (status === "token_expiring") {
      await this.outbox.enqueue(
        tx,
        ctx,
        storeAuthorizationExpiring,
        { storeId, expiresAt: store.authorizationExpiresAt?.toISOString() ?? null },
        storeId,
      );
    }
  }

  // ---- full data export (FR-MIG-09) ----

  /** Every store of the tenant, disconnected and deleted ones included: names for other modules. */
  async namesIn(tx: Tx): Promise<Map<string, string>> {
    return new Map((await this.repo.listStores(tx, null, true)).map((s) => [s.id, s.name]));
  }

  /** Marketplace warehouses' names by id, in the caller's transaction (the audit log, backend doc 8.28). */
  async channelWarehouseNamesIn(tx: Tx): Promise<Map<string, string>> {
    return new Map((await this.repo.channelWarehouseNames(tx)).map((w) => [w.id, w.name]));
  }

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "toko.csv",
        description: "Toko marketplace yang pernah dihubungkan, termasuk yang sudah diputus.",
        columns: [
          "id",
          "marketplace",
          "nama_toko",
          "id_toko_marketplace",
          "wilayah",
          "status",
          "mode_sinkron",
          "gudang_bawaan",
          "terhubung_pada",
          "diputus_pada",
          "izin_berakhir_pada",
          "pesanan_tersinkron_pada",
          "produk_tersinkron_pada",
          "dibuat_pada",
        ],
        pages: (tx, l) =>
          singlePage(async () =>
            (await this.repo.listStores(tx, null, true)).map((s) => [
              s.id,
              channelDisplayName(s.channel),
              s.name,
              s.externalShopId,
              s.region,
              s.status,
              s.syncMode,
              l.warehouseCode(s.defaultWarehouseId),
              s.connectedAt,
              s.disconnectedAt,
              s.authorizationExpiresAt,
              s.lastOrderSyncAt,
              s.lastProductSyncAt,
              s.createdAt,
            ]),
          ),
      },
    ];
  }
}
