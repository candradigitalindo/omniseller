import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import { lockTenantKeys } from "../../common/security/token-vault";
import type { DbHandle } from "../../db/client";
import { affiliateAuthorization } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import type { AccountWebhookEvent } from "../sync/webhook-consumer";
import { AffiliateAccountsRepository, EMPTY_GRANT } from "./accounts.repository";

/** Worker only. Revocations retain authorization history and remove local credential material. */
@Injectable()
export class AffiliateAccountRevocationService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(AffiliateAccountsRepository) private readonly repo: AffiliateAccountsRepository,
  ) {}
  async revoke(ctx: RequestContext, event: AccountWebhookEvent) {
    if (event.externalAccount.kind !== "creator" || !Number.isFinite(event.occurredAt.getTime())) return;
    await withTenantTx(this.db, ctx, async (tx) => {
      // Same lock order as account authorization/DEK rotation. A concurrent refresh checks the
      // locked account and credential again before writing, so it cannot restore revoked tokens.
      await lockTenantKeys(tx, ctx.tenantId);
      await this.repo.lockPrincipal(tx, event.externalAccount.kind, event.externalAccount.id);
      const account = await this.repo.get(tx, event.accountId, true);
      if (
        account?.channel !== "tiktokshop" ||
        account.kind !== event.externalAccount.kind ||
        account.externalPrincipalId !== event.externalAccount.id ||
        account.status === "disconnected"
      )
        return;
      const eventEnd = new Date(event.occurredAt.getTime() + 999);
      // An older push or replay must not revoke an authorization completed in a later second.
      if (account.connectedAt.getTime() > eventEnd.getTime()) return;
      await this.repo.update(tx, account.id, {
        status: "reauth_required",
        errorCode: "authorization_revoked",
        errorMessage: "Creator mencabut akses aplikasi. Hubungkan ulang akun untuk melanjutkan.",
      });
      await this.repo.deleteCredential(tx, account.id);
      // A grant staged before this cancellation cannot later re-activate the principal. The
      // connect service also fences against the verified inbox for grants not staged yet.
      await tx
        .update(affiliateAuthorization)
        .set({
          ...EMPTY_GRANT,
          status: "failed",
          claimId: null,
          claimedAt: null,
          completedAt: new Date(),
          errorCode: "authorization_revoked",
          errorMessage: "Creator mencabut akses. Mulai otorisasi baru.",
        })
        .where(
          and(
            eq(affiliateAuthorization.channel, "tiktokshop"),
            eq(affiliateAuthorization.kind, "creator"),
            inArray(affiliateAuthorization.status, ["pending", "exchanging", "verifying"]),
            or(
              eq(affiliateAuthorization.accountId, account.id),
              eq(affiliateAuthorization.externalPrincipalId, event.externalAccount.id),
            ),
            sql`coalesce(${affiliateAuthorization.callbackAt},${affiliateAuthorization.createdAt}) <= ${eventEnd}`,
          ),
        );
    });
  }
}
