import { DATA_EXPORT_STATUSES, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { DataExportRow } from "./exports.repository";

const iso = z.iso.datetime();

export class ExportIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

const exportSchema = z.object({
  id: ulidSchema,
  status: z.enum(DATA_EXPORT_STATUSES),
  requestedBy: ulidSchema.nullable(),
  createdAt: iso,
  finishedAt: iso.nullable(),
  /** When the ZIP is deleted; null until it is ready. */
  expiresAt: iso.nullable(),
  expired: z.boolean(),
  sizeBytes: z.number().int().nullable(),
  /** Each CSV in the ZIP and its data rows. */
  files: z.array(z.object({ name: z.string(), rows: z.number().int() })),
  error: z.string().nullable(),
  downloadCount: z.number().int(),
  lastDownloadedAt: iso.nullable(),
  /** `/v1/exports/{id}/download` while the ZIP can be downloaded. */
  downloadUrl: z.string().nullable(),
});

export class DataExportDto extends createZodDto(exportSchema) {}
export class DataExportListDto extends createZodDto(z.object({ items: z.array(exportSchema) })) {}

export function exportView(e: DataExportRow, now = new Date()): z.infer<typeof exportSchema> {
  const expired = e.status === "ready" && (!e.fileObjectId || (e.expiresAt !== null && e.expiresAt <= now));
  return {
    id: e.id,
    status: e.status,
    requestedBy: e.requestedBy,
    createdAt: e.createdAt.toISOString(),
    finishedAt: e.finishedAt?.toISOString() ?? null,
    expiresAt: e.expiresAt?.toISOString() ?? null,
    expired,
    sizeBytes: e.sizeBytes,
    files: e.result.files ?? [],
    error: e.error,
    downloadCount: e.downloadCount,
    lastDownloadedAt: e.lastDownloadedAt?.toISOString() ?? null,
    downloadUrl: e.status === "ready" && !expired ? `/v1/exports/${e.id}/download` : null,
  };
}
