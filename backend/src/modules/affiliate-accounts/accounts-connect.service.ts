import { Inject, Injectable } from "@nestjs/common";
import {
  isConnectorError,
  type MarketplaceAccountGrant,
  PermanentConnectorError,
  TransientConnectorError,
} from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import { type RequestContext, userContext } from "../../common/context/request-context";
import { lockTenantKeys, TokenVault } from "../../common/security/token-vault";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, TOKEN_VAULT } from "../../infra/tokens";
import { MarketplaceGateway } from "../channel/marketplace-gateway";
import { UsersService } from "../identity/users.service";
import { SyncRepository } from "../sync/sync.repository";
import { AffiliateAccountsRepository, EMPTY_GRANT } from "./accounts.repository";
import { AffiliateAccountCredentialsService } from "./accounts-credentials.service";
import { requireActiveAffiliateTenantIn } from "./active-tenant";
import { authorizationTokenPurpose } from "./token-purposes";

@Injectable()
export class AffiliateAccountConnectService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(AffiliateAccountsRepository) private readonly repo: AffiliateAccountsRepository,
    @Inject(SyncRepository) private readonly sync: SyncRepository,
    @Inject(TOKEN_VAULT) private readonly vault: TokenVault,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
    @Inject(AffiliateAccountCredentialsService) private readonly credentials: AffiliateAccountCredentialsService,
  ) {}
  async clearCancelledGrant(ctx: RequestContext, authorizationId: string) {
    await withTenantTx(this.db, ctx, async (tx) => {
      const row = await this.repo.privateAuth(tx, authorizationId, true);
      if (
        row &&
        ["pending", "exchanging", "verifying"].includes(row.status) &&
        row.expiresAt.getTime() <= Date.now() &&
        (!row.claimedAt || row.claimedAt.getTime() <= Date.now() - 300_000)
      ) {
        await this.repo.updateAuth(tx, row.id, {
          status: "expired",
          completedAt: new Date(),
          errorCode: "expired",
          errorMessage: "Otorisasi kedaluwarsa. Mulai koneksi baru.",
        });
      }
      await this.repo.clearGrant(tx, authorizationId);
    });
  }
  async complete(ctx: RequestContext, authorizationId: string, code: string, attemptsMade: number) {
    const claimId = newId();
    let row = await withTenantTx(this.db, ctx, (tx) => this.repo.claim(tx, authorizationId, claimId));
    if (!row) {
      const held = await withTenantTx(this.db, ctx, (tx) => this.repo.privateAuth(tx, authorizationId));
      if (held && ["exchanging", "verifying"].includes(held.status))
        throw new TransientConnectorError({
          code: "account_lease_busy",
          message: "Another worker owns authorization",
          retryAfterMs: Math.max(1000, 300_000 - (Date.now() - (held.claimedAt?.getTime() ?? Date.now()))),
        });
      await withTenantTx(this.db, ctx, (tx) => this.repo.clearGrant(tx, authorizationId));
      return;
    }
    try {
      const principal = row.requestedBy ? await this.users.loadPrincipal(ctx.tenantId, row.requestedBy) : undefined;
      if (
        principal?.user.status !== "active" ||
        principal.tenant.status !== "active" ||
        !principal.permissions.includes("affiliate:account_write")
      )
        throw new PermanentConnectorError({
          code: "permission_revoked",
          message: "Account connection permission was revoked",
        });
      const actor = userContext(ctx, principal);
      if (row.expiresAt.getTime() <= Date.now())
        throw new PermanentConnectorError({ code: "expired", message: "Authorization expired" });
      const kind = row.kind;
      if (row.status === "exchanging") {
        const grant = await this.gateway.callPrincipal(
          actor,
          authorizationId,
          { kind: "affiliate_account.exchange", direction: "pull" },
          (connector) => {
            if (!connector.accounts)
              throw new PermanentConnectorError({ code: "unsupported", message: "Account authorization unavailable" });
            return connector.accounts.exchangeCode({ code, kind, program: row!.program });
          },
          () => ({ exchanged: true }),
          row.channel,
        );
        const staged = await withTenantTx(this.db, actor, async (tx) => {
          await lockTenantKeys(tx, actor.tenantId);
          await requireActiveAffiliateTenantIn(tx, actor.tenantId);
          const held = await this.repo.privateAuth(tx, authorizationId, true);
          if (held?.status !== "exchanging" || held.claimId !== claimId) return undefined;
          const access = await this.vault.seal(
            tx,
            actor.tenantId,
            grant.tokens.accessToken,
            authorizationTokenPurpose(authorizationId, "access"),
          );
          const refresh = await this.vault.seal(
            tx,
            actor.tenantId,
            grant.tokens.refreshToken!,
            authorizationTokenPurpose(authorizationId, "refresh"),
          );
          return this.repo.setGrant(tx, authorizationId, claimId, {
            externalPrincipalId: grant.externalPrincipalId,
            grantAccessTokenEnc: access.data,
            grantRefreshTokenEnc: refresh.data,
            grantDekVersion: access.dekVersion,
            grantAccessExpiresAt: grant.tokens.accessExpiresAt,
            grantRefreshExpiresAt: grant.tokens.refreshExpiresAt,
            grantScopes: grant.tokens.scopes,
          });
        });
        if (!staged) {
          await withTenantTx(this.db, ctx, (tx) => this.repo.clearGrant(tx, authorizationId));
          return;
        }
        row = staged;
      }
      const stagedRow = row;
      if (
        !stagedRow.grantAccessTokenEnc ||
        !stagedRow.grantRefreshTokenEnc ||
        !stagedRow.grantDekVersion ||
        !stagedRow.externalPrincipalId ||
        !stagedRow.grantAccessExpiresAt
      )
        throw new PermanentConnectorError({ code: "bad_response", message: "Missing staged authorization grant" });
      const grant: MarketplaceAccountGrant = await withTenantTx(this.db, actor, async (tx) => ({
        kind,
        externalPrincipalId: stagedRow.externalPrincipalId!,
        tokens: {
          accessToken: await this.vault.open(
            tx,
            actor.tenantId,
            stagedRow.grantAccessTokenEnc!,
            stagedRow.grantDekVersion!,
            authorizationTokenPurpose(authorizationId, "access"),
          ),
          refreshToken: await this.vault.open(
            tx,
            actor.tenantId,
            stagedRow.grantRefreshTokenEnc!,
            stagedRow.grantDekVersion!,
            authorizationTokenPurpose(authorizationId, "refresh"),
          ),
          accessExpiresAt: stagedRow.grantAccessExpiresAt!,
          refreshExpiresAt: stagedRow.grantRefreshExpiresAt,
          scopes: stagedRow.grantScopes ?? [],
        },
      }));
      const profile = await this.gateway.callPrincipal(
        actor,
        authorizationId,
        { kind: "affiliate_account.verify", direction: "pull" },
        (connector) => {
          if (!connector.accounts)
            throw new PermanentConnectorError({ code: "unsupported", message: "Account authorization unavailable" });
          return connector.accounts.describe({
            kind,
            program: stagedRow.program,
            externalPrincipalId: grant.externalPrincipalId,
            accessToken: grant.tokens.accessToken,
            scopes: grant.tokens.scopes,
          });
        },
        (p) => ({ region: p.region, regionVerified: p.regionVerified !== false, categories: p.categoryAssets.length }),
        row.channel,
      );
      const currentPrincipal = await this.users.loadPrincipal(actor.tenantId, principal.user.id);
      if (
        currentPrincipal?.user.status !== "active" ||
        currentPrincipal.tenant.status !== "active" ||
        !currentPrincipal.permissions.includes("affiliate:account_write")
      )
        throw new PermanentConnectorError({
          code: "permission_revoked",
          message: "Account connection permission was revoked",
        });
      await withTenantTx(this.db, actor, async (tx) => {
        await lockTenantKeys(tx, actor.tenantId);
        await requireActiveAffiliateTenantIn(tx, actor.tenantId);
        await this.repo.lockPrincipal(tx, kind, grant.externalPrincipalId, stagedRow.channel);
        const existing = stagedRow.accountId
          ? await this.repo.get(tx, stagedRow.accountId, true)
          : await this.repo.byPrincipal(tx, kind, grant.externalPrincipalId, true, stagedRow.channel);
        const held = await this.repo.privateAuth(tx, authorizationId, true);
        if (held?.status !== "verifying" || held.claimId !== claimId) {
          await this.repo.clearGrant(tx, authorizationId);
          return;
        }
        if (
          held.accountId &&
          (!existing ||
            existing.channel !== stagedRow.channel ||
            existing.kind !== kind ||
            existing.externalPrincipalId !== grant.externalPrincipalId)
        )
          throw new PermanentConnectorError({
            code: "account_mismatch",
            message: "Authorization belongs to another account",
          });
        const acceptedAt = held.callbackAt ?? held.createdAt;
        if (
          existing &&
          (existing.connectedAt.getTime() > acceptedAt.getTime() ||
            (existing.disconnectedAt && existing.disconnectedAt.getTime() >= acceptedAt.getTime()))
        )
          throw new PermanentConnectorError({
            code: "stale_authorization",
            message: "A newer authorization or disconnection superseded this grant",
          });
        if (
          stagedRow.channel === "tiktokshop" &&
          (await this.sync.accountRevokedSince(tx, kind, grant.externalPrincipalId, held.callbackAt ?? held.createdAt))
        )
          throw new PermanentConnectorError({
            code: "authorization_revoked",
            message: "Creator authorization was revoked",
          });
        const patch = {
          status: "active" as const,
          region: profile.region,
          regionVerified: profile.regionVerified !== false,
          program: stagedRow.program,
          profile: profile.info,
          scopes: grant.tokens.scopes,
          accessExpiresAt: grant.tokens.accessExpiresAt,
          authorizationExpiresAt: grant.tokens.refreshExpiresAt,
          lastRefreshedAt: new Date(),
          connectedAt: held.callbackAt ?? held.createdAt,
          disconnectedAt: null,
          errorCode: null,
          errorMessage: null,
        };
        const account = existing
          ? (await this.repo.update(tx, existing.id, patch))!
          : await this.repo.insert(tx, {
              id: newId(),
              tenantId: actor.tenantId,
              channel: stagedRow.channel,
              kind,
              externalPrincipalId: grant.externalPrincipalId,
              name:
                profile.displayName ??
                `${stagedRow.channel === "shopee" ? "Creator Shopee" : "Mitra"} ${grant.externalPrincipalId}`,
              ...patch,
            });
        await this.credentials.saveIn(tx, actor, account.id, grant, profile.categoryAssets);
        await this.repo.release(tx, authorizationId, claimId, {
          ...EMPTY_GRANT,
          status: "succeeded",
          accountId: account.id,
          completedAt: new Date(),
          errorCode: null,
          errorMessage: null,
        });
      });
    } catch (error) {
      const retry = isConnectorError(error) && error.kind === "transient" && attemptsMade < 4;
      const code = isConnectorError(error)
        ? error.code
        : hasConstraint(error, "affiliate_account_active_owner_uq") ||
            hasConstraint(error, "affiliate_account_channel_active_owner_uq")
          ? "connected_elsewhere"
          : "operation_failed";
      const message = retry
        ? "Layanan belum dapat dihubungi. Verifikasi akan dicoba kembali tanpa menukar ulang kode yang sudah diterima."
        : code === "missing_scope"
          ? "Scope akun belum lengkap. Aktifkan izin yang dibutuhkan dan lakukan otorisasi ulang."
          : code === "wrong_user_type" || code === "account_mismatch"
            ? "Jenis atau identitas akun tidak sesuai. Gunakan tautan otorisasi untuk akun yang dipilih."
            : code === "region_not_supported"
              ? "Akun harus memiliki wilayah pilihan atau aset kategori Indonesia."
              : code === "connected_elsewhere"
                ? "Akun masih terhubung ke bisnis lain. Putuskan koneksi sebelumnya terlebih dahulu."
                : code === "permission_revoked"
                  ? "Izin pemohon telah berubah. Minta pengelola yang berwenang menghubungkan akun."
                  : code === "stale_authorization"
                    ? "Koneksi ini telah digantikan oleh koneksi atau pemutusan yang lebih baru. Mulai otorisasi baru."
                    : row.channel === "shopee"
                      ? "Koneksi creator Shopee belum berhasil. Periksa izin aplikasi Video/LIVE dan mulai otorisasi baru."
                      : "Koneksi akun belum berhasil. Periksa akses Creator API/TAP, scope, wilayah Indonesia dan mulai otorisasi baru.";
      await withTenantTx(this.db, ctx, async (tx) => {
        const held = await this.repo.privateAuth(tx, authorizationId, true);
        if (held?.claimId !== claimId) return;
        if (!["exchanging", "verifying"].includes(held.status)) {
          await this.repo.clearGrant(tx, authorizationId);
          return;
        }
        await this.repo.release(tx, authorizationId, claimId, {
          ...(retry ? {} : EMPTY_GRANT),
          ...(!retry ? { status: "failed" as const, completedAt: new Date() } : {}),
          errorCode: code,
          errorMessage: message,
        });
      });
      if (retry) throw error;
    }
  }
}
function hasConstraint(error: unknown, name: string): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { constraint?: unknown; cause?: unknown };
  return e.constraint === name || (e.cause !== error && hasConstraint(e.cause, name));
}
