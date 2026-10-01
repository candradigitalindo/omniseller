import { setTimeout as sleep } from "node:timers/promises";
import { Inject, Injectable } from "@nestjs/common";
import { type AuthorizationGrant, isConnectorError, type ShopProfile } from "@omniseller/connector-core";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { WarehousesService } from "../inventory/warehouses.service";
import { describeSyncError } from "../sync/connector-calls";
import type { AuthorizationFailure } from "./channel.errors";
import { storeConnected } from "./channel.events";
import { ChannelRepository, type StoreAuthorizationRow } from "./channel.repository";
import { CONNECTORS, type ConnectorRegistry, MANIFESTS, type SupportedChannel } from "./connector-registry";
import { CredentialService } from "./credential.service";
import { failurePatch } from "./store-authorization.service";
import { usableStatus } from "./stores.service";

const log = logger.forModule("channel.connect");

/** Describing the shops is retried in place: the code cannot be exchanged a second time. */
const DESCRIBE_ATTEMPTS = 3;

export interface ConnectedShop {
  storeId: string;
  externalShopId: string;
  name: string;
  reconnected: boolean;
}

export interface AuthorizationResult {
  stores: ConnectedShop[];
  skipped: { externalShopId: string; region: string | null; reason: "region_not_supported" }[];
  failed: { externalShopId: string; reason: AuthorizationFailure }[];
}

/**
 * Worker side of connecting a store (backend doc 8.6, ADR-029): exchanges the authorization code,
 * describes the granted shops, and creates or reconnects one store per shop in a supported region,
 * each with sealed credentials, in its own transaction. Emits `store.connected` per store, which
 * starts the warehouse import and, for TikTok Shop, the webhook subscription.
 */
@Injectable()
export class StoreConnectService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ChannelRepository) private readonly repo: ChannelRepository,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(CONNECTORS) private readonly connectors: ConnectorRegistry,
    @Inject(CredentialService) private readonly credentials: CredentialService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
  ) {}

  /**
   * Idempotent: only an attempt still in `exchanging` is processed. A transient failure of the exchange
   * is rethrown for BullMQ to retry while `canRetry`; everything else ends the attempt as failed with
   * a message for the seller.
   */
  async complete(
    jobCtx: RequestContext,
    input: { authorizationId: string; code: string; shopId?: string | undefined; mainAccountId?: string | undefined },
    canRetry: boolean,
  ): Promise<void> {
    const row = await withTenantTx(this.db, jobCtx, (tx) => this.repo.getAuthorization(tx, input.authorizationId));
    if (row?.status !== "exchanging") return;
    // Audit the connection as the user who started it, not as the system.
    const ctx: RequestContext = row.requestedBy ? { ...jobCtx, actor: { type: "user", id: row.requestedBy } } : jobCtx;
    const channel = row.channel as SupportedChannel;
    const connector = this.connectors.get(channel);

    let grant: AuthorizationGrant;
    try {
      grant = await connector.auth.exchangeCode({
        code: input.code,
        ...(input.shopId ? { shopId: input.shopId } : {}),
        ...(input.mainAccountId ? { mainAccountId: input.mainAccountId } : {}),
      });
    } catch (err) {
      const transient = isConnectorError(err) && err.kind === "transient";
      if (transient && canRetry) throw err;
      log.warn({ err, authorization_id: row.id }, "authorization code exchange failed");
      await this.fail(ctx, row.id, transient ? "marketplace_error" : "exchange_failed", describeSyncError(err).message);
      return;
    }

    let profiles: ShopProfile[] | undefined;
    for (let attempt = 1; !profiles; attempt++) {
      try {
        profiles = await connector.shops.describe(grant);
      } catch (err) {
        if (!(isConnectorError(err) && err.kind === "transient" && attempt < DESCRIBE_ATTEMPTS)) {
          log.warn({ err, authorization_id: row.id }, "describing authorized shops failed");
          await this.fail(ctx, row.id, "marketplace_error", describeSyncError(err).message);
          return;
        }
        await sleep(1000 * attempt);
      }
    }

    const result: AuthorizationResult = { stores: [], skipped: [], failed: [] };
    const supported = MANIFESTS[channel].supportedRegions;
    const eligible = profiles.filter((p) => {
      if (supported.includes(p.region)) return true;
      result.skipped.push({
        externalShopId: p.externalShopId,
        region: p.region || null,
        reason: "region_not_supported",
      });
      return false;
    });

    if (row.storeId) {
      const target = await withTenantTx(this.db, ctx, (tx) => this.repo.getStore(tx, row.storeId!));
      if (!target || !eligible.some((p) => p.externalShopId === target.externalShopId)) {
        await this.fail(ctx, row.id, "store_mismatch");
        return;
      }
    }

    for (const profile of eligible) {
      const outcome = await this.connectShop(ctx, row, profile, grant);
      if (typeof outcome === "string") result.failed.push({ externalShopId: profile.externalShopId, reason: outcome });
      else result.stores.push(outcome);
    }

    await withTenantTx(this.db, ctx, async (tx) => {
      if (result.stores.length > 0) {
        await this.repo.updateAuthorization(tx, row.id, {
          status: "succeeded",
          completedAt: new Date(),
          result: { ...result },
          errorCode: null,
          errorMessage: null,
        });
        return;
      }
      const reason: AuthorizationFailure = result.failed[0]?.reason ?? "no_supported_shop";
      await this.repo.updateAuthorization(tx, row.id, { ...failurePatch(reason), result: { ...result } });
    });
    log.info(
      { authorization_id: row.id, stores: result.stores.length, skipped: result.skipped.length },
      "authorization completed",
    );
  }

  /** Creates or reconnects the store of one shop, with its credentials, in one transaction. */
  private async connectShop(
    ctx: RequestContext,
    row: StoreAuthorizationRow,
    profile: ShopProfile,
    grant: AuthorizationGrant,
  ): Promise<ConnectedShop | AuthorizationFailure> {
    try {
      return await withTenantTx(this.db, ctx, async (tx) => {
        const owner = await this.repo.shopOwner(tx, row.channel, profile.externalShopId);
        if (owner && owner.tenantId !== ctx.tenantId) return "shop_connected_elsewhere" as const;
        const now = new Date();
        const status = usableStatus(profile.authorizationExpiresAt, now);
        const common = {
          region: profile.region,
          status,
          statusReason: status === "token_expiring" ? "authorization_expiring" : null,
          statusChangedAt: now,
          authorizationExpiresAt: profile.authorizationExpiresAt,
          marketplaceInfo: profile.info,
        };
        const existing = await this.repo.storeByExternalId(tx, row.channel, profile.externalShopId);
        let storeId: string;
        if (existing) {
          // A reconnect keeps the seller's name, sync mode, and default warehouse.
          storeId = existing.id;
          await this.repo.updateStore(tx, storeId, {
            ...common,
            connectedAt: existing.connectedAt ?? now,
            disconnectedAt: null,
          });
        } else {
          storeId = newId();
          const active = await this.warehouses.activeIn(tx);
          await this.repo.insertStore(tx, {
            id: storeId,
            tenantId: ctx.tenantId,
            channel: row.channel,
            externalShopId: profile.externalShopId,
            name: profile.name,
            ...common,
            syncMode: "read_only",
            defaultWarehouseId: active[0]?.id ?? null,
            connectedAt: now,
          });
        }
        await this.credentials.save(tx, ctx, storeId, grant.tokens, profile.shopCipher);
        await this.outbox.enqueue(tx, ctx, storeConnected, { storeId, reconnected: !!existing }, storeId);
        return {
          storeId,
          externalShopId: profile.externalShopId,
          name: existing?.name ?? profile.name,
          reconnected: !!existing,
        };
      });
    } catch (err) {
      // Another tenant connected the same shop between the check and the insert.
      if ((err as { code?: string }).code === "23505") return "shop_connected_elsewhere";
      throw err;
    }
  }

  private async fail(ctx: RequestContext, id: string, reason: AuthorizationFailure, detail?: string): Promise<void> {
    await withTenantTx(this.db, ctx, (tx) => this.repo.updateAuthorization(tx, id, failurePatch(reason, detail)));
  }
}
