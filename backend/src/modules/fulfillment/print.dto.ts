import { PRINT_JOB_STATUSES, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { pageSchema, paginationQuery } from "../../common/http/pagination";
import type { DeviceRow } from "../identity/devices.repository";
import { isOnline } from "../identity/devices.service";
import type { PrintJobRow } from "./print.repository";

/** Print agents, print jobs, and the agent's own routes (FR-SHP-17, backend doc 8.24). */

const iso = z.iso.datetime();
const PRINT_KINDS = ["label", "pick_list", "packing_list", "invoice", "barcode", "manifest", "test"] as const;
const printerName = z.string().trim().min(1).max(200);

// ---- print requests (documents, scans, manifests) ----

/** Sends the document to a print agent once rendered; the printer defaults to the agent's for this paper. */
export const printTargetSchema = z.object({
  deviceId: ulidSchema.describe("agen cetak tujuan (GET /v1/print-agents)"),
  printer: printerName
    .nullable()
    .optional()
    .describe("nama printer di komputer agen; kosong: printer label atau dokumen agen, lalu printer bawaan komputer"),
  copies: z.number().int().min(1).max(10).default(1),
});

export const printJobSchema = z.object({
  id: ulidSchema,
  deviceId: ulidSchema,
  kind: z.enum(PRINT_KINDS),
  title: z.string(),
  status: z.enum(PRINT_JOB_STATUSES),
  /** queued without a file: the document is still being made. */
  waitingForDocument: z.boolean(),
  documentId: ulidSchema.nullable(),
  printer: z.string().nullable().describe("null: printer bawaan komputer agen"),
  copies: z.number().int(),
  attempts: z.number().int().describe("berapa kali agen mengambil berkasnya"),
  error: z.string().nullable(),
  requestedBy: ulidSchema.nullable(),
  createdAt: iso,
  sentAt: iso.nullable(),
  printedAt: iso.nullable(),
  statusChangedAt: iso,
});

export function printJobView(j: PrintJobRow): z.infer<typeof printJobSchema> {
  return {
    id: j.id,
    deviceId: j.deviceId,
    kind: j.kind,
    title: j.title,
    status: j.status,
    waitingForDocument: j.status === "queued" && !j.fileObjectId,
    documentId: j.documentId,
    printer: j.printerName,
    copies: j.copies,
    attempts: j.attempts,
    error: j.error,
    requestedBy: j.requestedBy,
    createdAt: j.createdAt.toISOString(),
    sentAt: j.sentAt?.toISOString() ?? null,
    printedAt: j.printedAt?.toISOString() ?? null,
    statusChangedAt: j.statusChangedAt.toISOString(),
  };
}

export class PrintJobDto extends createZodDto(printJobSchema) {}
export class PrintJobPageDto extends createZodDto(pageSchema(printJobSchema)) {}
export class PrintJobIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
export class PrintJobQueryDto extends createZodDto(
  paginationQuery.extend({
    deviceId: ulidSchema.optional(),
    status: z.enum(PRINT_JOB_STATUSES).optional(),
  }),
) {}

/** `POST /v1/print-jobs`: print a document (again). */
export class PrintDocumentDto extends createZodDto(printTargetSchema.extend({ documentId: ulidSchema })) {}

// ---- print agents (UI L42, L07) ----

const printerSchema = z.object({ name: z.string(), isDefault: z.boolean() });

const printAgentSchema = z.object({
  id: ulidSchema,
  name: z.string().describe("nama komputer, misalnya PC Gudang Jakarta"),
  warehouseId: ulidSchema.nullable().describe("gudang tempat agen ini; null: dipakai semua gudang"),
  connected: z.boolean().describe("agen melapor dalam 2 menit terakhir"),
  lastSeenAt: iso.nullable(),
  appVersion: z.string().nullable(),
  printers: z.array(printerSchema).describe("printer yang terdeteksi agen pada laporan terakhir"),
  labelPrinter: z.string().nullable().describe("printer untuk label (thermal dan label barcode)"),
  documentPrinter: z.string().nullable().describe("printer untuk dokumen A4"),
  createdAt: iso,
});

export function printAgentView(d: DeviceRow, now = Date.now()): z.infer<typeof printAgentSchema> {
  return {
    id: d.id,
    name: d.name,
    warehouseId: d.warehouseId,
    connected: isOnline(d, now),
    lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    appVersion: d.appVersion,
    printers: d.printers,
    labelPrinter: d.labelPrinter,
    documentPrinter: d.documentPrinter,
    createdAt: d.createdAt.toISOString(),
  };
}

export class PrintAgentDto extends createZodDto(printAgentSchema) {}
export class PrintAgentListDto extends createZodDto(z.object({ items: z.array(printAgentSchema) })) {}
export class PrintAgentIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export class CreatePrintAgentDto extends createZodDto(
  z.object({
    name: z.string().trim().min(1).max(80),
    warehouseId: ulidSchema.nullable().default(null),
  }),
) {}

/** The agent and its token: the token is shown once; the agent sends it as `Authorization: Bearer`. */
export class PairedPrintAgentDto extends createZodDto(
  z.object({
    agent: printAgentSchema,
    token: z.string().describe("ditampilkan sekali; tempel di aplikasi agen cetak"),
  }),
) {}

export class UpdatePrintAgentDto extends createZodDto(
  z
    .object({
      name: z.string().trim().min(1).max(80),
      warehouseId: ulidSchema.nullable(),
      labelPrinter: printerName.nullable(),
      documentPrinter: printerName.nullable(),
    })
    .partial(),
) {}

export class TestPrintDto extends createZodDto(z.object({ printer: printerName.nullable().optional() })) {}

// ---- the agent's routes (device token) ----

export const agentJobSchema = z.object({
  id: ulidSchema,
  attempt: z.number().int().positive(),
  kind: z.enum(PRINT_KINDS),
  title: z.string(),
  printer: z.string().nullable().describe("null: printer bawaan komputer"),
  copies: z.number().int(),
  createdAt: iso,
});
export class AgentJobListDto extends createZodDto(
  z.object({
    items: z.array(agentJobSchema).describe("antrean, terlama dulu; unduh berkas tiap pekerjaan lalu laporkan"),
  }),
) {}

export class AgentStatusDto extends createZodDto(
  z.object({
    appVersion: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(80).optional(),
    printers: z.array(z.object({ name: printerName, isDefault: z.boolean().default(false) })).max(50),
    labelPrinter: printerName.nullable().optional(),
    documentPrinter: printerName.nullable().optional(),
  }),
) {}

export class AgentResultDto extends createZodDto(
  z.object({
    status: z.enum(["printed", "failed"]),
    attempt: z.number().int().positive().optional(),
    error: z.string().trim().max(500).optional().describe("pesan printer saat gagal"),
  }),
) {}

export class AgentJobResultDto extends createZodDto(z.object({ id: ulidSchema, status: z.enum(PRINT_JOB_STATUSES) })) {}

export class AgentTakeQueryDto extends createZodDto(
  z.object({ attempt: z.coerce.number().int().positive().optional() }),
) {}

/** What the agent learns about itself after a status report. */
export class AgentSelfDto extends createZodDto(
  z.object({
    id: ulidSchema,
    name: z.string(),
    labelPrinter: z.string().nullable(),
    documentPrinter: z.string().nullable(),
  }),
) {}
