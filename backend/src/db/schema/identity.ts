import { boolean, customType, inet, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, bytea, globalColumns, tstz, ulid } from "../columns";

const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

export interface TenantLegal {
  nib?: string;
  npwp?: string;
  pkp?: boolean;
  documents?: { kind: string; fileObjectId: string; validUntil?: string }[];
}

export const tenant = pgTable("tenant", {
  ...globalColumns(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  timezone: text("timezone").notNull().default("Asia/Jakarta"),
  status: text("status").$type<"active" | "suspended" | "closing" | "closed">().notNull().default("active"),
  planId: ulid("plan_id").notNull(),
  legal: jsonb("legal").$type<TenantLegal>().notNull().default({}),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
});

export const permission = pgTable("permission", {
  id: ulid("id").primaryKey(),
  code: text("code").notNull(),
  module: text("module").notNull(),
  description: text("description"),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

export const user = pgTable("user", {
  ...baseColumns(),
  email: citext("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  status: text("status").$type<"invited" | "active" | "disabled">().notNull().default("invited"),
  totpSecretEnc: bytea("totp_secret_enc"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  locale: text("locale").$type<"id" | "en">().notNull().default("id"),
  lastLoginAt: tstz("last_login_at"),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: tstz("locked_until"),
});

export const role = pgTable("role", {
  ...baseColumns(),
  name: text("name").notNull(),
  isSystem: boolean("is_system").notNull().default(false),
  description: text("description"),
});

export const rolePermission = pgTable("role_permission", {
  ...baseColumns(),
  roleId: ulid("role_id").notNull(),
  permissionId: ulid("permission_id").notNull(),
});

export const userRole = pgTable("user_role", {
  ...baseColumns(),
  userId: ulid("user_id").notNull(),
  roleId: ulid("role_id").notNull(),
});

export const userStoreScope = pgTable("user_store_scope", {
  ...baseColumns(),
  userId: ulid("user_id").notNull(),
  storeId: ulid("store_id").notNull(),
});

export const userWarehouseScope = pgTable("user_warehouse_scope", {
  ...baseColumns(),
  userId: ulid("user_id").notNull(),
  warehouseId: ulid("warehouse_id").notNull(),
});

export const invitation = pgTable("invitation", {
  ...baseColumns(),
  email: citext("email").notNull(),
  roleId: ulid("role_id").notNull(),
  invitedBy: ulid("invited_by"),
  /** Set by the job that sends the email (migration 0002); NULL until the first send. */
  tokenHash: text("token_hash"),
  expiresAt: tstz("expires_at").notNull(),
  acceptedAt: tstz("accepted_at"),
  acceptedUserId: ulid("accepted_user_id"),
  sentAt: tstz("sent_at"),
  revokedAt: tstz("revoked_at"),
});

export const passwordResetToken = pgTable("password_reset_token", {
  ...baseColumns(),
  userId: ulid("user_id").notNull(),
  tokenHash: text("token_hash"),
  expiresAt: tstz("expires_at").notNull(),
  usedAt: tstz("used_at"),
});

export const device = pgTable("device", {
  ...baseColumns(),
  kind: text("kind").$type<"print_agent" | "mobile">().notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  warehouseId: ulid("warehouse_id"),
  appVersion: text("app_version"),
  lastSeenAt: tstz("last_seen_at"),
  revokedAt: tstz("revoked_at"),
});

export const refreshToken = pgTable("refresh_token", {
  ...baseColumns(),
  userId: ulid("user_id").notNull(),
  deviceId: ulid("device_id"),
  tokenHash: text("token_hash").notNull(),
  expiresAt: tstz("expires_at").notNull(),
  revokedAt: tstz("revoked_at"),
  rotatedFromId: ulid("rotated_from_id"),
  userAgent: text("user_agent"),
  ip: inet("ip"),
});

export const apiKey = pgTable("api_key", {
  ...baseColumns(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  scopes: text("scopes").array().notNull().default([]),
  lastUsedAt: tstz("last_used_at"),
  revokedAt: tstz("revoked_at"),
  createdBy: ulid("created_by"),
});
