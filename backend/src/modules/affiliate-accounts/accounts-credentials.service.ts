import { Inject, Injectable } from "@nestjs/common";
import {
  isConnectorError,
  type MarketplaceAccountGrant,
  type MarketplaceAccountProfile,
  PermanentConnectorError,
} from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import { lockTenantKeys, TokenVault } from "../../common/security/token-vault";
import { withAdvisoryLock } from "../../db/advisory-lock";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, TOKEN_VAULT } from "../../infra/tokens";
import { refreshDue } from "../channel/credential.service";
import { MarketplaceGateway } from "../channel/marketplace-gateway";
import { AffiliateAccountsRepository, type AffiliateCredentialRow } from "./accounts.repository";

import { requireActiveAffiliateTenantIn } from "./active-tenant";
import { accountTokenPurpose } from "./token-purposes";

@Injectable()
export class AffiliateAccountCredentialsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(AffiliateAccountsRepository) private readonly repo: AffiliateAccountsRepository,
    @Inject(TOKEN_VAULT) private readonly vault: TokenVault,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
  ) {}
  async saveIn(
    tx: Tx,
    ctx: RequestContext,
    accountId: string,
    grant: MarketplaceAccountGrant,
    assets: MarketplaceAccountProfile["categoryAssets"],
  ) {
    if (!grant.tokens.refreshToken)
      throw new PermanentConnectorError({ code: "bad_response", message: "Missing refresh token" });
    const access = await this.vault.seal(
      tx,
      ctx.tenantId,
      grant.tokens.accessToken,
      accountTokenPurpose(accountId, "access"),
    );
    const refresh = await this.vault.seal(
      tx,
      ctx.tenantId,
      grant.tokens.refreshToken,
      accountTokenPurpose(accountId, "refresh"),
    );
    await this.repo.saveCredential(tx, {
      id: newId(),
      tenantId: ctx.tenantId,
      accountId,
      accessTokenEnc: access.data,
      refreshTokenEnc: refresh.data,
      dekVersion: access.dekVersion,
      categoryAssets: assets,
    });
  }
  private async state(ctx: RequestContext, accountId: string) {
    return withTenantTx(this.db, ctx, async (tx) => {
      const active = await tx.execute(sql`SELECT id FROM tenant WHERE id=${ctx.tenantId} AND status='active'`);
      if (!active.rows.length) return null;
      const account = await this.repo.get(tx, accountId);
      const credential = await this.repo.credential(tx, accountId);
      if (!account || !credential || !["active", "verifying"].includes(account.status)) return null;
      return { account, credential };
    });
  }
  private async open(ctx: RequestContext, row: AffiliateCredentialRow, field: "access" | "refresh") {
    return withTenantTx(this.db, ctx, (tx) =>
      this.vault.open(
        tx,
        ctx.tenantId,
        field === "access" ? row.accessTokenEnc : row.refreshTokenEnc,
        row.dekVersion,
        accountTokenPurpose(row.accountId, field),
      ),
    );
  }
  async refresh(ctx: RequestContext, accountId: string, canRetry: boolean, force = false): Promise<void> {
    await withAdvisoryLock(this.db, `affiliate_account:${accountId}`, async () => {
      let current = await this.state(ctx, accountId);
      if (!current) return;
      const updateTokens = async () => {
        if (!current) return;
        const before = current;
        const token = await this.open(ctx, before.credential, "refresh");
        const grant = await this.gateway.callPrincipal(
          ctx,
          accountId,
          { kind: "affiliate_account.refresh", direction: "pull" },
          (connector) => {
            if (!connector.accounts)
              throw new PermanentConnectorError({ code: "unsupported", message: "Account authorization unavailable" });
            return connector.accounts.refresh({
              refreshToken: token,
              kind: before.account.kind,
              externalPrincipalId: before.account.externalPrincipalId,
            });
          },
          () => ({ refreshed: true }),
        );
        await withTenantTx(this.db, ctx, async (tx) => {
          await lockTenantKeys(tx, ctx.tenantId);
          await requireActiveAffiliateTenantIn(tx, ctx.tenantId);
          const live = await this.repo.get(tx, accountId, true);
          const credential = await this.repo.credential(tx, accountId);
          if (!live || !["active", "verifying"].includes(live.status) || !credential) return;
          // A DEK rotation changes the row version, but does not consume the refresh token.
          // Compare the token under the key/account locks before saving a single-use replacement.
          const liveRefresh = await this.vault.open(
            tx,
            ctx.tenantId,
            credential.refreshTokenEnc,
            credential.dekVersion,
            accountTokenPurpose(accountId, "refresh"),
          );
          if (liveRefresh !== token) return;
          await this.saveIn(tx, ctx, accountId, grant, credential.categoryAssets);
          await this.repo.update(tx, accountId, {
            status: "verifying",
            scopes: grant.tokens.scopes,
            accessExpiresAt: grant.tokens.accessExpiresAt,
            authorizationExpiresAt: grant.tokens.refreshExpiresAt,
            lastRefreshedAt: new Date(),
          });
        });
        current = await this.state(ctx, accountId);
      };
      try {
        if (
          current.account.status !== "verifying" &&
          (force ||
            refreshDue({
              accessExpiresAt: current.account.accessExpiresAt,
              lastRefreshedAt: current.account.lastRefreshedAt,
              createdAt: current.account.createdAt,
            }))
        )
          await updateTokens();
        if (!current) return;
        const describe = async () => {
          if (!current) throw new PermanentConnectorError({ code: "disconnected", message: "Account disconnected" });
          const accessToken = await this.open(ctx, current.credential, "access");
          const row = current.account;
          return this.gateway.callPrincipal(
            ctx,
            accountId,
            { kind: "affiliate_account.profile", direction: "pull" },
            (connector) => {
              if (!connector.accounts)
                throw new PermanentConnectorError({
                  code: "unsupported",
                  message: "Account authorization unavailable",
                });
              return connector.accounts.describe({ accessToken, kind: row.kind, scopes: row.scopes });
            },
            (p) => ({ region: p.region, categories: p.categoryAssets.length }),
          );
        };
        let profile: MarketplaceAccountProfile;
        try {
          profile = await describe();
        } catch (error) {
          if (!isConnectorError(error) || error.kind !== "auth_expired") throw error;
          await updateTokens();
          if (!current) return;
          profile = await describe();
        }
        const expectedAccess = await this.open(ctx, current.credential, "access");
        await withTenantTx(this.db, ctx, async (tx) => {
          await lockTenantKeys(tx, ctx.tenantId);
          await requireActiveAffiliateTenantIn(tx, ctx.tenantId);
          const live = await this.repo.get(tx, accountId, true);
          const credential = await this.repo.credential(tx, accountId);
          if (!live || !["active", "verifying"].includes(live.status) || !credential) return;
          const liveAccess = await this.vault.open(
            tx,
            ctx.tenantId,
            credential.accessTokenEnc,
            credential.dekVersion,
            accountTokenPurpose(accountId, "access"),
          );
          if (liveAccess !== expectedAccess) return;
          await this.repo.update(tx, accountId, {
            status: "active",
            profile: profile.info,
            errorCode: null,
            errorMessage: null,
          });
          await this.repo.saveCredential(tx, { ...credential, categoryAssets: profile.categoryAssets });
        });
      } catch (error) {
        if (isConnectorError(error) && error.kind === "transient" && canRetry) throw error;
        const expected = current;
        if (!expected) return;
        await withTenantTx(this.db, ctx, async (tx) => {
          await lockTenantKeys(tx, ctx.tenantId);
          const live = await this.repo.get(tx, accountId, true);
          const credential = await this.repo.credential(tx, accountId);
          if (!live || live.status === "disconnected" || !credential) return;
          const snapshotToken = await this.vault.open(
            tx,
            ctx.tenantId,
            expected.credential.accessTokenEnc,
            expected.credential.dekVersion,
            accountTokenPurpose(accountId, "access"),
          );
          const liveToken = await this.vault.open(
            tx,
            ctx.tenantId,
            credential.accessTokenEnc,
            credential.dekVersion,
            accountTokenPurpose(accountId, "access"),
          );
          // A failed old probe must not revoke a newer successful reauthorization.
          if (snapshotToken === liveToken)
            await this.repo.update(tx, accountId, {
              status: "reauth_required",
              errorCode: isConnectorError(error) ? error.code : "operation_failed",
              errorMessage: "Akun perlu diperiksa. Hubungkan ulang dengan scope dan wilayah Indonesia yang sesuai.",
            });
        });
      }
    });
  }
}
