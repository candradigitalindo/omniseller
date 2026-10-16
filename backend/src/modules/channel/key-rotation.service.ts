import { Inject, Injectable } from "@nestjs/common";
import { logger } from "@omniseller/logging";
import { and, asc, eq, lt } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import { lockTenantKeys, TokenVault } from "../../common/security/token-vault";
import type { DbHandle } from "../../db/client";
import { storeCredential } from "../../db/schema/channel";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, TOKEN_VAULT } from "../../infra/tokens";
import { tenantForOpsIn } from "../identity/tenant-ops";
import { purposeOf } from "./credential.service";

const BATCH = 50;

/** Keeps retired keys for in-flight readers and backups; no token bytes leave this worker. */
@Injectable()
export class KeyRotationService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(TOKEN_VAULT) private readonly vault: TokenVault,
  ) {}

  async run(ctx: RequestContext, rotationId: string): Promise<void> {
    const version = await withTenantTx(this.db, ctx, async (tx) => {
      if ((await tenantForOpsIn(tx, ctx.tenantId)).status !== "active")
        throw new Error("rotation requires an active tenant");
      return this.vault.rotateIn(tx, ctx.tenantId, rotationId);
    });
    let changed = 0;
    for (;;) {
      const n = await withTenantTx(this.db, ctx, async (tx) => {
        if ((await tenantForOpsIn(tx, ctx.tenantId)).status !== "active")
          throw new Error("rotation requires an active tenant");
        await lockTenantKeys(tx, ctx.tenantId);
        const rows = await tx
          .select()
          .from(storeCredential)
          .where(and(eq(storeCredential.tenantId, ctx.tenantId), lt(storeCredential.dekVersion, version)))
          .orderBy(asc(storeCredential.storeId))
          .limit(BATCH)
          .for("update");
        for (const row of rows) {
          const access = await this.vault.open(
            tx,
            ctx.tenantId,
            row.accessTokenEnc,
            row.dekVersion,
            purposeOf(row.storeId, "access"),
          );
          const refresh = row.refreshTokenEnc
            ? await this.vault.open(
                tx,
                ctx.tenantId,
                row.refreshTokenEnc,
                row.dekVersion,
                purposeOf(row.storeId, "refresh"),
              )
            : null;
          const sealedAccess = await this.vault.seal(tx, ctx.tenantId, access, purposeOf(row.storeId, "access"));
          const sealedRefresh =
            refresh === null
              ? null
              : await this.vault.seal(tx, ctx.tenantId, refresh, purposeOf(row.storeId, "refresh"));
          await tx
            .update(storeCredential)
            .set({
              accessTokenEnc: sealedAccess.data,
              refreshTokenEnc: sealedRefresh?.data ?? null,
              dekVersion: sealedAccess.dekVersion,
            })
            .where(eq(storeCredential.id, row.id));
        }
        return rows.length;
      });
      changed += n;
      if (n < BATCH) break;
    }
    logger
      .forModule("channel.keys")
      .info({ tenant_id: ctx.tenantId, version, credentials: changed }, "tenant DEK rotated");
  }
}
