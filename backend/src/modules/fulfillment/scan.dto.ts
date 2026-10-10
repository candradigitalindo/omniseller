import { CHANNELS, HANDOVER_STATUSES, ORDER_STATUSES, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { pageSchema, paginationQuery } from "../../common/http/pagination";
import type { OrderRow } from "../orders/orders.repository";
import { orderStatusLabel } from "../orders/orders.service";
import { documentSchema } from "./dto";
import type { HandoverItemRow } from "./handover.repository";
import type { HandoverView } from "./handover.service";
import type { PackingView } from "./packing.service";
import { printJobSchema, printTargetSchema } from "./print.dto";

/** Scan to print, packing by scan, and courier handover (FR-SHP-17, 04, 05; backend doc 8.24). */

const iso = z.iso.datetime();
const code = z.string().trim().min(1).max(64).describe("nomor pesanan atau nomor resi seperti terbaca pemindai");
const refusalSchema = z.object({ code: z.string(), message: z.string() });
const labelOptions = z.object({
  format: z.enum(["thermal", "a4"]).default("thermal"),
  template: z.enum(["standard", "custom"]).default("standard"),
  packingList: z.boolean().default(false).describe("daftar kemas tepat setelah label"),
});

const scannedOrderSchema = z.object({
  id: ulidSchema,
  number: z.string(),
  channel: z.enum(CHANNELS),
  storeId: ulidSchema,
  status: z.enum(ORDER_STATUSES),
  statusLabel: z.string(),
  warehouseId: ulidSchema.nullable(),
  trackingNumber: z.string().nullable(),
  courier: z.string().nullable(),
});

export const scannedOrderView = (o: OrderRow): z.infer<typeof scannedOrderSchema> => ({
  id: o.id,
  number: o.externalOrderId,
  channel: o.channel,
  storeId: o.storeId,
  status: o.status,
  statusLabel: orderStatusLabel(o.status),
  warehouseId: o.warehouseId,
  trackingNumber: o.trackingNumber,
  courier: o.shippingProvider,
});

// ---- scan to print (FR-SHP-17) ----

export class ScanPrintDto extends createZodDto(printTargetSchema.extend({ code }).extend(labelOptions.shape)) {}
export class ScanPrintResultDto extends createZodDto(
  z.object({ order: scannedOrderSchema, documentId: ulidSchema, printJob: printJobSchema }),
) {}

// ---- packing by scan (FR-SHP-04, UI L06) ----

export class PackingLookupQueryDto extends createZodDto(z.object({ code })) {}

const packingLineSchema = z.object({
  key: z
    .string()
    .describe("id varian, atau sku:<SKU> untuk baris tanpa produk; boleh dikirim sebagai kode bila dihitung manual"),
  variantId: ulidSchema.nullable(),
  sku: z.string(),
  barcode: z.string().nullable(),
  name: z.string(),
  variantName: z.string().nullable(),
  imageUrl: z.string().nullable(),
  qty: z.number().int(),
});

export class PackingViewDto extends createZodDto(
  z.object({
    order: scannedOrderSchema.extend({ note: z.string().nullable().describe("catatan pembeli") }),
    packable: z.boolean(),
    packRefusal: refusalSchema.nullable().describe("kenapa pesanan belum bisa dikemas"),
    labelRefusal: refusalSchema.nullable().describe("kenapa labelnya belum bisa dicetak"),
    lines: z.array(packingLineSchema),
  }),
) {}

export const packingView = (v: PackingView) => ({
  order: { ...scannedOrderView(v.order), note: v.order.buyerNote },
  packable: v.packRefusal === null,
  packRefusal: v.packRefusal,
  labelRefusal: v.labelRefusal,
  lines: v.lines.map(({ codes: _, ...line }) => line),
});

export class OrderIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export class CompletePackingDto extends createZodDto(
  z.object({
    scans: z
      .array(
        z.object({
          // the item's barcode, SKU, or line key: not the order code the lookup took
          code: code.describe("barcode, SKU, atau kunci baris (`lines[].key`) barang yang dipindai"),
          qty: z.number().int().min(1).max(1000).default(1),
        }),
      )
      .min(1)
      .max(500)
      .describe("kode yang dipindai dan berapa kali; jumlah per baris harus sama persis dengan pesanan"),
    seconds: z
      .number()
      .int()
      .min(0)
      .max(86_400)
      .optional()
      .describe("detik sejak pesanan dipindai sampai dikemas, diukur stasiun; untuk laporan kinerja tim"),
    print: printTargetSchema
      .extend(labelOptions.shape)
      .optional()
      .describe("Cetak label dan lanjut: label dikirim ke agen cetak setelah pesanan dikemas"),
  }),
) {}

export class PackingResultDto extends createZodDto(
  z.object({
    order: scannedOrderSchema,
    documentId: ulidSchema.nullable(),
    printJob: printJobSchema.nullable(),
    printRefusal: refusalSchema.nullable().describe("label belum bisa dicetak; pesanan tetap dikemas"),
  }),
) {}

// ---- courier handover (FR-SHP-05, UI L08) ----

export class OpenHandoverDto extends createZodDto(
  z.object({ warehouseId: ulidSchema, courier: z.string().trim().min(1).max(80) }),
) {}

const handoverSchema = z.object({
  id: ulidSchema,
  number: z.string(),
  warehouseId: ulidSchema,
  courier: z.string(),
  status: z.enum(HANDOVER_STATUSES),
  parcels: z.number().int(),
  receivedBy: z.string().nullable().describe("nama kurir penerima"),
  createdBy: ulidSchema.nullable(),
  completedBy: ulidSchema.nullable(),
  completedAt: iso.nullable(),
  createdAt: iso,
});

export const handoverView = (v: HandoverView): z.infer<typeof handoverSchema> => ({
  id: v.handover.id,
  number: v.handover.number,
  warehouseId: v.handover.warehouseId,
  courier: v.handover.courier,
  status: v.handover.status,
  parcels: v.parcels,
  receivedBy: v.handover.receivedBy,
  createdBy: v.handover.createdBy,
  completedBy: v.handover.completedBy,
  completedAt: v.handover.completedAt?.toISOString() ?? null,
  createdAt: v.handover.createdAt.toISOString(),
});

const handoverItemSchema = z.object({
  id: ulidSchema,
  orderId: ulidSchema,
  trackingNumber: z.string(),
  orderNumber: z.string(),
  scannedBy: ulidSchema.nullable(),
  scannedAt: iso,
});

export const handoverItemView = (i: HandoverItemRow): z.infer<typeof handoverItemSchema> => ({
  id: i.id,
  orderId: i.orderId,
  trackingNumber: i.trackingNumber,
  orderNumber: i.orderNumber,
  scannedBy: i.scannedBy,
  scannedAt: i.createdAt.toISOString(),
});

export class HandoverDto extends createZodDto(handoverSchema) {}
export class HandoverPageDto extends createZodDto(pageSchema(handoverSchema)) {}
export class HandoverDetailDto extends createZodDto(handoverSchema.extend({ items: z.array(handoverItemSchema) })) {}
export class HandoverIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
export class HandoverItemParamDto extends createZodDto(z.object({ id: ulidSchema, itemId: ulidSchema })) {}
export class HandoverQueryDto extends createZodDto(
  paginationQuery.extend({ status: z.enum(HANDOVER_STATUSES).optional(), warehouseId: ulidSchema.optional() }),
) {}
export class HandoverCouriersQueryDto extends createZodDto(z.object({ warehouseId: ulidSchema })) {}
export class HandoverCouriersDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        courier: z.string().nullable().describe("null: pesanan manual tanpa kurir"),
        parcels: z.number().int().describe("paket dikemas yang menunggu kurir ini"),
      }),
    ),
  }),
) {}

export class HandoverScanDto extends createZodDto(z.object({ code })) {}
export class HandoverScanResultDto extends createZodDto(
  z.object({
    item: handoverItemSchema,
    parcels: z.number().int(),
    duplicate: z.boolean().describe("paket ini sudah ada di manifest; tidak ditambah lagi"),
  }),
) {}

export class CompleteHandoverDto extends createZodDto(
  z.object({
    receivedBy: z.string().trim().max(80).nullable().optional().describe("nama kurir yang menerima"),
    print: printTargetSchema.optional().describe("cetak manifest di agen cetak"),
  }),
) {}
export class ManifestRequestDto extends createZodDto(z.object({ print: printTargetSchema.optional() })) {}

export class CompletedHandoverDto extends createZodDto(
  z.object({ handover: handoverSchema, document: documentSchema, printJob: printJobSchema.nullable() }),
) {}
export class ManifestDocumentDto extends createZodDto(
  z.object({ document: documentSchema, printJob: printJobSchema.nullable() }),
) {}
