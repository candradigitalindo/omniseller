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
import { ListingPriceRepository } from "./listing-price.repository";
import { ListingSyncService } from "./listing-sync.service";
import { ListingsService } from "./listings.service";

@Injectable()
export class ListingPriceWorkerService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ListingPriceRepository) private readonly repo: ListingPriceRepository,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(MarketplaceGateway) private readonly gateway: MarketplaceGateway,
    @Inject(ListingSyncService) private readonly sync: ListingSyncService,
  ) {}

  async push(ctx: RequestContext, changeId: string, attemptsMade: number): Promise<void> {
    const claimId = newId();
    const row = await withTenantTx(this.db, ctx, (tx) => this.repo.claim(tx, changeId, claimId));
    if (!row) {
      const held = await withTenantTx(this.db, ctx, (tx) => this.repo.get(tx, changeId));
      if (held?.status === "processing")
        throw new TransientConnectorError({
          code: "price_lease_busy",
          message: "Another worker owns the request",
          retryAfterMs: Math.max(1_000, 300_000 - (Date.now() - (held.claimedAt?.getTime() ?? Date.now()))),
        });
      return;
    }
    let sentAt = row.sentAt;
    const finish = (values: Parameters<ListingPriceRepository["finish"]>[3]) =>
      withTenantTx(this.db, ctx, (tx) => this.repo.finish(tx, changeId, claimId, values));
    try {
      const principal = row.requestedBy ? await this.users.loadPrincipal(ctx.tenantId, row.requestedBy) : undefined;
      if (
        principal?.user.status !== "active" ||
        principal.tenant.status !== "active" ||
        !principal.permissions.includes("price:write")
      )
        throw new PermanentConnectorError({ code: "permission_revoked", message: "Permission is no longer available" });
      const actor = userContext(ctx, principal);
      const store = (await this.stores.get(actor, row.storeId)).store;
      if (store.syncMode !== "live" || !["active", "token_expiring"].includes(store.status))
        throw new PermanentConnectorError({ code: "store_unavailable", message: "Store is not live" });
      const listing = (await this.listings.get(actor, row.listingId)).listing;
      const read = async () => {
        const page = await this.gateway.call(
          actor,
          row.storeId,
          { kind: "listings.price_read", direction: "pull" },
          (connector, shop) => connector.catalog.getListings(shop, [listing.externalItemId]),
        );
        await this.sync.apply(ctx, row.storeId, page, new Date());
        const current = page.listings.find(
          (l) => l.externalItemId === listing.externalItemId && l.externalVariantId === listing.externalVariantId,
        );
        if (!current)
          throw new PermanentConnectorError({ code: "listing_missing", message: "Listing no longer exists" });
        return current.originalPrice ?? current.price;
      };
      const before = await read();
      if (before === row.requestedPrice) {
        await finish({ status: "succeeded", observedPrice: before, errorCode: null, errorMessage: null });
        return;
      }
      if (!sentAt) {
        if (before !== row.expectedPrice)
          throw new PermanentConnectorError({ code: "price_changed", message: "Marketplace price has changed" });
        await this.gateway.call(
          actor,
          row.storeId,
          { kind: "listings.price_push", direction: "push", request: { changeId, price: row.requestedPrice } },
          async (connector, shop) => {
            if (!connector.catalog.updatePrices)
              throw new PermanentConnectorError({ code: "unsupported", message: "Price updates are unavailable" });
            const results = await connector.catalog.updatePrices(
              shop,
              [
                {
                  externalItemId: listing.externalItemId,
                  externalVariantId: listing.externalVariantId,
                  price: row.requestedPrice,
                },
              ],
              { crossBorder: store.marketplaceInfo.seller_type === "CROSS_BORDER" },
            );
            if (results.length !== 1 || !results[0]?.ok)
              throw new PermanentConnectorError({
                code: results[0]?.errorCode ?? "bad_response",
                message: "Marketplace rejected the regular price",
              });
            return { accepted: true };
          },
        );
        sentAt = new Date();
      }
      const after = await read();
      if (after !== row.requestedPrice)
        throw new TransientConnectorError({
          code: "confirmation_pending",
          message: "Waiting for confirmed marketplace price",
        });
      await finish({ status: "succeeded", observedPrice: after, sentAt, errorCode: null, errorMessage: null });
    } catch (error) {
      const retry = isConnectorError(error) && error.kind === "transient" && attemptsMade < 4;
      const code = isConnectorError(error) ? error.code : "operation_failed";
      const message =
        code === "price_changed"
          ? "Harga berubah di marketplace. Muat ulang listing sebelum membuat permintaan baru."
          : sentAt
            ? "Marketplace menerima permintaan, tetapi harga belum dapat dikonfirmasi. Periksa Seller Center sebelum mencoba lagi."
            : retry
              ? "Marketplace belum dapat memproses permintaan. Sistem akan mencoba lagi sesuai batas laju layanan."
              : code === "permission_revoked"
                ? "Izin pemohon sudah berubah. Minta pengelola toko mengirim ulang."
                : "Perubahan harga belum berhasil. Periksa status toko, izin aplikasi dan promosi yang mengunci harga di Seller Center.";
      await finish({ status: retry ? "queued" : "failed", sentAt, errorCode: code, errorMessage: message });
      if (retry) throw error;
    }
  }
}
