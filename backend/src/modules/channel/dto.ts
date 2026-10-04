import { ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { pageSchema, paginationQuery } from "../../common/http/pagination";
import { STORE_STATUS_REASONS } from "./channel.errors";
import type { ChannelWarehouseRow } from "./channel.repository";
import { SUPPORTED_CHANNELS } from "./connector-registry";
import type { AuthorizationView } from "./store-authorization.service";
import { channelDisplayName, type StoreView, statusMessage } from "./stores.service";

/** Request and response DTOs of the store connection endpoints (backend doc 10.6). */

const iso = z.iso.datetime();
const channel = z.enum(SUPPORTED_CHANNELS);

export class StoreIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
export class ChannelWarehouseParamDto extends createZodDto(
  z.object({ id: ulidSchema, channelWarehouseId: ulidSchema }),
) {}
export class SyncJobsQueryDto extends createZodDto(paginationQuery) {}

// ---- channels ----

const channelSchema = z.object({
  id: channel,
  name: z.string(),
  available: z.boolean().describe("false when OmniSeller has no app keys for this marketplace yet"),
  regions: z.array(z.string()),
});
export class ChannelListDto extends createZodDto(z.object({ items: z.array(channelSchema) })) {}

// ---- store authorizations ----

export class StartAuthorizationDto extends createZodDto(
  z.object({
    channel,
    storeId: ulidSchema.optional().describe("set to reconnect an existing store; the seller must authorize that shop"),
  }),
) {}

/** What the marketplace appended to the redirect URL, forwarded by the web app. */
export class AuthorizationCallbackDto extends createZodDto(
  z.object({
    channel,
    state: z.string().min(16).max(128),
    code: z.string().max(512).optional(),
    shopId: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe("Shopee: shop_id"),
    mainAccountId: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional()
      .describe("Shopee: main_account_id"),
    error: z.string().max(200).optional().describe("TikTok Shop: error=auth_denied when the seller declined"),
  }),
) {}

const authorizationSchema = z.object({
  id: ulidSchema,
  channel: z.string(),
  storeId: ulidSchema.nullable(),
  status: z.enum(["pending", "exchanging", "succeeded", "failed", "expired"]),
  expiresAt: iso,
  callbackAt: iso.nullable(),
  completedAt: iso.nullable(),
  result: z.object({
    stores: z.array(
      z.object({ storeId: ulidSchema, externalShopId: z.string(), name: z.string(), reconnected: z.boolean() }),
    ),
    skipped: z.array(z.object({ externalShopId: z.string(), region: z.string().nullable(), reason: z.string() })),
    failed: z.array(z.object({ externalShopId: z.string(), reason: z.string() })),
  }),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: iso,
});
export class AuthorizationDto extends createZodDto(authorizationSchema) {}
export class StartedAuthorizationDto extends createZodDto(
  authorizationSchema.extend({ authorizeUrl: z.url().describe("open this in the browser (same tab)") }),
) {}

export function authorizationView(v: AuthorizationView): z.infer<typeof authorizationSchema> {
  const r = v.row;
  const result = (r.result ?? {}) as Partial<z.infer<typeof authorizationSchema>["result"]>;
  return {
    id: r.id,
    channel: r.channel,
    storeId: r.storeId,
    status: v.status,
    expiresAt: r.expiresAt.toISOString(),
    callbackAt: r.callbackAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    result: { stores: result.stores ?? [], skipped: result.skipped ?? [], failed: result.failed ?? [] },
    errorCode: v.status === "expired" && !r.errorCode ? "expired" : r.errorCode,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.toISOString(),
  };
}

// ---- stores ----

const storeSchema = z.object({
  id: ulidSchema,
  channel: z.string(),
  channelName: z.string(),
  externalShopId: z.string(),
  name: z.string(),
  region: z.string(),
  status: z.enum(["connecting", "active", "token_expiring", "reauth_required", "disconnected"]),
  statusReason: z.enum(Object.keys(STORE_STATUS_REASONS) as [string, ...string[]]).nullable(),
  statusMessage: z.string().nullable(),
  statusChangedAt: iso,
  syncMode: z.enum(["read_only", "live"]),
  syncModeChangedAt: iso.nullable().describe("last change of sync mode; null when unchanged since connecting"),
  defaultWarehouseId: ulidSchema.nullable(),
  connectedAt: iso.nullable(),
  disconnectedAt: iso.nullable(),
  authorizationExpiresAt: iso.nullable().describe("end of the seller's authorization; reconnect before it"),
  accessTokenExpiresAt: iso.nullable(),
  lastTokenRefreshAt: iso.nullable(),
  tokenRefreshFailures: z.number().int(),
  unmappedWarehouses: z.number().int().describe("active marketplace warehouses without a mapping; stock sync needs 0"),
  lastProductSyncAt: iso.nullable().describe("last finished listing pull"),
  lastOrderSyncAt: iso.nullable().describe("last finished order pull; null while the first 90-day import runs"),
  marketplaceInfo: z.record(z.string(), z.unknown()),
  autoAllocate: z
    .boolean()
    .describe("pesanan toko tanpa multi-gudang dikirim dari gudang terdekat yang stoknya cukup (FR-ORD-12)"),
  createdAt: iso,
});
export class StoreDto extends createZodDto(storeSchema) {}
export class StoreListDto extends createZodDto(z.object({ items: z.array(storeSchema) })) {}
export class DisconnectedStoreDto extends createZodDto(
  z.object({
    store: storeSchema,
    revokeUrl: z.url().nullable().describe("where the seller also revokes OmniSeller on the marketplace (Shopee)"),
  }),
) {}

export class UpdateStoreDto extends createZodDto(
  z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      defaultWarehouseId: ulidSchema.nullable().optional(),
      syncMode: z.enum(["read_only", "live"]).optional(),
      autoAllocate: z.boolean().optional().describe("alokasi gudang otomatis untuk toko tanpa multi-gudang"),
    })
    .refine((v) => Object.keys(v).length > 0, { message: "Tidak ada yang diubah." }),
) {}

/** A sales channel for manual orders (FR-ORD-09): WhatsApp, Instagram, a shop counter. */
export class CreateManualStoreDto extends createZodDto(
  z.object({
    name: z.string().trim().min(1).max(80),
    defaultWarehouseId: ulidSchema
      .nullable()
      .optional()
      .describe("gudang bawaan; kosong: dipilih otomatis per pesanan"),
  }),
) {}

export function storeView(v: StoreView): z.infer<typeof storeSchema> {
  const s = v.store;
  return {
    id: s.id,
    channel: s.channel,
    channelName: channelDisplayName(s.channel),
    externalShopId: s.externalShopId,
    name: s.name,
    region: s.region,
    status: s.status,
    statusReason: s.statusReason && s.statusReason in STORE_STATUS_REASONS ? s.statusReason : null,
    statusMessage: statusMessage(s.statusReason),
    statusChangedAt: s.statusChangedAt.toISOString(),
    syncMode: s.syncMode,
    syncModeChangedAt: s.syncModeChangedAt?.toISOString() ?? null,
    defaultWarehouseId: s.defaultWarehouseId,
    connectedAt: s.connectedAt?.toISOString() ?? null,
    disconnectedAt: s.disconnectedAt?.toISOString() ?? null,
    authorizationExpiresAt: s.authorizationExpiresAt?.toISOString() ?? null,
    accessTokenExpiresAt: v.credential?.accessExpiresAt?.toISOString() ?? null,
    lastTokenRefreshAt: v.credential?.lastRefreshedAt?.toISOString() ?? null,
    tokenRefreshFailures: v.credential?.refreshFailCount ?? 0,
    unmappedWarehouses: v.unmappedWarehouses,
    lastProductSyncAt: s.lastProductSyncAt?.toISOString() ?? null,
    lastOrderSyncAt: s.lastOrderSyncAt?.toISOString() ?? null,
    marketplaceInfo: s.marketplaceInfo,
    autoAllocate: s.settings.autoAllocate === true,
    createdAt: s.createdAt.toISOString(),
  };
}

// ---- channel warehouses ----

const channelWarehouseSchema = z.object({
  id: ulidSchema,
  externalWarehouseId: z.string(),
  name: z.string(),
  kind: z.enum(["seller", "fulfillment"]),
  mappingStatus: z.enum(["unmapped", "mapped", "marketplace_managed"]),
  warehouseId: ulidSchema.nullable(),
  isDefault: z.boolean(),
  active: z.boolean().describe("false when the marketplace no longer lists this warehouse"),
  address: z.record(z.string(), z.unknown()).nullable(),
  lastSeenAt: iso,
});
export class ChannelWarehouseDto extends createZodDto(channelWarehouseSchema) {}
export class ChannelWarehouseListDto extends createZodDto(z.object({ items: z.array(channelWarehouseSchema) })) {}
export class MapChannelWarehouseDto extends createZodDto(
  z.object({ warehouseId: ulidSchema.nullable().describe("null removes the mapping") }),
) {}

export function channelWarehouseView(w: ChannelWarehouseRow): z.infer<typeof channelWarehouseSchema> {
  return {
    id: w.id,
    externalWarehouseId: w.externalWarehouseId,
    name: w.name,
    kind: w.kind,
    mappingStatus: w.mappingStatus,
    warehouseId: w.warehouseId,
    isDefault: w.isDefault,
    active: w.active,
    address: w.address,
    lastSeenAt: w.lastSeenAt.toISOString(),
  };
}

// ---- sync log ----

const syncJobSchema = z.object({
  id: ulidSchema,
  kind: z.string(),
  direction: z.enum(["pull", "push"]),
  status: z.enum(["queued", "running", "succeeded", "failed", "skipped"]),
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
  durationMs: z.number().int().nullable(),
  attempts: z.number().int(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  calls: z.array(z.record(z.string(), z.unknown())).describe("redacted HTTP calls made to the marketplace"),
});
export class SyncJobPageDto extends createZodDto(pageSchema(syncJobSchema)) {}

export function syncJobView(j: {
  id: string;
  kind: string;
  direction: "pull" | "push";
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  responseSummary: Record<string, unknown> | null;
}): z.infer<typeof syncJobSchema> {
  const summary = j.responseSummary ?? {};
  return {
    id: j.id,
    kind: j.kind,
    direction: j.direction,
    status: j.status,
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
    durationMs: j.durationMs,
    attempts: j.attempts,
    errorCode: j.errorCode,
    errorMessage: j.errorMessage,
    result: (summary.result as Record<string, unknown> | undefined) ?? null,
    calls: (summary.calls as Record<string, unknown>[] | undefined) ?? [],
  };
}
