import { Inject, Injectable } from "@nestjs/common";
import type { OpenCampaignProductQuery } from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from "../../common/errors/domain-errors";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import { claimIdempotencyKey, idempotencyKey, requestHash } from "../../common/idempotency";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { StoresService } from "../channel/stores.service";
import { affiliateProductsRequested } from "./affiliate.events";
import { AffiliateRepository } from "./affiliate.repository";

export const affiliateQueryNotFound = () =>
  new NotFoundError("affiliate.query_not_found", "Hasil pencarian tidak ditemukan atau sudah kedaluwarsa.");
@Injectable()
export class AffiliateService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(AffiliateRepository) private readonly repo: AffiliateRepository,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}
  async get(ctx: RequestContext, storeId: string, requestId?: string) {
    await this.stores.get(ctx, storeId);
    return withTenantTx(this.db, ctx, async (tx) => {
      const row = requestId ? await this.repo.get(tx, requestId) : await this.repo.latest(tx, storeId);
      if (row && row.storeId !== storeId) throw affiliateQueryNotFound();
      if (requestId && (!row || row.expiresAt.getTime() <= Date.now())) throw affiliateQueryNotFound();
      return row && row.expiresAt.getTime() > Date.now() ? row : null;
    });
  }
  async request(ctx: RequestContext, storeId: string, input: OpenCampaignProductQuery, rawKey?: string) {
    const store = (await this.stores.get(ctx, storeId)).store;
    if (store.channel !== "shopee" || store.region !== "ID")
      throw new UnprocessableError(
        "affiliate.unsupported",
        "Pembacaan ini tersedia untuk AMS seller Shopee Indonesia.",
      );
    if (!["active", "token_expiring"].includes(store.status))
      throw new ConflictError("affiliate.store_unavailable", "Hubungkan ulang toko sebelum membaca produk AMS.");
    const key = idempotencyKey(rawKey);
    if (!key) throw new ValidationError([{ path: "Idempotency-Key", message: "Idempotency-Key wajib diisi." }]);
    return withTenantTx(this.db, ctx, async (tx) => {
      await this.repo.lockStore(tx, storeId);
      await this.repo.expire(tx, storeId);
      const id = newId();
      const earlier = await claimIdempotencyKey(tx, ctx, {
        scope: "affiliate.products",
        key,
        hash: requestHash({ storeId, ...input }),
        resourceId: id,
      });
      if (earlier) {
        const row = await this.repo.get(tx, earlier);
        if (!row || row.storeId !== storeId) throw affiliateQueryNotFound();
        return row;
      }
      if (await this.repo.pending(tx, storeId))
        throw new ConflictError(
          "affiliate.pending",
          "Pencarian sebelumnya masih berjalan. Tunggu hasilnya sebelum mencoba lagi.",
        );
      const row = await this.repo.insert(tx, {
        id,
        tenantId: ctx.tenantId,
        storeId,
        requestedBy: ctx.actor.type === "user" ? ctx.actor.id : null,
        query: input,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      await this.outbox.enqueue(tx, ctx, affiliateProductsRequested, { requestId: id }, id);
      return row;
    });
  }
  deleteStoreQueriesIn(tx: Tx, storeId: string, limit: number) {
    return this.repo.deleteStore(tx, storeId, limit);
  }
  exportSheets(): ExportSheet[] {
    return [
      {
        file: "pencarian_produk_affiliate.csv",
        description: "Snapshot hasil pencarian produk open campaign AMS Shopee, bukan riwayat seluruh campaign.",
        columns: [
          "id",
          "id_toko",
          "status",
          "parameter",
          "total",
          "produk",
          "kode_galat",
          "diminta_pada",
          "selesai_pada",
        ],
        pages: (tx) =>
          keysetPages(
            (after) => this.repo.page(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((r) => [
                r.id,
                r.storeId,
                r.status,
                JSON.stringify(r.query),
                r.total,
                JSON.stringify(r.items),
                r.errorCode,
                r.createdAt,
                r.finishedAt,
              ]),
          ),
      },
    ];
  }
}
