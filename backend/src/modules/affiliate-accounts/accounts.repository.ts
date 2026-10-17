import { Injectable } from "@nestjs/common";
import { and, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import {
  affiliateAccount as account,
  affiliateAuthorization as auth,
  affiliateAccountCredential as credential,
} from "../../db/schema";

export type AffiliateAccountRow = typeof account.$inferSelect;
export type AffiliateCredentialRow = typeof credential.$inferSelect;
export type AffiliateAuthorizationRow = typeof auth.$inferSelect;
/** The API role has SELECT only on this projection; never select the staged grant by accident. */
export const AUTH_META = {
  id: auth.id,
  tenantId: auth.tenantId,
  createdAt: auth.createdAt,
  updatedAt: auth.updatedAt,
  rowVersion: auth.rowVersion,
  kind: auth.kind,
  accountId: auth.accountId,
  requestedBy: auth.requestedBy,
  stateHash: auth.stateHash,
  status: auth.status,
  statusChangedAt: auth.statusChangedAt,
  expiresAt: auth.expiresAt,
  callbackAt: auth.callbackAt,
  completedAt: auth.completedAt,
  errorCode: auth.errorCode,
  errorMessage: auth.errorMessage,
};
export type AffiliateAuthorizationMeta = Pick<AffiliateAuthorizationRow, keyof typeof AUTH_META>;
export const EMPTY_GRANT = {
  externalPrincipalId: null,
  grantAccessTokenEnc: null,
  grantRefreshTokenEnc: null,
  grantDekVersion: null,
  grantAccessExpiresAt: null,
  grantRefreshExpiresAt: null,
  grantScopes: null,
};
@Injectable()
export class AffiliateAccountsRepository {
  list(tx: Tx, after?: string, q?: string, limit = 50) {
    return tx
      .select()
      .from(account)
      .where(
        and(
          after ? gt(account.id, after) : undefined,
          q
            ? or(eq(account.externalPrincipalId, q), ilike(account.name, `%${q.replace(/[\\%_]/g, "\\$&")}%`))
            : undefined,
        ),
      )
      .orderBy(account.id)
      .limit(limit + 1);
  }
  async get(tx: Tx, id: string, lock = false) {
    const query = tx.select().from(account).where(eq(account.id, id));
    return (await (lock ? query.for("update") : query))[0];
  }
  async byPrincipal(tx: Tx, kind: AffiliateAccountRow["kind"], externalId: string, lock = false) {
    const query = tx
      .select()
      .from(account)
      .where(and(eq(account.kind, kind), eq(account.externalPrincipalId, externalId)));
    return (await (lock ? query.for("update") : query))[0];
  }
  async lockPrincipal(tx: Tx, kind: string, externalId: string) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`affiliate-principal:${kind}:${externalId}`},0))`,
    );
  }
  async insert(tx: Tx, values: typeof account.$inferInsert) {
    return (await tx.insert(account).values(values).returning())[0]!;
  }
  async update(tx: Tx, id: string, patch: Partial<AffiliateAccountRow>, expectedVersion?: number) {
    return (
      await tx
        .update(account)
        .set(patch)
        .where(
          and(eq(account.id, id), expectedVersion === undefined ? undefined : eq(account.rowVersion, expectedVersion)),
        )
        .returning()
    )[0];
  }
  async credential(tx: Tx, accountId: string) {
    return (await tx.select().from(credential).where(eq(credential.accountId, accountId)))[0];
  }
  async saveCredential(tx: Tx, values: typeof credential.$inferInsert) {
    await tx
      .insert(credential)
      .values(values)
      .onConflictDoUpdate({
        target: credential.accountId,
        set: {
          accessTokenEnc: values.accessTokenEnc,
          refreshTokenEnc: values.refreshTokenEnc,
          dekVersion: values.dekVersion,
          categoryAssets: values.categoryAssets,
        },
      });
  }
  async deleteCredential(tx: Tx, accountId: string) {
    await tx.delete(credential).where(eq(credential.accountId, accountId));
  }
  async insertAuth(
    tx: Tx,
    values: Pick<
      typeof auth.$inferInsert,
      "id" | "tenantId" | "kind" | "accountId" | "requestedBy" | "stateHash" | "expiresAt"
    >,
  ) {
    // Drizzle emits DEFAULT for every omitted schema column. A column-scoped API grant
    // intentionally excludes staged secrets, so name only the permitted columns here.
    await tx.execute(sql`INSERT INTO affiliate_authorization
      (id,tenant_id,kind,account_id,requested_by,state_hash,expires_at)
      VALUES (${values.id},${values.tenantId},${values.kind},${values.accountId ?? null},
        ${values.requestedBy ?? null},${values.stateHash},${values.expiresAt})`);
    return (await this.getAuth(tx, values.id))!;
  }
  async getAuth(tx: Tx, id: string) {
    return (await tx.select(AUTH_META).from(auth).where(eq(auth.id, id)))[0];
  }
  async authByState(tx: Tx, stateHash: string) {
    return (await tx.select(AUTH_META).from(auth).where(eq(auth.stateHash, stateHash)).for("update"))[0];
  }
  async updateAuth(tx: Tx, id: string, patch: Partial<AffiliateAuthorizationMeta>) {
    return (await tx.update(auth).set(patch).where(eq(auth.id, id)).returning(AUTH_META))[0];
  }
  async claim(tx: Tx, id: string, claimId: string) {
    return (
      await tx
        .update(auth)
        .set({ claimId, claimedAt: new Date() })
        .where(
          and(
            eq(auth.id, id),
            inArray(auth.status, ["exchanging", "verifying"]),
            or(
              eq(auth.claimId, claimId),
              lt(auth.claimedAt, new Date(Date.now() - 300_000)),
              /* no active lease */ isNull(auth.claimId),
            ),
          ),
        )
        .returning()
    )[0];
  }
  async privateAuth(tx: Tx, id: string, lock = false) {
    const query = tx.select().from(auth).where(eq(auth.id, id));
    return (await (lock ? query.for("update") : query))[0];
  }
  async release(tx: Tx, id: string, claimId: string, patch: Partial<AffiliateAuthorizationRow> = {}) {
    await tx
      .update(auth)
      .set({ ...patch, claimId: null, claimedAt: null })
      .where(and(eq(auth.id, id), eq(auth.claimId, claimId)));
  }
  async setGrant(tx: Tx, id: string, claimId: string, patch: Partial<AffiliateAuthorizationRow>) {
    return (
      await tx
        .update(auth)
        .set({ ...patch, status: "verifying" })
        .where(and(eq(auth.id, id), eq(auth.claimId, claimId), eq(auth.status, "exchanging")))
        .returning()
    )[0];
  }
  async invalidate(tx: Tx, accountId: string) {
    return tx
      .update(auth)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorCode: "disconnected",
        errorMessage: "Akun diputus. Mulai otorisasi baru untuk menghubungkannya lagi.",
      })
      .where(and(eq(auth.accountId, accountId), inArray(auth.status, ["pending", "exchanging", "verifying"])))
      .returning({ id: auth.id });
  }
  async disconnectAll(tx: Tx) {
    await tx
      .update(account)
      .set({ status: "disconnected", disconnectedAt: new Date(), errorCode: null, errorMessage: null });
    await tx.delete(credential);
    return tx
      .update(auth)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorCode: "business_closed",
        errorMessage: "Bisnis ditutup. Mulai otorisasi baru setelah bisnis dibuka kembali.",
      })
      .where(inArray(auth.status, ["pending", "exchanging", "verifying"]))
      .returning({ id: auth.id });
  }
  async clearGrant(tx: Tx, id: string) {
    await tx
      .update(auth)
      .set({ ...EMPTY_GRANT, claimId: null, claimedAt: null })
      .where(and(eq(auth.id, id), inArray(auth.status, ["succeeded", "failed", "expired"])));
  }
  exportAccounts(tx: Tx, after: string | undefined, limit: number) {
    return tx
      .select()
      .from(account)
      .where(after ? gt(account.id, after) : undefined)
      .orderBy(account.id)
      .limit(limit);
  }
  exportAuth(tx: Tx, after: string | undefined, limit: number) {
    return tx
      .select(AUTH_META)
      .from(auth)
      .where(after ? gt(auth.id, after) : undefined)
      .orderBy(auth.id)
      .limit(limit);
  }
  latestAuth(tx: Tx) {
    return tx.select(AUTH_META).from(auth).orderBy(desc(auth.id)).limit(10);
  }
}
