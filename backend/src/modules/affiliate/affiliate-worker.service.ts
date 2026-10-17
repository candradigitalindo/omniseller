import { Inject, Injectable } from "@nestjs/common";
import { isConnectorError, PermanentConnectorError, TransientConnectorError } from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import { type RequestContext, userContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { MarketplaceGateway } from "../channel/marketplace-gateway";
import { StoresService } from "../channel/stores.service";
import { UsersService } from "../identity/users.service";
import { AffiliateRepository } from "./affiliate.repository";
@Injectable()
export class AffiliateWorkerService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(AffiliateRepository) private readonly repo: AffiliateRepository,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
  ) {}
  async read(ctx: RequestContext, requestId: string, attemptsMade: number) {
    const claimId = newId();
    const row = await withTenantTx(this.db, ctx, (tx) => this.repo.claim(tx, requestId, claimId));
    if (!row) {
      const held = await withTenantTx(this.db, ctx, (tx) => this.repo.get(tx, requestId));
      if (held?.status === "running")
        throw new TransientConnectorError({
          code: "affiliate_lease_busy",
          message: "Another worker owns the request",
          retryAfterMs: Math.max(1000, 300_000 - (Date.now() - (held.claimedAt?.getTime() ?? Date.now()))),
        });
      return;
    }
    const finish = (values: Parameters<AffiliateRepository["finish"]>[3]) =>
      withTenantTx(this.db, ctx, (tx) => this.repo.finish(tx, requestId, claimId, values));
    try {
      if (row.expiresAt.getTime() <= Date.now())
        throw new PermanentConnectorError({ code: "expired", message: "Request expired" });
      const principal = row.requestedBy ? await this.users.loadPrincipal(ctx.tenantId, row.requestedBy) : undefined;
      if (
        principal?.user.status !== "active" ||
        principal.tenant.status !== "active" ||
        !principal.permissions.includes("affiliate:read")
      )
        throw new PermanentConnectorError({ code: "permission_revoked", message: "Permission is no longer available" });
      const actor = userContext(ctx, principal);
      const store = (await this.stores.get(actor, row.storeId)).store;
      if (store.channel !== "shopee" || store.region !== "ID" || !["active", "token_expiring"].includes(store.status))
        throw new PermanentConnectorError({ code: "store_unavailable", message: "Store unavailable" });
      const result = await this.gateway.call(
        actor,
        row.storeId,
        { kind: "affiliate.products_read", direction: "pull" },
        (connector, shop) => {
          if (!connector.affiliate)
            throw new PermanentConnectorError({ code: "unsupported", message: "AMS unavailable" });
          return connector.affiliate.listOpenCampaignProducts(shop, row.query);
        },
        (r) => ({ items: r.items.length, total: r.total, hasMore: r.nextCursor !== null }),
      );
      await finish({
        status: "succeeded",
        items: result.items.map((p) => ({
          ...p,
          startsAt: p.startsAt.toISOString(),
          endsAt: p.endsAt?.toISOString() ?? null,
          pendingTerminationAt: p.pendingTerminationAt?.toISOString() ?? null,
          protections: p.protections.map((v) => ({ ...v, endsAt: v.endsAt.toISOString() })),
        })),
        total: result.total,
        nextCursor: result.nextCursor,
        finishedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      });
    } catch (error) {
      const retry = isConnectorError(error) && error.kind === "transient" && attemptsMade < 4;
      const code = isConnectorError(error) ? error.code : "operation_failed";
      const message = retry
        ? "Shopee belum dapat dihubungi. Sistem akan mencoba lagi sesuai batas laju layanan."
        : code === "permission_revoked"
          ? "Izin pemohon telah berubah. Minta pengguna yang memiliki izin affiliate menjalankan pencarian."
          : code === "expired"
            ? "Permintaan kedaluwarsa. Jalankan pencarian kembali."
            : "Produk AMS belum dapat dibaca. Periksa koneksi toko, aktivasi dan persetujuan AMS di Seller Center, serta izin Affiliate Marketing Solution Management aplikasi.";
      await finish({
        status: retry ? "queued" : "failed",
        errorCode: code,
        errorMessage: message,
        finishedAt: retry ? null : new Date(),
      });
      if (retry) throw error;
    }
  }
}
