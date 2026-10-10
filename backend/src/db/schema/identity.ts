import { bigint, boolean, customType, inet, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
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
  /** Account closure (backend doc 8.36): read only until `purge_after`, then deleted (`purged_at`). */
  closingAt: tstz("closing_at"),
  closedBy: ulid("closed_by"),
  purgeAfter: tstz("purge_after"),
  purgeRemindedAt: tstz("purge_reminded_at"),
  purgedAt: tstz("purged_at"),
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
  /** HMAC of each unused backup code (migration 0020, backend doc 8.30). */
  totpBackupCodes: text("totp_backup_codes").array().notNull().default([]),
  /** Last time step a code was accepted for; codes of that step or earlier are refused (replay). */
  totpLastStep: bigint("totp_last_step", { mode: "number" }),
  totpEnabledAt: tstz("totp_enabled_at"),
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
  /** NULL only once accepted or revoked and the custom role it offered was deleted (migration 0024). */
  roleId: ulid("role_id"),
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

/** A printer as the print agent reported it (backend doc 8.24). */
export interface ReportedPrinter {
  name: string;
  /** The computer's default printer. */
  isDefault: boolean;
}

export const device = pgTable("device", {
  ...baseColumns(),
  kind: text("kind").$type<"print_agent" | "mobile">().notNull(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  warehouseId: ulid("warehouse_id"),
  appVersion: text("app_version"),
  lastSeenAt: tstz("last_seen_at"),
  revokedAt: tstz("revoked_at"),
  printers: jsonb("printers").$type<ReportedPrinter[]>().notNull().default([]),
  labelPrinter: text("label_printer"),
  documentPrinter: text("document_printer"),
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
