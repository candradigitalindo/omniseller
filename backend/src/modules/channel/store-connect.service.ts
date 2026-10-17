import { Inject, Injectable } from "@nestjs/common";
import {
  type AuthorizationGrant,
  isConnectorError,
  PermanentConnectorError,
  type ShopProfile,
} from "@omniseller/connector-core";
import { logger } from "@omniseller/logging";
import { newId } from "@omniseller/shared";
import { eq } from "drizzle-orm";
import { type RequestContext, userContext } from "../../common/context/request-context";
import { lockTenantKeys, type TokenVault } from "../../common/security/token-vault";
import { withAdvisoryLock } from "../../db/advisory-lock";
import type { DbHandle } from "../../db/client";
import { tenant } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX, TOKEN_VAULT } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { UsersService } from "../identity/users.service";
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

export function sellerGrantPurpose(authorizationId: string): string {
  return `store_authorization:${authorizationId}:grant`;
}

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
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(TOKEN_VAULT) private readonly vault: TokenVault,
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
    return withAdvisoryLock(this.db, `store_authorization:${input.authorizationId}`, () =>
      this.completeLocked(jobCtx, input, canRetry),
    );
  }

  async clearCancelledGrant(ctx: RequestContext, authorizationId: string): Promise<void> {
    await withAdvisoryLock(this.db, `store_authorization:${authorizationId}`, () =>
      withTenantTx(this.db, ctx, async (tx) => {
        const row = await this.repo.privateAuthorization(tx, authorizationId, true);
        if (!row) return;
        if (["pending", "exchanging"].includes(row.status)) {
          if (row.expiresAt.getTime() > Date.now()) return;
          await this.repo.updateAuthorization(tx, row.id, failurePatch("expired"));
        }
        await this.repo.stageAuthorizationGrant(tx, row.id, null, null);
      }),
    );
  }

  private async requester(jobCtx: RequestContext, row: StoreAuthorizationRow): Promise<RequestContext> {
    const principal = row.requestedBy ? await this.users.loadPrincipal(jobCtx.tenantId, row.requestedBy) : undefined;
    if (
      principal?.user.status !== "active" ||
      principal.tenant.status !== "active" ||
      !principal.permissions.includes("settings:store") ||
      (row.storeId && principal.storeScope && !principal.storeScope.includes(row.storeId))
    ) {
      throw new PermanentConnectorError({
        code: "permission_revoked",
        message: "Store connection permission was revoked",
      });
    }
    return userContext(jobCtx, principal);
  }

  private async completeLocked(
    jobCtx: RequestContext,
    input: { authorizationId: string; code: string; shopId?: string | undefined; mainAccountId?: string | undefined },
    canRetry: boolean,
  ): Promise<void> {
    const row = await withTenantTx(this.db, jobCtx, (tx) => this.repo.privateAuthorization(tx, input.authorizationId));
    if (row?.status !== "exchanging") return;
    let ctx = jobCtx;
    let grant: AuthorizationGrant;
    let profiles: ShopProfile[];
    const channel = row.channel as SupportedChannel;
    const connector = this.connectors.get(channel);
    try {
      ctx = await this.requester(jobCtx, row);
      if (row.grantEnc && row.grantDekVersion !== null) {
        const raw = await withTenantTx(this.db, ctx, (tx) =>
          this.vault.open(tx, ctx.tenantId, row.grantEnc!, row.grantDekVersion!, sellerGrantPurpose(row.id)),
        );
        grant = JSON.parse(raw) as AuthorizationGrant;
        grant.tokens.accessExpiresAt = new Date(String(grant.tokens.accessExpiresAt));
        grant.tokens.refreshExpiresAt = grant.tokens.refreshExpiresAt
          ? new Date(String(grant.tokens.refreshExpiresAt))
          : null;
      } else {
        if (row.expiresAt.getTime() <= Date.now()) {
          await this.fail(ctx, row.id, "expired");
          return;
        }
        grant = await connector.auth.exchangeCode({
          code: input.code,
          ...(input.shopId ? { shopId: input.shopId } : {}),
          ...(input.mainAccountId ? { mainAccountId: input.mainAccountId } : {}),
        });
        // Persist before any shop discovery HTTP. A restart/retry must never consume the code twice.
        await withTenantTx(this.db, ctx, async (tx) => {
          await lockTenantKeys(tx, ctx.tenantId);
          const held = await this.repo.privateAuthorization(tx, row.id, true);
          if (held?.status !== "exchanging")
            throw new PermanentConnectorError({ code: "cancelled", message: "Authorization was cancelled" });
          const sealed = await this.vault.seal(tx, ctx.tenantId, JSON.stringify(grant), sellerGrantPurpose(row.id));
          await this.repo.stageAuthorizationGrant(tx, row.id, sealed.data, sealed.dekVersion);
        });
      }
      profiles = await connector.shops.describe(grant);
      ctx = await this.requester(jobCtx, row);
    } catch (err) {
      const transient = isConnectorError(err) && err.kind === "transient";
      if (transient && canRetry) throw err;
      log.warn({ err, authorization_id: row.id }, "seller authorization failed");
      await this.fail(
        ctx,
        row.id,
        isConnectorError(err) && err.code === "permission_revoked"
          ? "permission_revoked"
          : transient
            ? "marketplace_error"
            : "exchange_failed",
        describeSyncError(err).message,
      );
      return;
    }

    const previous = row.result as Partial<AuthorizationResult>;
    const result: AuthorizationResult = { stores: previous.stores ?? [], skipped: [], failed: [] };
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

    let targets = eligible;
    if (row.storeId) {
      const target = await withTenantTx(this.db, ctx, (tx) => this.repo.getStore(tx, row.storeId!));
      if (!target || !eligible.some((p) => p.externalShopId === target.externalShopId)) {
        await this.fail(ctx, row.id, "store_mismatch");
        return;
      }
      targets = eligible.filter((p) => p.externalShopId === target.externalShopId);
    }

    try {
      for (const profile of targets) {
        if (result.stores.some((s) => s.externalShopId === profile.externalShopId)) continue;
        ctx = await this.requester(jobCtx, row);
        const outcome = await this.connectShop(ctx, row, profile, grant, result);
        if (typeof outcome === "string")
          result.failed.push({ externalShopId: profile.externalShopId, reason: outcome });
        else result.stores.push(outcome);
      }

      await withTenantTx(this.db, ctx, async (tx) => {
        const held = await this.repo.getAuthorization(tx, row.id, true);
        await this.repo.stageAuthorizationGrant(tx, row.id, null, null);
        if (held?.status !== "exchanging") return;
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
    } catch (error) {
      if (isConnectorError(error) && error.kind === "permanent") {
        await this.fail(ctx, row.id, error.code === "permission_revoked" ? "permission_revoked" : "exchange_failed");
        return;
      }
      throw error;
    }
  }

  /** Creates or reconnects the store of one shop, with its credentials, in one transaction. */
  private async connectShop(
    ctx: RequestContext,
    row: StoreAuthorizationRow,
    profile: ShopProfile,
    grant: AuthorizationGrant,
    result: AuthorizationResult,
  ): Promise<ConnectedShop | AuthorizationFailure> {
    try {
      return await withTenantTx(this.db, ctx, async (tx) => {
        await lockTenantKeys(tx, ctx.tenantId);
        const [business] = await tx
          .select({ status: tenant.status })
          .from(tenant)
          .where(eq(tenant.id, ctx.tenantId))
          .for("share");
        if (business?.status !== "active")
          throw new PermanentConnectorError({ code: "tenant_inactive", message: "Tenant is no longer active" });
        const authorization = await this.repo.getAuthorization(tx, row.id, true);
        if (authorization?.status !== "exchanging")
          throw new PermanentConnectorError({ code: "cancelled", message: "Authorization was cancelled" });
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
        if (ctx.storeScope && (!existing || !ctx.storeScope.has(existing.id))) return "permission_revoked" as const;
        let storeId: string;
        if (existing) {
          // A reconnect keeps the seller's name, sync mode, and default warehouse. Failures from before
          // it say nothing about the new tokens; an outage already announced ends with a notice.
          storeId = existing.id;
          await this.repo.updateStore(tx, storeId, {
            ...common,
            connectedAt: existing.connectedAt ?? now,
            disconnectedAt: null,
            failingSince: null,
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
        const connected = {
          storeId,
          externalShopId: profile.externalShopId,
          name: existing?.name ?? profile.name,
          reconnected: !!existing,
        };
        // Progress shares the credential/outbox commit, so partial multi-shop retries do not reconnect twice.
        await this.repo.updateAuthorization(tx, row.id, {
          result: { ...result, stores: [...result.stores, connected] },
        });
        return connected;
      });
    } catch (err) {
      // Another tenant connected the same shop between the check and the insert.
      if ((err as { code?: string }).code === "23505") return "shop_connected_elsewhere";
      throw err;
    }
  }

  private async fail(ctx: RequestContext, id: string, reason: AuthorizationFailure, detail?: string): Promise<void> {
    await withTenantTx(this.db, ctx, async (tx) => {
      await this.repo.stageAuthorizationGrant(tx, id, null, null);
      const held = await this.repo.getAuthorization(tx, id, true);
      if (held?.status === "exchanging") await this.repo.updateAuthorization(tx, id, failurePatch(reason, detail));
    });
  }
}
