import { Inject, Injectable } from "@nestjs/common";
import {
  type CommerceExecutionResult,
  type CommerceResult,
  isConnectorError,
  PermanentConnectorError,
  TransientConnectorError,
} from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { type RequestContext, userContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { AffiliateAccountCredentialsService } from "../affiliate-accounts/accounts-credentials.service";
import { MarketplaceGateway } from "../channel/marketplace-gateway";
import { UsersService } from "../identity/users.service";
import { CommerceRepository } from "./commerce.repository";
import { CommerceService } from "./commerce.service";
import { CommerceFilesService } from "./commerce-files.service";
import { writeOutcomeUncertain } from "./commerce-outcome";
import { authorizeCommerceInput } from "./commerce-policy";
@Injectable()
export class CommerceWorkerService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(CommerceRepository) private readonly repo: CommerceRepository,
    @Inject(CommerceService) private readonly commerce: CommerceService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
    @Inject(AffiliateAccountCredentialsService) private readonly credentials: AffiliateAccountCredentialsService,
    @Inject(CommerceFilesService) private readonly media: CommerceFilesService,
  ) {}
  async execute(ctx: RequestContext, id: string, attemptsMade: number) {
    const claimId = newId();
    const row = await withTenantTx(this.db, ctx, (tx) => this.repo.claim(tx, id, claimId));
    if (!row) {
      const held = await withTenantTx(this.db, ctx, (tx) => this.repo.get(tx, id));
      if (held?.status === "running")
        throw new TransientConnectorError({
          code: "commerce_lease_busy",
          message: "Request already running",
          retryAfterMs: 300_000,
        });
      return;
    }
    const finish = (values: Parameters<CommerceRepository["finish"]>[3]) =>
      withTenantTx(this.db, ctx, async (tx) => {
        if (values.status === "succeeded") {
          const tenant = await tx.execute(
            sql`SELECT id FROM tenant WHERE id=${ctx.tenantId} AND status='active' FOR SHARE`,
          );
          if (!tenant.rows.length) {
            values = {
              ...values,
              status: row.isWrite ? "uncertain" : "failed",
              result: null,
              errorCode: "tenant_unavailable",
              errorMessage: "Bisnis telah ditutup. Periksa perubahan marketplace sebelum menghubungkan kembali.",
            };
          }
          if (row.expiresAt.getTime() <= Date.now()) values = { ...values, result: null };
        }
        const changed = await this.repo.finish(tx, id, claimId, values);
        if (!changed) return;
        if (row.isWrite && row.storeId && (values.status === "succeeded" || values.status === "uncertain"))
          await this.commerce.followUpIn(tx, ctx, row.storeId, this.commerce.operation(row.operationId).path);
      });
    let dispatched = false;
    let acknowledged = false;
    const dispatch = async () => {
      if (!row.isWrite || dispatched) return;
      const live = await withTenantTx(this.db, ctx, (tx) => this.repo.dispatch(tx, id, claimId));
      if (!live)
        throw new PermanentConnectorError({ code: "commerce_lease_lost", message: "Request lease no longer owned" });
      dispatched = true;
    };
    try {
      if (row.expiresAt.getTime() <= Date.now())
        throw new PermanentConnectorError({ code: "expired", message: "Request expired" });
      if (row.isWrite && row.dispatchedAt) {
        await finish({
          status: "uncertain",
          finishedAt: new Date(),
          errorCode: "write_outcome_unknown",
          errorMessage:
            "Permintaan sebelumnya sudah dikirim. Periksa hasil di marketplace sebelum membuat perubahan baru.",
        });
        return;
      }
      const principal = row.requestedBy ? await this.users.loadPrincipal(ctx.tenantId, row.requestedBy) : undefined;
      if (principal?.user.status !== "active" || principal.tenant.status !== "active")
        throw new PermanentConnectorError({ code: "permission_revoked", message: "Requester unavailable" });
      const actor = userContext(ctx, principal);
      const operation = this.commerce.operation(row.operationId);
      await this.commerce.assert(actor, operation, row.storeId ?? row.accountId!);
      authorizeCommerceInput(actor, operation, row.input);
      const files = await this.media.inputFiles(actor, operation, row.storeId ?? row.accountId!, row.input, true);
      for (const file of Object.values(files))
        if (file.readRange) {
          const read = file.readRange;
          file.readRange = async (start, end) => {
            await this.commerce.assertFresh(actor, operation, row.storeId ?? row.accountId!);
            return read(start, end);
          };
        }
      let execution: CommerceExecutionResult;
      if (row.storeId) {
        execution = await this.gateway.call(
          actor,
          row.storeId,
          { kind: "commerce.operation", direction: row.isWrite ? "push" : "pull" },
          async (connector, shop, store) => {
            if (!connector.commerce)
              throw new PermanentConnectorError({ code: "unsupported", message: "Commerce adapter unavailable" });
            await dispatch();
            return connector.commerce.execute(
              {
                accessToken: shop.accessToken,
                shopCipher: shop.shopCipher,
                externalShopId: store.externalShopId,
                files,
              },
              operation.id,
              row.input,
            );
          },
          (r) => ({ acknowledgement: r.acknowledgement }),
        );
      } else {
        const call = async () => {
          const current = await this.credentials.forAccount(actor, row.accountId!);
          // Fresh scopes after a token refresh can be narrower than at API submission.
          await this.commerce.assert(actor, operation, row.accountId!);
          return this.gateway.callPrincipal(
            actor,
            row.accountId!,
            { kind: "commerce.operation", direction: row.isWrite ? "push" : "pull" },
            async (connector) => {
              if (!connector.commerce)
                throw new PermanentConnectorError({ code: "unsupported", message: "Commerce adapter unavailable" });
              await dispatch();
              return connector.commerce.execute(
                { accessToken: current.accessToken, categoryAssets: current.categoryAssets, files },
                operation.id,
                row.input,
              );
            },
            (r) => ({ acknowledgement: r.acknowledgement }),
          );
        };
        try {
          execution = await call();
        } catch (error) {
          // Read retries are safe. A mutating request gets no automatic repeat after dispatch.
          if (!row.isWrite && isConnectorError(error) && error.kind === "auth_expired") {
            await this.credentials.refresh(actor, row.accountId!, true, true);
            execution = await call();
          } else throw error;
        }
      }
      const latest = row.requestedBy ? await this.users.loadPrincipal(ctx.tenantId, row.requestedBy) : undefined;
      acknowledged = true;
      if (latest?.user.status !== "active" || latest.tenant.status !== "active")
        throw new PermanentConnectorError({ code: "permission_revoked", message: "Requester no longer active" });
      await this.commerce.assert(userContext(ctx, latest), operation, row.storeId ?? row.accountId!);
      const result: CommerceResult = {
        data: execution.data,
        nextCursor: execution.nextCursor,
        acknowledgement: execution.acknowledgement,
        ...(execution.download ? { artifact: await this.media.retainDownload(actor, execution.download) } : {}),
      };
      await finish({ status: "succeeded", result, finishedAt: new Date(), errorCode: null, errorMessage: null });
    } catch (error) {
      const retry = !row.isWrite && isConnectorError(error) && error.kind === "transient" && attemptsMade < 4;
      const uncertain = row.isWrite && writeOutcomeUncertain(error, dispatched, acknowledged);
      await finish({
        status: uncertain ? "uncertain" : retry ? "queued" : "failed",
        finishedAt: retry ? null : new Date(),
        errorCode: isConnectorError(error) ? error.code : "operation_failed",
        errorMessage: uncertain
          ? "Status perubahan belum dapat dipastikan. Periksa marketplace sebelum mengirim ulang."
          : retry
            ? "Marketplace sedang sibuk. Pembacaan akan dicoba kembali otomatis."
            : "Operasi belum dapat dijalankan. Periksa koneksi akun, izin fitur, wilayah Indonesia, dan persetujuan program marketplace.",
      });
      if (retry) throw error;
    }
  }
}
