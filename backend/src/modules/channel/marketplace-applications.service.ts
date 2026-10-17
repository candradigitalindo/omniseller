import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { eq, sql } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import { ConflictError, ForbiddenError, UnprocessableError, ValidationError } from "../../common/errors/domain-errors";
import { type ExportSheet, singlePage } from "../../common/export-sheet";
import { openAesGcm, sealAesGcm } from "../../common/security/key-provider";
import { ENV } from "../../config/config.module";
import type { Env } from "../../config/env.schema";
import type { DbHandle, Tx } from "../../db/client";
import { marketplaceApplication } from "../../db/schema/marketplace-applications";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import type { SupportedChannel } from "./connector-registry";
import type { MarketplaceApplicationInputDto } from "./marketplace-applications.dto";

export async function lockMarketplaceApplication(tx: Tx, tenantId: string, channel: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`marketplace-app:${tenantId}:${channel}`},0))`);
}

/** App secrets are separate from worker-only OAuth tokens; public views never return ciphertext. */
@Injectable()
export class MarketplaceApplicationsService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private manage(ctx: RequestContext) {
    if (!ctx.permissions.has("settings:store") || ctx.storeScope !== null || ctx.warehouseScope !== null)
      throw new ForbiddenError(
        "marketplace_application.permission_required",
        "Pengaturan aplikasi marketplace memerlukan izin kelola toko dengan akses seluruh toko dan gudang bisnis.",
      );
  }
  private key() {
    if (!this.env.MARKETPLACE_APP_ENCRYPTION_KEY)
      throw new UnprocessableError(
        "marketplace_application.encryption_unavailable",
        "Pengelola server perlu menyiapkan kunci enkripsi pengaturan marketplace terlebih dahulu.",
      );
    return Buffer.from(this.env.MARKETPLACE_APP_ENCRYPTION_KEY, "base64");
  }
  private purpose(tenantId: string, id: string, channel: string) {
    return `marketplace-application:v1:${tenantId}:${channel}:${id}`;
  }
  private rows(tx: Tx, privateFields = false) {
    return tx
      .select({
        id: marketplaceApplication.id,
        channel: marketplaceApplication.channel,
        environment: marketplaceApplication.environment,
        enabled: marketplaceApplication.enabled,
        partnerId: marketplaceApplication.partnerId,
        appKey: marketplaceApplication.appKey,
        serviceId: marketplaceApplication.serviceId,
        rowVersion: marketplaceApplication.rowVersion,
        hasSecret: sql<boolean>`${marketplaceApplication.secretEnc} IS NOT NULL`,
        secretEnc: privateFields ? marketplaceApplication.secretEnc : sql<Buffer | null>`NULL`,
      })
      .from(marketplaceApplication);
  }
  private view(
    channel: SupportedChannel,
    row: Awaited<ReturnType<MarketplaceApplicationsService["rows"]>>[number] | undefined,
  ) {
    const configured = row
      ? row.enabled && row.hasSecret && !!this.env.MARKETPLACE_APP_ENCRYPTION_KEY
      : channel === "shopee"
        ? "SHOPEE_PARTNER_ID" in this.env && !!this.env.SHOPEE_PARTNER_ID
        : "TIKTOKSHOP_SERVICE_ID" in this.env && !!this.env.TIKTOKSHOP_SERVICE_ID;
    const web = "PUBLIC_WEB_URL" in this.env ? this.env.PUBLIC_WEB_URL.replace(/\/$/, "") : "";
    const hooks = "PUBLIC_WEBHOOK_URL" in this.env ? this.env.PUBLIC_WEBHOOK_URL?.replace(/\/$/, "") : undefined;
    return {
      channel,
      source: row ? ("tenant" as const) : configured ? ("platform" as const) : ("unconfigured" as const),
      applicationId: row?.id ?? null,
      configured,
      environment: row?.environment ?? ("production" as const),
      partnerId: row?.partnerId ?? null,
      appKey: row?.appKey ?? null,
      serviceId: row?.serviceId ?? null,
      secretConfigured: row?.hasSecret ?? false,
      rowVersion: row?.rowVersion ?? null,
      redirectUrl: `${web}/integrasi/callback/${channel}${row && channel === "tiktokshop" ? `?application_id=${row.id}` : ""}`,
      webhookUrl: hooks && row ? `${hooks}/webhooks/${channel}/apps/${row.id}` : null,
      settingsEnabled: !!this.env.MARKETPLACE_APP_ENCRYPTION_KEY,
    };
  }
  async list(ctx: RequestContext) {
    this.manage(ctx);
    const rows = await withTenantTx(this.db, ctx, (tx) => this.rows(tx));
    return {
      items: (["shopee", "tiktokshop"] as const).map((channel) =>
        this.view(
          channel,
          rows.find((row) => row.channel === channel),
        ),
      ),
    };
  }
  private async unused(tx: Tx, channel: string) {
    const result = await tx.execute<{ busy: boolean }>(sql`SELECT
      EXISTS(SELECT 1 FROM store WHERE channel=${channel} AND status<>'disconnected') OR
      EXISTS(SELECT 1 FROM affiliate_account WHERE channel=${channel} AND status<>'disconnected') OR
      EXISTS(SELECT 1 FROM store_authorization WHERE channel=${channel} AND status IN ('pending','exchanging') AND (expires_at>now() OR status='exchanging')) OR
      EXISTS(SELECT 1 FROM affiliate_authorization WHERE channel=${channel} AND status IN ('pending','exchanging','verifying') AND (expires_at>now() OR status<>'pending')) AS busy`);
    if (result.rows[0]?.busy)
      throw new ConflictError(
        "marketplace_application.in_use",
        "Putuskan koneksi toko dan akun marketplace serta selesaikan otorisasi yang masih berjalan sebelum mengganti atau menghapus kredensial aplikasi. Hubungkan ulang setelah perubahan.",
      );
  }
  async save(ctx: RequestContext, channel: SupportedChannel, input: MarketplaceApplicationInputDto) {
    this.manage(ctx);
    if (
      channel === "shopee"
        ? !input.partnerId || !!input.appKey || !!input.serviceId
        : !input.appKey || !input.serviceId || !!input.partnerId || input.environment !== "production"
    )
      throw new ValidationError([
        {
          path: channel === "shopee" ? "partnerId" : "appKey",
          message:
            channel === "shopee"
              ? "Isi Partner ID dan Partner Key Shopee."
              : "Isi App Key, App Secret dan Service ID Tokopedia & Shop. Gunakan lingkungan produksi untuk akun uji platform ini.",
        },
      ]);
    const key = this.key();
    return withTenantTx(this.db, ctx, async (tx) => {
      await lockMarketplaceApplication(tx, ctx.tenantId, channel);
      const current = (await this.rows(tx)).find((row) => row.channel === channel);
      if ((current?.rowVersion ?? undefined) !== input.expectedVersion)
        throw new ConflictError("row.stale", "Pengaturan sudah berubah. Muat ulang lalu simpan kembali.");
      await this.unused(tx, channel);
      const id = current?.id ?? newId();
      const values = {
        channel,
        environment: input.environment,
        enabled: true,
        partnerId: input.partnerId ?? null,
        appKey: input.appKey ?? null,
        serviceId: input.serviceId ?? null,
        secretEnc: sealAesGcm(key, Buffer.from(input.secret), this.purpose(ctx.tenantId, id, channel)),
      };
      if (current) await tx.update(marketplaceApplication).set(values).where(eq(marketplaceApplication.id, id));
      else await tx.insert(marketplaceApplication).values({ id, tenantId: ctx.tenantId, ...values });
      return this.view(
        channel,
        (await this.rows(tx)).find((row) => row.channel === channel),
      );
    });
  }
  async remove(ctx: RequestContext, channel: SupportedChannel, expectedVersion: number | undefined) {
    this.manage(ctx);
    return withTenantTx(this.db, ctx, async (tx) => {
      await lockMarketplaceApplication(tx, ctx.tenantId, channel);
      const current = (await this.rows(tx)).find((row) => row.channel === channel);
      if (!current || current.rowVersion !== expectedVersion)
        throw new ConflictError("row.stale", "Pengaturan sudah berubah. Muat ulang lalu coba kembali.");
      await this.unused(tx, channel);
      // A tombstone prevents silently switching this business back to the platform's app.
      await tx
        .update(marketplaceApplication)
        .set({ enabled: false, secretEnc: null, partnerId: null, appKey: null, serviceId: null })
        .where(eq(marketplaceApplication.id, current.id));
      return this.view(
        channel,
        (await this.rows(tx)).find((row) => row.channel === channel),
      );
    });
  }
  async environment(ctx: RequestContext, tx?: Tx): Promise<Env | undefined> {
    const privateFields = this.env.APP_ROLE === "worker" || this.env.APP_ROLE === "webhook";
    const rows = tx
      ? await this.rows(tx, privateFields)
      : await withTenantTx(this.db, ctx, (handle) => this.rows(handle, privateFields));
    if (!rows.length) return undefined;
    const next = { ...this.env } as unknown as Record<string, unknown>;
    for (const row of rows) {
      const enabled = row.enabled && row.hasSecret && !!this.env.MARKETPLACE_APP_ENCRYPTION_KEY;
      let secret: string | undefined;
      if (enabled && privateFields && row.secretEnc) {
        try {
          secret = openAesGcm(this.key(), row.secretEnc, this.purpose(ctx.tenantId, row.id, row.channel)).toString();
        } catch {
          throw new UnprocessableError(
            "marketplace_application.key_unavailable",
            "Kredensial aplikasi tidak dapat dibaca. Periksa kunci enkripsi server atau simpan kembali pengaturan marketplace.",
          );
        }
      }
      if (row.channel === "shopee") {
        next.SHOPEE_PARTNER_ID = enabled ? Number(row.partnerId) : undefined;
        next.SHOPEE_PARTNER_KEY = secret;
        if (row.environment === "sandbox") {
          next.SHOPEE_API_BASE_URL = "https://openplatform.sandbox.test-stable.shopee.sg";
          next.SHOPEE_AUTH_BASE_URL = "https://open.sandbox.test-stable.shopee.com";
        } else if (this.env.NODE_ENV !== "test") {
          next.SHOPEE_API_BASE_URL = "https://partner.shopeemobile.com";
          next.SHOPEE_AUTH_BASE_URL = "https://open.shopee.com";
        }
      } else {
        next.TIKTOKSHOP_APP_KEY = enabled ? row.appKey : undefined;
        next.TIKTOKSHOP_SERVICE_ID = enabled ? row.serviceId : undefined;
        next.TIKTOKSHOP_APP_SECRET = secret;
      }
    }
    return next as unknown as Env;
  }
  async owner(applicationId: string, channel: SupportedChannel): Promise<string | undefined> {
    if (this.env.APP_ROLE !== "webhook" && this.env.APP_ROLE !== "api") return undefined;
    const result = await this.db.db.execute<{ tenant_id: string }>(
      sql`SELECT tenant_id FROM resolve_marketplace_application(${applicationId},${channel})`,
    );
    return result.rows[0]?.tenant_id;
  }
  async id(ctx: RequestContext, channel: string, tx?: Tx) {
    const rows = tx ? await this.rows(tx) : await withTenantTx(this.db, ctx, (handle) => this.rows(handle));
    return rows.find((row) => row.channel === channel && row.enabled)?.id;
  }
  async webhookAddress(ctx: RequestContext, channel: string) {
    const id = await this.id(ctx, channel);
    const base = "PUBLIC_WEBHOOK_URL" in this.env ? this.env.PUBLIC_WEBHOOK_URL?.replace(/\/$/, "") : "";
    return `${base}/webhooks/${channel}${id ? `/apps/${id}` : ""}`;
  }
  exportSheets(): ExportSheet[] {
    return [
      {
        file: "aplikasi_marketplace.csv",
        description:
          "Metadata pengaturan aplikasi marketplace; tanpa ID aplikasi provider, key, secret maupun ciphertext.",
        columns: ["id", "marketplace", "lingkungan", "aktif", "dibuat_pada", "diubah_pada"],
        pages: (tx) =>
          singlePage(async () =>
            (
              await tx
                .select({
                  id: marketplaceApplication.id,
                  channel: marketplaceApplication.channel,
                  environment: marketplaceApplication.environment,
                  enabled: marketplaceApplication.enabled,
                  createdAt: marketplaceApplication.createdAt,
                  updatedAt: marketplaceApplication.updatedAt,
                })
                .from(marketplaceApplication)
            ).map((row) => [row.id, row.channel, row.environment, row.enabled, row.createdAt, row.updatedAt]),
          ),
      },
    ];
  }
}
