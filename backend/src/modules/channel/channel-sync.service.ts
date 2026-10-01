import { Inject, Injectable } from "@nestjs/common";
import type { MarketplaceWarehouse } from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { ENV } from "../../config/config.module";
import type { Env } from "../../config/env.schema";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { WarehousesService } from "../inventory/warehouses.service";
import { SyncLogService } from "../sync/sync-log.service";
import { channelWarehouseChanged } from "./channel.events";
import { ChannelRepository } from "./channel.repository";
import { CONNECTORS, type ConnectorRegistry } from "./connector-registry";
import { MarketplaceGateway } from "./marketplace-gateway";

export interface WarehouseSyncSummary {
  total: number;
  added: number;
  removed: number;
  autoMapped: number;
}

const USABLE = new Set(["active", "token_expiring"]);

/**
 * Worker jobs of the channel module that pull from or configure a connected store: the marketplace
 * warehouse list (FR-WHS-01, 03, 10) and, where the marketplace subscribes per shop, webhooks.
 */
@Injectable()
export class ChannelSyncService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ChannelRepository) private readonly repo: ChannelRepository,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
    @Inject(CONNECTORS) private readonly connectors: ConnectorRegistry,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(SyncLogService) private readonly syncLog: SyncLogService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The store, or null when it does not exist (a job that outlived its store does nothing). */
  private async store(ctx: RequestContext, storeId: string) {
    return (await withTenantTx(this.db, ctx, (tx) => this.repo.getStore(tx, storeId))) ?? null;
  }

  /**
   * Imports the marketplace's warehouses and reconciles channel_warehouse:
   * - new seller warehouses start unmapped, marketplace-held ones (FBS, FBT) as marketplace_managed
   * - warehouses no longer listed are kept but marked inactive, never deleted (orders may point to them)
   * - a store whose only seller warehouse is unmapped, or a business with one warehouse, is mapped
   *   automatically to the store's default warehouse (FR-WHS-03, MVP-1 single-warehouse setup)
   */
  async syncWarehouses(
    ctx: RequestContext,
    storeId: string,
    queueJobId?: string,
  ): Promise<WarehouseSyncSummary | null> {
    const current = await this.store(ctx, storeId);
    if (!current) return null;
    if (!USABLE.has(current.status)) {
      await this.syncLog.skipped(ctx, { storeId, kind: "warehouses.pull", direction: "pull" }, "Toko tidak terhubung.");
      return null;
    }
    const listed = await this.gateway.call(
      ctx,
      storeId,
      { kind: "warehouses.pull", direction: "pull", ...(queueJobId ? { queueJobId } : {}) },
      (connector, shop) => connector.warehouses.list(shop),
      (list) => ({ warehouses: list.length }),
    );
    return withTenantTx(this.db, ctx, async (tx) => {
      const store = await this.repo.getStore(tx, storeId, true);
      if (!store) return null;
      const existing = await this.repo.channelWarehouses(tx, storeId);
      const byExternal = new Map(existing.map((w) => [w.externalWarehouseId, w]));
      const now = new Date();
      let added = 0;
      let removed = 0;

      for (const w of listed) {
        const row = byExternal.get(w.externalId);
        if (!row) {
          await this.repo.insertChannelWarehouse(tx, {
            id: newId(),
            tenantId: ctx.tenantId,
            storeId,
            externalWarehouseId: w.externalId,
            name: w.name,
            address: w.address,
            kind: w.kind,
            warehouseId: null,
            mappingStatus: w.kind === "fulfillment" ? "marketplace_managed" : "unmapped",
            isDefault: w.isDefault,
            active: true,
            lastSeenAt: now,
          });
          added++;
          continue;
        }
        await this.repo.updateChannelWarehouse(tx, row.id, {
          name: w.name,
          address: w.address,
          isDefault: w.isDefault,
          active: true,
          lastSeenAt: now,
          ...kindChange(row.kind, w),
        });
        if (!row.active) added++;
      }
      const seen = new Set(listed.map((w) => w.externalId));
      for (const row of existing) {
        if (row.active && !seen.has(row.externalWarehouseId)) {
          await this.repo.updateChannelWarehouse(tx, row.id, { active: false });
          removed++;
        }
      }

      const autoMapped = await this.autoMap(tx, storeId, store.defaultWarehouseId);
      if (added > 0 || removed > 0) {
        await this.outbox.enqueue(tx, ctx, channelWarehouseChanged, { storeId, added, removed }, storeId);
      }
      return { total: listed.length, added, removed, autoMapped };
    });
  }

  private async autoMap(tx: Tx, storeId: string, defaultWarehouseId: string | null): Promise<number> {
    const rows = await this.repo.channelWarehouses(tx, storeId);
    const sellers = rows.filter((r) => r.active && r.kind === "seller");
    const unmapped = sellers.filter((r) => r.mappingStatus === "unmapped");
    if (unmapped.length === 0) return 0;
    const active = await this.warehouses.activeIn(tx);
    const target =
      (defaultWarehouseId && active.find((w) => w.id === defaultWarehouseId)?.id) ||
      (active.length === 1 ? active[0]!.id : undefined);
    if (!target || (sellers.length > 1 && active.length > 1)) return 0;
    for (const r of unmapped) {
      await this.repo.updateChannelWarehouse(tx, r.id, { warehouseId: target, mappingStatus: "mapped" });
    }
    return unmapped.length;
  }

  /** TikTok Shop subscribes webhooks per shop; Shopee push is configured once for the app (no call). */
  async subscribeWebhooks(ctx: RequestContext, storeId: string, queueJobId?: string): Promise<string[] | null> {
    const store = await this.store(ctx, storeId);
    if (!store || !USABLE.has(store.status)) return null;
    const connector = this.connectors.get(store.channel);
    const subscribe = connector.webhooks.subscribe;
    if (!subscribe) return null;
    const address = `${"PUBLIC_WEBHOOK_URL" in this.env ? this.env.PUBLIC_WEBHOOK_URL : ""}/webhooks/${store.channel}`;
    return this.gateway.call(
      ctx,
      storeId,
      { kind: "webhooks.subscribe", direction: "push", ...(queueJobId ? { queueJobId } : {}) },
      (c, shop) => c.webhooks.subscribe!(shop, address),
      (topics) => ({ topics }),
    );
  }
}

/** A warehouse that changed between seller-held and marketplace-held gets its mapping reset. */
function kindChange(current: "seller" | "fulfillment", listed: MarketplaceWarehouse) {
  if (current === listed.kind) return {};
  return listed.kind === "fulfillment"
    ? { kind: "fulfillment" as const, warehouseId: null, mappingStatus: "marketplace_managed" as const }
    : { kind: "seller" as const, warehouseId: null, mappingStatus: "unmapped" as const };
}
