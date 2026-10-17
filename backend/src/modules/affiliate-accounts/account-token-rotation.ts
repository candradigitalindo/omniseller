import { and, asc, eq, isNotNull, lt } from "drizzle-orm";
import type { TokenVault } from "../../common/security/token-vault";
import type { Tx } from "../../db/client";
import { affiliateAccountCredential, affiliateAuthorization } from "../../db/schema";
import { accountTokenPurpose, authorizationTokenPurpose } from "./token-purposes";
/** Owning module's rotation API. Caller holds lockTenantKeys before any credential row lock. */
export async function rotateAffiliateTokensIn(
  tx: Tx,
  tenantId: string,
  vault: TokenVault,
  version: number,
  limit: number,
): Promise<number> {
  const accounts = await tx
    .select()
    .from(affiliateAccountCredential)
    .where(lt(affiliateAccountCredential.dekVersion, version))
    .orderBy(asc(affiliateAccountCredential.id))
    .limit(limit)
    .for("update");
  for (const row of accounts) {
    const access = await vault.open(
      tx,
      tenantId,
      row.accessTokenEnc,
      row.dekVersion,
      accountTokenPurpose(row.accountId, "access"),
    );
    const refresh = await vault.open(
      tx,
      tenantId,
      row.refreshTokenEnc,
      row.dekVersion,
      accountTokenPurpose(row.accountId, "refresh"),
    );
    const a = await vault.seal(tx, tenantId, access, accountTokenPurpose(row.accountId, "access"));
    const r = await vault.seal(tx, tenantId, refresh, accountTokenPurpose(row.accountId, "refresh"));
    await tx
      .update(affiliateAccountCredential)
      .set({ accessTokenEnc: a.data, refreshTokenEnc: r.data, dekVersion: a.dekVersion })
      .where(eq(affiliateAccountCredential.id, row.id));
  }
  if (accounts.length === limit) return accounts.length;
  const staged = await tx
    .select()
    .from(affiliateAuthorization)
    .where(
      and(isNotNull(affiliateAuthorization.grantAccessTokenEnc), lt(affiliateAuthorization.grantDekVersion, version)),
    )
    .orderBy(asc(affiliateAuthorization.id))
    .limit(limit - accounts.length)
    .for("update");
  for (const row of staged) {
    const access = await vault.open(
      tx,
      tenantId,
      row.grantAccessTokenEnc!,
      row.grantDekVersion!,
      authorizationTokenPurpose(row.id, "access"),
    );
    const refresh = await vault.open(
      tx,
      tenantId,
      row.grantRefreshTokenEnc!,
      row.grantDekVersion!,
      authorizationTokenPurpose(row.id, "refresh"),
    );
    const a = await vault.seal(tx, tenantId, access, authorizationTokenPurpose(row.id, "access"));
    const r = await vault.seal(tx, tenantId, refresh, authorizationTokenPurpose(row.id, "refresh"));
    await tx
      .update(affiliateAuthorization)
      .set({ grantAccessTokenEnc: a.data, grantRefreshTokenEnc: r.data, grantDekVersion: a.dekVersion })
      .where(eq(affiliateAuthorization.id, row.id));
  }
  return accounts.length + staged.length;
}
