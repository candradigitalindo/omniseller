import { Inject, Injectable } from "@nestjs/common";
import { isConnectorError, type MarketplaceAccountKind } from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import type { RequestContext } from "../../common/context/request-context";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PreconditionError,
  UnprocessableError,
  ValidationError,
} from "../../common/errors/domain-errors";
import { EXPORT_PAGE_SIZE, type ExportSheet, keysetPages } from "../../common/export-sheet";
import { claimIdempotencyKey, idempotencyKey, requestHash } from "../../common/idempotency";
import { hashToken, newSecretToken } from "../../common/security/tokens";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT, OUTBOX } from "../../infra/tokens";
import type { Outbox } from "../../outbox/outbox";
import { CONNECTORS, type ConnectorRegistry } from "../channel/connector-registry";
import {
  affiliateAccountRefreshRequested,
  affiliateAuthorizationReceived,
  affiliateGrantCleanupRequested,
} from "./accounts.events";
import { AffiliateAccountsRepository, type AffiliateAuthorizationMeta } from "./accounts.repository";

export const affiliateAccountNotFound = () =>
  new NotFoundError("affiliate_account.not_found", "Akun affiliate tidak ditemukan.");
const authorizationNotFound = () =>
  new NotFoundError("affiliate_account.authorization_not_found", "Otorisasi tidak ditemukan.");
export const ACCOUNT_STATE_PREFIX = "a1_";
@Injectable()
export class AffiliateAccountsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(AffiliateAccountsRepository) private readonly repo: AffiliateAccountsRepository,
    @Inject(CONNECTORS) private readonly connectors: ConnectorRegistry,
    @Inject(OUTBOX) private readonly outbox: Outbox,
  ) {}
  async list(ctx: RequestContext, after?: string, q?: string, limit = 50) {
    return withTenantTx(this.db, ctx, (tx) => this.repo.list(tx, after, q, limit));
  }
  async get(ctx: RequestContext, id: string) {
    return withTenantTx(this.db, ctx, async (tx) => {
      const row = await this.repo.get(tx, id);
      if (!row) throw affiliateAccountNotFound();
      return row;
    });
  }
  async rename(ctx: RequestContext, id: string, name: string, expectedVersion?: number) {
    await this.get(ctx, id);
    return withTenantTx(this.db, ctx, async (tx) => {
      const updated = await this.repo.update(tx, id, { name }, expectedVersion);
      if (!updated)
        throw new PreconditionError(
          "affiliate_account.changed",
          "Data akun sudah berubah. Muat ulang terlebih dahulu.",
        );
      return updated;
    });
  }
  async disconnect(ctx: RequestContext, id: string) {
    await this.get(ctx, id);
    await withTenantTx(this.db, ctx, async (tx) => {
      await this.repo.update(tx, id, {
        status: "disconnected",
        disconnectedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      });
      await this.repo.deleteCredential(tx, id);
      const cancelled = await this.repo.invalidate(tx, id);
      for (const row of cancelled)
        await this.outbox.enqueue(tx, ctx, affiliateGrantCleanupRequested, { authorizationId: row.id }, row.id);
    });
  }
  /** Business closure already holds the tenant lock and authorizes disconnecting every principal. */
  async disconnectAllIn(tx: Tx, ctx: RequestContext) {
    const cancelled = await this.repo.disconnectAll(tx);
    for (const row of cancelled)
      await this.outbox.enqueue(tx, ctx, affiliateGrantCleanupRequested, { authorizationId: row.id }, row.id);
  }
  async refresh(ctx: RequestContext, id: string, rawKey?: string) {
    const account = await this.get(ctx, id);
    if (account.status === "disconnected" || account.status === "reauth_required")
      throw new ConflictError("affiliate_account.reauthorize", "Hubungkan ulang akun sebelum memperbarui profil.");
    const key = idempotencyKey(rawKey);
    if (!key) throw new ValidationError([{ path: "Idempotency-Key", message: "Idempotency-Key wajib diisi." }]);
    await withTenantTx(this.db, ctx, async (tx) => {
      const earlier = await claimIdempotencyKey(tx, ctx, {
        scope: "affiliate.account_refresh",
        key,
        hash: requestHash({ accountId: id }),
        resourceId: id,
      });
      if (!earlier) await this.outbox.enqueue(tx, ctx, affiliateAccountRefreshRequested, { accountId: id }, id);
    });
  }
  private expired(row: AffiliateAuthorizationMeta): AffiliateAuthorizationMeta {
    return row.status === "pending" && row.expiresAt.getTime() <= Date.now() ? { ...row, status: "expired" } : row;
  }
  async getAuthorization(ctx: RequestContext, id: string) {
    return withTenantTx(this.db, ctx, async (tx) => {
      const row = await this.repo.getAuth(tx, id);
      if (!row) throw authorizationNotFound();
      return this.expired(row);
    });
  }
  async start(
    ctx: RequestContext,
    input: {
      kind: MarketplaceAccountKind;
      channel?: "tiktokshop" | "shopee";
      program?: "standard" | "video" | "live";
      accountId?: string;
    },
  ) {
    if (ctx.actor.type !== "user")
      throw new ForbiddenError("affiliate_account.user_required", "Masuk sebagai pengguna untuk menghubungkan akun.");
    const channel = input.channel ?? "tiktokshop";
    const program = input.program ?? "standard";
    if (
      (channel === "tiktokshop" && program !== "standard") ||
      (channel === "shopee" && (input.kind !== "creator" || !["video", "live"].includes(program)))
    )
      throw new ValidationError([
        { path: "program", message: "Pilih program creator yang sesuai dengan marketplace." },
      ]);
    if (input.accountId) {
      const target = await this.get(ctx, input.accountId);
      if (target.kind !== input.kind || target.channel !== channel)
        throw new ConflictError("affiliate_account.kind_mismatch", "Jenis akun otorisasi tidak sesuai.");
    }
    const state = ACCOUNT_STATE_PREFIX + newSecretToken();
    const connector = this.connectors.get(channel);
    if (!connector.accounts)
      throw new UnprocessableError("affiliate_account.unsupported", "Koneksi akun ini belum tersedia.");
    let authorizeUrl: string;
    try {
      authorizeUrl = connector.accounts.authorizeUrl({ kind: input.kind, state, program });
    } catch (error) {
      if (isConnectorError(error) && error.code === "not_configured")
        throw new UnprocessableError(
          "affiliate_account.not_configured",
          "Koneksi akun ini belum diaktifkan. Hubungi pengelola aplikasi.",
        );
      throw error;
    }
    const row = await withTenantTx(this.db, ctx, (tx) =>
      this.repo.insertAuth(tx, {
        id: newId(),
        tenantId: ctx.tenantId,
        channel,
        program,
        kind: input.kind,
        accountId: input.accountId ?? null,
        requestedBy: ctx.actor.type === "user" ? ctx.actor.id : null,
        stateHash: hashToken(state),
        expiresAt: new Date(Date.now() + (channel === "shopee" ? 10 : 30) * 60_000),
      }),
    );
    return { row, authorizeUrl };
  }
  async callback(
    ctx: RequestContext,
    input: { state: string; channel?: "tiktokshop" | "shopee"; code?: string; error?: string },
  ) {
    return withTenantTx(this.db, ctx, async (tx) => {
      const row = await this.repo.authByState(tx, hashToken(input.state));
      if (
        row?.status !== "pending" ||
        row.channel !== (input.channel ?? "tiktokshop") ||
        row.expiresAt.getTime() <= Date.now() ||
        ctx.actor.type !== "user" ||
        row.requestedBy !== ctx.actor.id
      )
        throw new ConflictError(
          "affiliate_account.invalid_state",
          "Otorisasi tidak valid atau kedaluwarsa. Mulai koneksi baru.",
        );
      if (input.error || !input.code || input.code === "null")
        return (await this.repo.updateAuth(tx, row.id, {
          status: "failed",
          callbackAt: new Date(),
          completedAt: new Date(),
          errorCode: "denied",
          errorMessage: "Otorisasi dibatalkan. Anda dapat menghubungkan akun kembali.",
        }))!;
      const updated = (await this.repo.updateAuth(tx, row.id, { status: "exchanging", callbackAt: new Date() }))!;
      await this.outbox.enqueue(
        tx,
        ctx,
        affiliateAuthorizationReceived,
        { authorizationId: row.id, code: input.code },
        row.id,
      );
      return updated;
    });
  }
  exportSheets(): ExportSheet[] {
    return [
      {
        file: "akun_affiliate.csv",
        description:
          "Akun creator/partner, marketplace, target wilayah dan status verifikasi; tanpa token atau asset cipher.",
        columns: [
          "id",
          "marketplace",
          "program",
          "jenis",
          "id_principal",
          "nama",
          "wilayah",
          "wilayah_terverifikasi",
          "status",
          "scope",
          "profil",
          "terhubung_pada",
          "berakhir_pada",
        ],
        pages: (tx) =>
          keysetPages(
            (after) => this.repo.exportAccounts(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((r) => [
                r.id,
                r.channel,
                r.program,
                r.kind,
                r.externalPrincipalId,
                r.name,
                r.region,
                r.regionVerified,
                r.status,
                r.scopes.join(" "),
                JSON.stringify(r.profile),
                r.connectedAt,
                r.authorizationExpiresAt,
              ]),
          ),
      },
      {
        file: "otorisasi_akun_affiliate.csv",
        description: "Status percobaan koneksi tanpa state, kode otorisasi atau kredensial.",
        columns: [
          "id",
          "marketplace",
          "program",
          "jenis",
          "id_akun",
          "status",
          "kode_galat",
          "diminta_pada",
          "selesai_pada",
        ],
        pages: (tx) =>
          keysetPages(
            (after) => this.repo.exportAuth(tx, after, EXPORT_PAGE_SIZE),
            (rows) =>
              rows.map((r) => [
                r.id,
                r.channel,
                r.program,
                r.kind,
                r.accountId,
                r.status,
                r.errorCode,
                r.createdAt,
                r.completedAt,
              ]),
          ),
      },
    ];
  }
}
