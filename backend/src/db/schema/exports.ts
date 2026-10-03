import type { DataExportStatus } from "@omniseller/shared";
import { bigint, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { baseColumns, tstz, ulid } from "../columns";

export interface DataExportResult {
  /** Each CSV in the ZIP and its data rows. */
  files?: { name: string; rows: number }[];
}

/** Full data export (PRD FR-MIG-09, backend doc 8.18). Status changes are checked by trigger. */
export const dataExport = pgTable("data_export", {
  ...baseColumns(),
  status: text("status").$type<DataExportStatus>().notNull().default("queued"),
  statusChangedAt: tstz("status_changed_at").notNull().defaultNow(),
  fileObjectId: ulid("file_object_id"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  result: jsonb("result").$type<DataExportResult>().notNull().default({}),
  error: text("error"),
  requestedBy: ulid("requested_by"),
  finishedAt: tstz("finished_at"),
  /** When the ZIP is deleted (7 days after it is ready). */
  expiresAt: tstz("expires_at"),
  /** Every download is audited: the count changes, the trigger records who. */
  downloadCount: integer("download_count").notNull().default(0),
  lastDownloadedAt: tstz("last_downloaded_at"),
});
