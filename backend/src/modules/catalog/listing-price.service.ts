import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { ConflictError, ValidationError } from "../../common/errors/domain-errors";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import { claimIdempotencyKey, idempotencyKey, requestHash } from "../../common/idempotency";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { storeNotActive } from "../channel/channel.errors";
import { StoresService } from "../channel/stores.service";
import { listingNotFound } from "./catalog.errors";
import { listingPriceRequested } from "./catalog.events";
import { ListingPriceRepository, type PriceChangeRow } from "./listing-price.repository";
import { ListingsService } from "./listings.service";

export const priceConflict = (code: string, message: string) => new ConflictError(`listing_price.${code}`, message);

@Injectable()
export class ListingPriceService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ListingPriceRepository) private readonly repo: ListingPriceRepository,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}

  async history(ctx: RequestContext, listingId: string): Promise<PriceChangeRow[]> {
    await this.listings.get(ctx, listingId);
    return withTenantTx(this.db, ctx, (tx) => this.repo.history(tx, listingId));
  }

  async request(
    ctx: RequestContext,
    listingId: string,
    input: { price: number; expectedPrice: number },
    rawKey?: string,
  ) {
    const view = await this.listings.get(ctx, listingId);
    const key = idempotencyKey(rawKey);
    if (!key) throw new ValidationError([{ path: "Idempotency-Key", message: "Idempotency-Key wajib diisi." }]);
    const store = (await this.stores.get(ctx, view.listing.storeId)).store;
    if (!["active", "token_expiring"].includes(store.status)) throw storeNotActive();
    if (store.syncMode !== "live")
      throw priceConflict("read_only", "Toko masih dalam mode uji berdampingan. Ubah harga di Seller Center.");
    if (view.listing.status !== "active" && !(store.channel === "shopee" && view.listing.status === "inactive"))
      throw priceConflict("status", "Status listing belum mengizinkan perubahan harga.");
    return withTenantTx(this.db, ctx, async (tx) => {
      await this.repo.lockListing(tx, listingId);
      const id = newId();
      const earlier = await claimIdempotencyKey(tx, ctx, {
        scope: "listing.price",
        key,
        hash: requestHash({ listingId, ...input }),
        resourceId: id,
      });
      if (earlier) {
        const row = await this.repo.get(tx, earlier);
        if (!row || row.listingId !== listingId) throw listingNotFound();
        return row;
      }
      const [listing] = await this.listings.listingsByIdsIn(tx, [listingId]);
      if (!listing || (listing.originalPrice ?? listing.price) !== input.expectedPrice)
        throw priceConflict("changed", "Harga listing sudah berubah. Muat ulang sebelum mengirim harga baru.");
      if (await this.repo.pending(tx, listingId))
        throw priceConflict(
          "pending",
          "Perubahan harga sebelumnya masih diproses. Tunggu hasilnya atau batalkan antreannya.",
        );
      const row = await this.repo.create(tx, {
        id,
        tenantId: ctx.tenantId,
        listingId,
        storeId: store.id,
        requestedBy: ctx.actor.type === "user" ? ctx.actor.id : null,
        expectedPrice: input.expectedPrice,
        requestedPrice: input.price,
      });
      await this.outbox.enqueue(tx, ctx, listingPriceRequested, { changeId: id }, id);
      return row;
    });
  }

  async cancel(ctx: RequestContext, listingId: string, changeId: string): Promise<void> {
    await this.listings.get(ctx, listingId);
    const cancelled = await withTenantTx(this.db, ctx, (tx) => this.repo.cancel(tx, listingId, changeId));
    if (!cancelled) throw priceConflict("not_queued", "Permintaan tidak ditemukan atau sudah mulai diproses.");
  }

  exportSheets(): ExportSheet[] {
    return [
      {
        file: "perubahan_harga_listing.csv",
        description: "Riwayat permintaan dan konfirmasi harga marketplace.",
        columns: [
          "id",
          "id_listing",
          "id_toko",
          "harga_sebelum",
          "harga_diminta",
          "harga_terkonfirmasi",
          "status",
          "kode_galat",
          "pesan",
          "diminta_pada",
          "diperbarui_pada",
        ],
        pages: (tx) =>
          keysetPages(
            (after) => this.repo.page(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((r) => [
                r.id,
                r.listingId,
                r.storeId,
                r.expectedPrice,
                r.requestedPrice,
                r.observedPrice,
                r.status,
                r.errorCode,
                r.errorMessage,
                r.createdAt,
                r.updatedAt,
              ]),
          ),
      },
    ];
  }
}
