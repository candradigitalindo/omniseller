import { bigint, boolean, pgTable, smallint, text } from "drizzle-orm/pg-core";
import { baseColumns, globalColumns, tstz, ulid } from "../columns";

export const featureFlag = pgTable("feature_flag", {
  ...globalColumns(),
  key: text("key").notNull(),
  description: text("description"),
  enabledDefault: boolean("enabled_default").notNull().default(false),
  rolloutPct: smallint("rollout_pct").notNull().default(0),
});

export const featureFlagOverride = pgTable("feature_flag_override", {
  ...baseColumns(),
  flagId: ulid("flag_id").notNull(),
  enabled: boolean("enabled").notNull(),
});

export type FilePurpose =
  | "product_image"
  | "label"
  | "pick_list"
  | "export"
  | "import"
  | "settlement"
  | "tax_document"
  | "evidence"
  | "other";

/** tenant_id is NULL for system files. */
export const fileObject = pgTable("file_object", {
  ...globalColumns(),
  tenantId: ulid("tenant_id"),
  bucket: text("bucket").notNull(),
  objectKey: text("object_key").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256"),
  purpose: text("purpose").$type<FilePurpose>().notNull(),
  expiresAt: tstz("expires_at"),
  createdBy: ulid("created_by"),
});
