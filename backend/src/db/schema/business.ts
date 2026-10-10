import { boolean, date, jsonb, pgTable, smallint, text } from "drizzle-orm/pg-core";
import { baseColumns, ulid } from "../columns";

/** Where the business is (UI L47); the province is canonical when OmniSeller knows it (common/region.ts). */
export interface BusinessAddress {
  line1?: string;
  district?: string;
  city?: string;
  province?: string;
  postalCode?: string;
}

export type NibReminderStage = "30d" | "7d" | "passed";
export type DocumentReminderStage = "30d" | "7d" | "expired";
export type BusinessDocumentKind = "nib" | "npwp" | "sppkp" | "deed" | "business_license" | "other";

/** One per business (backend doc 8.29); the name and time zone are on `tenant`. */
export const businessProfile = pgTable("business_profile", {
  ...baseColumns(),
  address: jsonb("address").$type<BusinessAddress>().notNull().default({}),
  phone: text("phone"),
  logoFileId: ulid("logo_file_id"),
  nib: text("nib"),
  nibInProcessSince: date("nib_in_process_since", { mode: "string" }),
  nibRemindedStage: text("nib_reminded_stage").$type<NibReminderStage>(),
  npwp: text("npwp"),
  pkp: boolean("pkp").notNull().default(false),
  /** Months after the order its buyer's personal data is anonymized, 3 to 24 (migration 0025). */
  buyerDataRetentionMonths: smallint("buyer_data_retention_months").notNull().default(24),
});

export const businessDocument = pgTable("business_document", {
  ...baseColumns(),
  kind: text("kind").$type<BusinessDocumentKind>().notNull(),
  title: text("title").notNull(),
  number: text("number"),
  issuedOn: date("issued_on", { mode: "string" }),
  validUntil: date("valid_until", { mode: "string" }),
  fileObjectId: ulid("file_object_id").notNull(),
  fileName: text("file_name").notNull(),
  remindedStage: text("reminded_stage").$type<DocumentReminderStage>(),
  createdBy: ulid("created_by"),
});
