import { Inject, Injectable } from "@nestjs/common";
import {
  type CommerceInput,
  type CommerceOperation,
  type CommercePrincipalKind,
  isConnectorError,
  validateCommerceInput,
} from "@omniseller/connector-core";
import { SHOPEE_COMMERCE_OPERATIONS } from "@omniseller/connector-shopee";
import { TIKTOK_COMMERCE_OPERATIONS } from "@omniseller/connector-tiktokshop";
import { newId } from "@omniseller/shared";
import { type RequestContext, userContext } from "../../common/context/request-context";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from "../../common/errors/domain-errors";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import { claimIdempotencyKey, idempotencyKey, requestHash } from "../../common/idempotency";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { AffiliateAccountsService } from "../affiliate-accounts/accounts.service";
import { listingPullRequested } from "../catalog/catalog.events";
import { storeWarehousesSyncRequested } from "../channel/channel.events";
import { StoresService } from "../channel/stores.service";
import { UsersService } from "../identity/users.service";
import { orderPullRequested } from "../orders/orders.events";
import { returnPullRequested } from "../returns/returns.events";
import { commerceRequested } from "./commerce.events";
import { CommerceRepository, type CommerceRow } from "./commerce.repository";
import { CommerceFilesService } from "./commerce-files.service";
import {
  authorizeCommerceInput,
  authorizeCommercePermissions,
  authorizeOperation,
  publicOperation,
} from "./commerce-policy";

const missing = () =>
  new NotFoundError("commerce.not_found", "Operasi commerce tidak ditemukan atau hasilnya sudah kedaluwarsa.");
function sellerType(value: {
  channel: string;
  marketplaceInfo: Record<string, unknown>;
}): "cross_border" | "local" | "unknown" {
  if (value.channel === "shopee")
    return value.marketplaceInfo.is_cb === true
      ? "cross_border"
      : value.marketplaceInfo.is_cb === false
        ? "local"
        : "unknown";
  return value.marketplaceInfo.seller_type === "CROSS_BORDER"
    ? "cross_border"
    : value.marketplaceInfo.seller_type === "LOCAL"
      ? "local"
      : "unknown";
}
@Injectable()
export class CommerceService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(CommerceRepository) private readonly repo: CommerceRepository,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(AffiliateAccountsService) private readonly accounts: AffiliateAccountsService,
    @Inject(OUTBOX) private readonly outbox: Outbox,
    @Inject(CommerceFilesService) private readonly media: CommerceFilesService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}
  operations() {
    return [...TIKTOK_COMMERCE_OPERATIONS, ...SHOPEE_COMMERCE_OPERATIONS].map(publicOperation);
  }
  operation(id: string): CommerceOperation {
    const operation = this.operations().find((o) => o.id === id);
    if (!operation) throw missing();
    return operation;
  }
  async principal(ctx: RequestContext, id: string, kind: CommercePrincipalKind) {
    if (kind === "seller") {
      const { store, credential } = await this.stores.get(ctx, id);
      if (!["tiktokshop", "shopee"].includes(store.channel) || store.region !== "ID") throw missing();
      return {
        id: store.id,
        kind,
        channel: store.channel as "shopee" | "tiktokshop",
        name: store.name,
        status: store.status,
        scopes: credential?.scopes ?? [],
        region: store.region,
        readOnly: store.syncMode === "read_only",
        sellerType: sellerType(store),
      };
    }
    const account = await this.accounts.get(ctx, id);
    if (account.kind !== kind || account.region !== "ID") throw missing();
    return {
      id: account.id,
      kind,
      channel: "tiktokshop" as const,
      name: account.name,
      status: account.status,
      scopes: account.scopes,
      region: account.region,
      readOnly: false,
      sellerType: "unknown" as const,
    };
  }
  async principals(ctx: RequestContext) {
    const stores = (await this.stores.list(ctx))
      .filter((v) => ["tiktokshop", "shopee"].includes(v.store.channel) && v.store.region === "ID")
      .map((v) => ({
        id: v.store.id,
        kind: "seller" as const,
        channel: v.store.channel as "shopee" | "tiktokshop",
        name: v.store.name,
        status: v.store.status,
        scopes: v.credential?.scopes ?? [],
        region: v.store.region,
        readOnly: v.store.syncMode === "read_only",
        sellerType: sellerType(v.store),
        categories: [],
      }));
    const accounts = ctx.permissions.has("affiliate:account_read")
      ? (await this.accounts.list(ctx, undefined, undefined, 100))
          .filter((a) => a.region === "ID")
          .map((a) => ({
            id: a.id,
            kind: a.kind,
            channel: "tiktokshop" as const,
            name: a.name,
            status: a.status,
            scopes: a.scopes,
            region: a.region,
            readOnly: false,
            sellerType: "unknown" as const,
            categories: Array.isArray(a.profile.categories)
              ? a.profile.categories
                  .filter(
                    (value): value is { id: number; name: string; market: string } =>
                      !!value &&
                      typeof value === "object" &&
                      typeof value.id === "number" &&
                      typeof value.name === "string" &&
                      value.market === "ID",
                  )
                  .map(({ id, name }) => ({ id, name }))
              : [],
          }))
      : [];
    return [...stores, ...accounts];
  }
  async assert(ctx: RequestContext, operation: CommerceOperation, id: string) {
    const principal = await this.principal(ctx, id, operation.principalKind);
    if (principal.channel !== operation.channel) throw missing();
    if (
      operation.accountRequirements?.length &&
      !operation.accountRequirements.includes(principal.sellerType as "cross_border" | "local")
    )
      throw new UnprocessableError(
        "commerce.account_type_required",
        "Jenis akun seller belum memenuhi persyaratan fitur ini. Periksa status lokal atau lintas negara di marketplace.",
      );
    authorizeOperation(ctx, operation, principal.scopes);
    if (!["active", "token_expiring"].includes(principal.status))
      throw new ConflictError("commerce.principal_unavailable", "Hubungkan ulang akun sebelum menjalankan operasi.");
    if (operation.write && principal.readOnly)
      throw new ConflictError(
        "commerce.read_only",
        "Toko dalam mode baca saja. Aktifkan sinkronisasi sebelum mengubah data.",
      );
    return principal;
  }
  async assertFresh(ctx: RequestContext, operation: CommerceOperation, id: string) {
    const principal =
      ctx.actor.type === "user" ? await this.users.loadPrincipal(ctx.tenantId, ctx.actor.id) : undefined;
    if (principal?.user.status !== "active" || principal.tenant.status !== "active")
      throw new ForbiddenError("commerce.permission_required", "Akun pengguna atau bisnis tidak lagi aktif.");
    return this.assert(userContext(ctx, principal), operation, id);
  }
  async request(
    ctx: RequestContext,
    body: { operationId: string; principalId: string; input: CommerceInput; confirmed: boolean },
    rawKey?: string,
  ) {
    if (ctx.actor.type !== "user")
      throw new ForbiddenError("commerce.user_required", "Permintaan harus dibuat oleh pengguna bisnis.");
    const operation = this.operation(body.operationId);
    const key = idempotencyKey(rawKey);
    if (!key) throw new ValidationError([{ path: "Idempotency-Key", message: "Idempotency-Key wajib diisi." }]);
    return withTenantTx(this.db, ctx, async (tx) => {
      const id = newId();
      const earlier = await claimIdempotencyKey(tx, ctx, {
        scope: "commerce.request",
        key,
        hash: requestHash(body),
        resourceId: id,
      });
      if (earlier) {
        const row = await this.repo.get(tx, earlier);
        if (!row || row.requestedBy !== ctx.actor.id || row.expiresAt.getTime() <= Date.now()) throw missing();
        await this.historyAccess(ctx, row);
        return row;
      }
      await this.assert(ctx, operation, body.principalId);
      authorizeCommerceInput(ctx, operation, body.input);
      if (operation.write && !body.confirmed)
        throw new ValidationError([
          { path: "confirmed", message: "Konfirmasi perubahan di marketplace terlebih dahulu." },
        ]);
      try {
        validateCommerceInput(operation, body.input);
      } catch (error) {
        if (isConnectorError(error)) throw new ValidationError([{ path: "input", message: error.message }]);
        throw error;
      }
      await this.media.inputFiles(ctx, operation, body.principalId, body.input, false);
      const row = await this.repo.insert(tx, {
        id,
        tenantId: ctx.tenantId,
        operationId: operation.id,
        principalKind: operation.principalKind,
        storeId: operation.principalKind === "seller" ? body.principalId : null,
        accountId: operation.principalKind !== "seller" ? body.principalId : null,
        requestedBy: ctx.actor.id,
        isWrite: operation.write,
        input: body.input,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      await this.outbox.enqueue(tx, ctx, commerceRequested, { requestId: id }, id);
      return row;
    });
  }
  async get(ctx: RequestContext, id: string) {
    const row = await withTenantTx(this.db, ctx, (tx) => this.repo.get(tx, id));
    if (!row || row.expiresAt.getTime() <= Date.now()) throw missing();
    await this.historyAccess(ctx, row);
    return row;
  }
  async list(ctx: RequestContext, filter: { principalId?: string; cursor?: string; limit: number }) {
    const rows = await withTenantTx(this.db, ctx, (tx) =>
      this.repo.list(tx, { ...filter, storeScope: ctx.storeScope }),
    );
    const visible: CommerceRow[] = [];
    for (const row of rows) {
      try {
        await this.historyAccess(ctx, row);
        visible.push(row);
      } catch (error) {
        if (error instanceof ForbiddenError || error instanceof NotFoundError || error instanceof ConflictError)
          continue;
        throw error;
      }
    }
    return { items: visible, nextCursor: rows.length === filter.limit ? rows.at(-1)!.id : null };
  }
  cleanupIn(tx: Tx) {
    return this.repo.cleanup(tx);
  }
  private async historyAccess(ctx: RequestContext, row: CommerceRow) {
    const operation = this.operation(row.operationId);
    const principal = await this.principal(ctx, row.storeId ?? row.accountId!, operation.principalKind);
    if (principal.channel !== operation.channel) throw missing();
    authorizeCommercePermissions(ctx, { ...operation, write: false });
  }
  cleanup(ctx: RequestContext) {
    return withTenantTx(this.db, ctx, (tx) => this.cleanupIn(tx));
  }
  /** Marketplace acknowledgements schedule the owning read models; they never directly change local truth. */
  async followUpIn(tx: Tx, ctx: RequestContext, storeId: string, path: string) {
    if (/(?:logistics.*address|warehous)/.test(path))
      await this.outbox.enqueue(tx, ctx, storeWarehousesSyncRequested, { storeId }, storeId);
    if (/(?:^\/product\/|^\/api\/v2\/(?:product|global_product)\/)/.test(path))
      await this.outbox.enqueue(tx, ctx, listingPullRequested, { storeId, mode: "full" }, storeId);
    if (/order|fulfillment|logistics|return|refund|first_mile/.test(path))
      await this.outbox.enqueue(
        tx,
        ctx,
        orderPullRequested,
        { storeId, mode: "incremental", from: new Date(Date.now() - 3_600_000).toISOString() },
        storeId,
      );
    if (/return|refund/.test(path))
      await this.outbox.enqueue(
        tx,
        ctx,
        returnPullRequested,
        { storeId, from: new Date(Date.now() - 3_600_000).toISOString() },
        storeId,
      );
  }
  exportSheets(): ExportSheet[] {
    return [
      ...this.media.exportSheets(),
      {
        file: "operasi_commerce.csv",
        description: "Metadata permintaan API commerce; hasil sementara, data pribadi dan kredensial tidak diekspor.",
        columns: [
          "id",
          "operasi",
          "jenis_akun",
          "id_toko",
          "id_akun",
          "mengubah_data",
          "status",
          "kode_galat",
          "dibuat_pada",
          "selesai_pada",
        ],
        pages: (tx) =>
          keysetPages(
            (after) => this.repo.exportPage(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((r) => [
                r.id,
                r.operationId,
                r.principalKind,
                r.storeId,
                r.accountId,
                r.isWrite,
                r.status,
                r.errorCode,
                r.createdAt,
                r.finishedAt,
              ]),
          ),
      },
    ];
  }
}
