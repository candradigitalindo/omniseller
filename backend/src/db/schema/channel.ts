import type { Channel } from "@omniseller/shared";
import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, bytea, tstz, ulid } from "../columns";

export type StoreStatus = "connecting" | "active" | "token_expiring" | "reauth_required" | "disconnected";

export const store = pgTable("store", {
  ...baseColumns(),
  channel: text("channel").$type<Channel>().notNull(),
  externalShopId: text("external_shop_id").notNull(),
  name: text("name").notNull(),
  region: text("region").notNull().default("ID"),
  status: text("status").$type<StoreStatus>().notNull().default("connecting"),
  /** read_only is the parallel migration mode: no stock push, no order processing. */
  syncMode: text("sync_mode").$type<"read_only" | "live">().notNull().default("read_only"),
  defaultWarehouseId: ulid("default_warehouse_id"),
  connectedAt: tstz("connected_at"),
  disconnectedAt: tstz("disconnected_at"),
  lastOrderSyncAt: tstz("last_order_sync_at"),
  lastProductSyncAt: tstz("last_product_sync_at"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  /** When the seller's authorization for OmniSeller ends (Shopee up to 365 days, TikTok Shop per grant). */
  authorizationExpiresAt: tstz("authorization_expires_at"),
  /** Machine code explaining the current status, e.g. `authorization_revoked`, `refresh_failed`. */
  statusReason: text("status_reason"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  /** Non-secret marketplace metadata (seller type, shop code, logo, fulfillment flag). */
  marketplaceInfo: jsonb("marketplace_info").$type<Record<string, unknown>>().notNull().default({}),
});

export type StoreAuthorizationStatus = "pending" | "exchanging" | "succeeded" | "failed" | "expired";

/** One connect or reconnect attempt: the OAuth state (hashed) and the outcome of the code exchange. */
export const storeAuthorization = pgTable("store_authorization", {
  ...baseColumns(),
  channel: text("channel").$type<Channel>().notNull(),
  storeId: ulid("store_id"),
  requestedBy: ulid("requested_by"),
  stateHash: text("state_hash").notNull(),
  status: text("status").$type<StoreAuthorizationStatus>().notNull().default("pending"),
  expiresAt: tstz("expires_at").notNull(),
  callbackAt: tstz("callback_at"),
  completedAt: tstz("completed_at"),
  result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
});

/** Readable only by omniseller_worker (token columns); omniseller_api sees expiry metadata only. */
export const storeCredential = pgTable("store_credential", {
  ...baseColumns(),
  storeId: ulid("store_id").notNull(),
  accessTokenEnc: bytea("access_token_enc").notNull(),
  refreshTokenEnc: bytea("refresh_token_enc"),
  dekVersion: integer("dek_version").notNull(),
  accessExpiresAt: tstz("access_expires_at"),
  refreshExpiresAt: tstz("refresh_expires_at"),
  scopes: text("scopes").array().notNull().default([]),
  lastRefreshedAt: tstz("last_refreshed_at"),
  refreshFailCount: integer("refresh_fail_count").notNull().default(0),
  /** TikTok Shop shop_cipher; kept with the tokens so a disconnect removes both. */
  shopCipher: text("shop_cipher"),
});

export const channelWarehouse = pgTable("channel_warehouse", {
  ...baseColumns(),
  storeId: ulid("store_id").notNull(),
  externalWarehouseId: text("external_warehouse_id").notNull(),
  name: text("name").notNull(),
  address: jsonb("address").$type<Record<string, unknown>>(),
  kind: text("kind").$type<"seller" | "fulfillment">().notNull(),
  warehouseId: ulid("warehouse_id"),
  mappingStatus: text("mapping_status")
    .$type<"unmapped" | "mapped" | "marketplace_managed">()
    .notNull()
    .default("unmapped"),
  isDefault: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
  lastSeenAt: tstz("last_seen_at").notNull(),
});

export const syncCursor = pgTable("sync_cursor", {
  ...baseColumns(),
  storeId: ulid("store_id").notNull(),
  resource: text("resource").notNull(),
  cursor: text("cursor").notNull(),
  advancedAt: tstz("advanced_at").notNull(),
});
