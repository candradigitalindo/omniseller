import { Inject, Injectable } from "@nestjs/common";
import {
  type ConnectorError,
  isConnectorError,
  PermanentConnectorError,
  type ShopCredentials,
  type TokenSet,
} from "@omniseller/connector-core";
import { logger } from "@omniseller/logging";
import { eq } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import { lockTenantKeys, type TokenVault } from "../../common/security/token-vault";
import { withAdvisoryLock } from "../../db/advisory-lock";
import type { DbHandle, Tx } from "../../db/client";
import { tenant } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, TOKEN_VAULT } from "../../infra/tokens";
import { SyncLogService } from "../sync/sync-log.service";
import { type StoreStatusReason, storeNotActive, storeNotFound } from "./channel.errors";
import { ChannelRepository, type CredentialRow, type StoreRow } from "./channel.repository";
import { CONNECTORS, type ConnectorRegistry } from "./connector-registry";
import { StoresService } from "./stores.service";

const log = logger.forModule("channel.credentials");

/** Refresh when less than this share of the access token's lifetime is left (technology doc 8.4). */
const REFRESH_AT_REMAINING = 0.2;
/** Consecutive refresh failures before the seller must authorize again (technology doc 8.4). */
export const MAX_REFRESH_FAILURES = 3;

const USABLE: StoreRow["status"][] = ["active", "token_expiring"];

export function purposeOf(storeId: string, field: "access" | "refresh"): string {
  return `store:${storeId}:${field}`;
}

/** Due when the token is past 80% of its lifetime (or has no known expiry). */
export function refreshDue(
  c: Pick<CredentialRow, "accessExpiresAt" | "lastRefreshedAt" | "createdAt">,
  now = new Date(),
): boolean {
  if (!c.accessExpiresAt) return true;
  const issued = (c.lastRefreshedAt ?? c.createdAt).getTime();
  const lifetime = Math.max(0, c.accessExpiresAt.getTime() - issued);
  return c.accessExpiresAt.getTime() - now.getTime() <= lifetime * REFRESH_AT_REMAINING;
}

const UNLINKED = new Set(["shop_no_linked", "partner_shop_no_link", "merchant_no_linked"]);

/** Why a marketplace stopped accepting a store's authorization. */
export function revokedReason(code: string): StoreStatusReason {
  if (code === "shop_banned") return "shop_banned";
  if (UNLINKED.has(code)) return "authorization_revoked";
  return "authorization_expired";
}

export type RefreshOutcome = "refreshed" | "fresh" | "not_connected";

/**
 * Marketplace tokens of a store (backend doc 8.6), worker only. Tokens are sealed with the tenant DEK
 * and bound to their store and field. Refreshes run under a PostgreSQL advisory lock per store, and
 * re-check the expiry once the lock is held: Shopee refresh tokens are single use, and a job and the
 * refresh scan may reach the same store at the same time.
 */
@Injectable()
export class CredentialService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ChannelRepository) private readonly repo: ChannelRepository,
    @Inject(TOKEN_VAULT) private readonly vault: TokenVault,
    @Inject(CONNECTORS) private readonly connectors: ConnectorRegistry,
    @Inject(SyncLogService) private readonly syncLog: SyncLogService,
    @Inject(StoresService) private readonly stores: StoresService,
  ) {}

  /** Seals and stores a new token set, inside the caller's transaction. */
  async save(tx: Tx, ctx: RequestContext, storeId: string, tokens: TokenSet, shopCipher: string | null): Promise<void> {
    const access = await this.vault.seal(tx, ctx.tenantId, tokens.accessToken, purposeOf(storeId, "access"));
    const refresh = tokens.refreshToken
      ? await this.vault.seal(tx, ctx.tenantId, tokens.refreshToken, purposeOf(storeId, "refresh"))
      : null;
    await this.repo.upsertCredential(tx, ctx.tenantId, storeId, {
      accessTokenEnc: access.data,
      refreshTokenEnc: refresh?.data ?? null,
      dekVersion: access.dekVersion,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      scopes: tokens.scopes,
      lastRefreshedAt: new Date(),
      refreshFailCount: 0,
      shopCipher,
    });
  }

  /** Everything a shop call needs, refreshing first when the token is close to expiry. */
  async forShop(
    ctx: RequestContext,
    storeId: string,
  ): Promise<{ store: StoreRow; shop: ShopCredentials; scopes: readonly string[] }> {
    const first = await this.read(ctx, storeId);
    if (!refreshDue(first.credential)) return this.open(ctx, first.store, first.credential);
    await this.refresh(ctx, storeId);
    const again = await this.read(ctx, storeId);
    return this.open(ctx, again.store, again.credential);
  }

  /**
   * Refreshes the access token when due (or always with `force`, after the marketplace rejected the
   * current one). A refresh token the marketplace no longer accepts sends the store to
   * `reauth_required` at once; other failures count, and the third in a row does the same.
   */
  async refresh(
    ctx: RequestContext,
    storeId: string,
    opts: { force?: boolean; queueJobId?: string } = {},
  ): Promise<RefreshOutcome> {
    return withAdvisoryLock(this.db, `store_credential:${storeId}`, async () => {
      const current = await withTenantTx(this.db, ctx, async (tx) => {
        const store = await this.repo.getStore(tx, storeId);
        const credential = await this.repo.credential(tx, storeId);
        if (!store || !credential || !USABLE.includes(store.status) || !credential.refreshTokenEnc) return null;
        if (!opts.force && !refreshDue(credential)) return "fresh" as const;
        const refreshToken = await this.vault.open(
          tx,
          ctx.tenantId,
          credential.refreshTokenEnc,
          credential.dekVersion,
          purposeOf(storeId, "refresh"),
        );
        return { store, credential, refreshToken };
      });
      if (current === null) return "not_connected";
      if (current === "fresh") return "fresh";

      const connector = this.connectors.get(current.store.channel);
      let tokens: TokenSet;
      try {
        if (
          current.store.channel === "tiktokshop" &&
          (typeof current.store.marketplaceInfo.open_id !== "string" || !current.store.marketplaceInfo.open_id.trim())
        )
          throw new PermanentConnectorError({
            code: "account_mismatch",
            message: "Reconnect the store to verify its seller identity before refreshing",
          });
        tokens = await this.syncLog.run(
          ctx,
          {
            storeId,
            kind: "auth.refresh",
            direction: "pull",
            ...(opts.queueJobId ? { queueJobId: opts.queueJobId } : {}),
          },
          () =>
            connector.auth.refresh({
              refreshToken: current.refreshToken,
              externalShopId: current.store.externalShopId,
              ...(typeof current.store.marketplaceInfo.open_id === "string"
                ? { expectedPrincipalId: current.store.marketplaceInfo.open_id }
                : {}),
              expectedScopes: current.credential.scopes,
            }),
          (t) => ({ accessExpiresAt: t.accessExpiresAt.toISOString() }),
        );
      } catch (err) {
        await this.recordRefreshFailure(ctx, storeId, err, current.refreshToken);
        throw err;
      }

      const saved = await withTenantTx(this.db, ctx, async (tx) => {
        await lockTenantKeys(tx, ctx.tenantId);
        const [business] = await tx
          .select({ status: tenant.status })
          .from(tenant)
          .where(eq(tenant.id, ctx.tenantId))
          .for("share");
        const liveStore = await this.repo.getStore(tx, storeId, true);
        const live = await this.repo.credentialForUpdate(tx, storeId);
        if (business?.status !== "active" || !liveStore || !USABLE.includes(liveStore.status) || !live?.refreshTokenEnc)
          return false;
        const generation = await this.vault.open(
          tx,
          ctx.tenantId,
          live.refreshTokenEnc,
          live.dekVersion,
          purposeOf(storeId, "refresh"),
        );
        if (generation !== current.refreshToken) return false;
        await this.save(tx, ctx, storeId, tokens, live.shopCipher);
        await this.stores.refreshStatus(tx, ctx, storeId);
        return true;
      });
      return saved ? "refreshed" : "not_connected";
    });
  }

  private async recordRefreshFailure(
    ctx: RequestContext,
    storeId: string,
    err: unknown,
    expectedRefreshToken: string,
  ): Promise<void> {
    const revoked =
      isConnectorError(err) &&
      (err.kind === "auth_revoked" || ["account_mismatch", "wrong_user_type", "missing_scope"].includes(err.code));
    await withTenantTx(this.db, ctx, async (tx) => {
      await lockTenantKeys(tx, ctx.tenantId);
      const store = await this.repo.getStore(tx, storeId, true);
      const c = await this.repo.credentialForUpdate(tx, storeId);
      if (!store || !USABLE.includes(store.status) || !c?.refreshTokenEnc) return;
      const generation = await this.vault.open(
        tx,
        ctx.tenantId,
        c.refreshTokenEnc,
        c.dekVersion,
        purposeOf(storeId, "refresh"),
      );
      if (generation !== expectedRefreshToken) return;
      const n = c.refreshFailCount + 1;
      await this.repo.updateCredential(tx, storeId, { refreshFailCount: n });
      if (revoked || n >= MAX_REFRESH_FAILURES) {
        const reason = revoked ? revokedReason((err as ConnectorError).code) : "refresh_failed";
        log.warn({ store_id: storeId, failures: n, code: (err as ConnectorError).code }, "store needs reauthorization");
        await this.stores.markReauthRequiredIn(tx, ctx, storeId, reason);
      }
    });
  }

  private async read(ctx: RequestContext, storeId: string): Promise<{ store: StoreRow; credential: CredentialRow }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const store = await this.repo.getStore(tx, storeId);
      if (!store) throw storeNotFound();
      const credential = await this.repo.credential(tx, storeId);
      if (!USABLE.includes(store.status) || !credential) throw storeNotActive();
      return { store, credential };
    });
  }

  private async open(
    ctx: RequestContext,
    store: StoreRow,
    credential: CredentialRow,
  ): Promise<{ store: StoreRow; shop: ShopCredentials; scopes: readonly string[] }> {
    const accessToken = await withTenantTx(this.db, ctx, (tx) =>
      this.vault.open(
        tx,
        ctx.tenantId,
        credential.accessTokenEnc,
        credential.dekVersion,
        purposeOf(store.id, "access"),
      ),
    );
    return {
      store,
      shop: { externalShopId: store.externalShopId, shopCipher: credential.shopCipher, accessToken },
      scopes: credential.scopes,
    };
  }
}
