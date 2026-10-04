import { DOCUMENT_JOB_STATUSES, SHIPMENT_STATUSES, type ShipmentStatus, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { TRACKING_STAGES } from "../../db/schema";
import type { DocumentRow } from "./fulfillment.repository";
import type { ShipmentView, TrackingView } from "./fulfillment.service";
import type { PickListSection } from "./pick-list.builder";
import { type LabelTemplateOptions, TRACKING_STAGE_LABELS } from "./shipping-plan";

/** Request and response DTOs of the fulfillment endpoints (backend doc 10.6). */

const iso = z.iso.datetime();
const METHODS = ["pickup", "dropoff"] as const;
const FORMATS = ["thermal", "a4"] as const;
const KINDS = ["labels", "pick_list", "packing_list"] as const;
const TEMPLATES = ["standard", "custom"] as const;

export class ArrangeShipmentsDto extends createZodDto(
  z.object({
    orderIds: z.array(ulidSchema).min(1).max(500),
    /** pickup: the courier comes to the warehouse's pickup address; dropoff: the seller brings parcels to a courier point. */
    method: z.enum(METHODS),
  }),
) {}

export class OrderLabelsDto extends createZodDto(z.object({ orderIds: z.array(ulidSchema).min(1).max(500) })) {}
export class LabelsQueuedDto extends createZodDto(z.object({ queued: z.number().int() })) {}

const STATUS_LABELS: Record<ShipmentStatus, string> = {
  pending: "Menunggu diatur",
  arranged: "Pengiriman diatur",
  label_ready: "Label siap",
  packed: "Dikemas",
  handed_over: "Diserahkan ke kurir",
  in_transit: "Dalam perjalanan",
  delivered: "Sampai",
  failed: "Gagal kirim",
  rto_in_transit: "Kembali ke pengirim",
  rto_received: "Diterima kembali",
  cancelled: "Dibatalkan",
};

const shipmentSchema = z.object({
  id: ulidSchema,
  orderId: ulidSchema,
  status: z.enum(SHIPMENT_STATUSES),
  statusLabel: z.string(),
  method: z.enum(METHODS).nullable(),
  provider: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  pickupAt: iso.nullable(),
  arrangedAt: iso.nullable(),
  packedAt: iso.nullable(),
  deliveredAt: iso.nullable(),
  /** The last arrangement or label problem, in the seller's words. */
  lastError: z.string().nullable(),
  labelReady: z.boolean(),
  packages: z.array(
    z.object({
      id: ulidSchema,
      externalPackageId: z.string().nullable(),
      trackingNumber: z.string().nullable(),
      /** Download with GET /v1/files/{labelFileId}/download. */
      labelFileId: ulidSchema.nullable(),
      items: z.array(z.object({ orderItemId: ulidSchema, qty: z.number().int() })),
    }),
  ),
  /** Where the parcel is, from the marketplace (FR-SHP-07); the journey is at /v1/orders/{id}/tracking. */
  trackingStage: z.enum(TRACKING_STAGES).nullable(),
  trackingStageLabel: z.string().nullable(),
  trackingEventAt: iso.nullable(),
  trackingSyncedAt: iso.nullable(),
  createdAt: iso,
});

export class ShipmentListDto extends createZodDto(z.object({ items: z.array(shipmentSchema) })) {}

export function shipmentView(v: ShipmentView): z.infer<typeof shipmentSchema> {
  const s = v.shipment;
  return {
    id: s.id,
    orderId: s.orderId,
    status: s.status,
    statusLabel: STATUS_LABELS[s.status],
    method: s.pickupType,
    provider: s.provider,
    trackingNumber: s.trackingNumber,
    pickupAt: s.pickupAt?.toISOString() ?? null,
    arrangedAt: s.arrangedAt?.toISOString() ?? null,
    packedAt: s.packedAt?.toISOString() ?? null,
    deliveredAt: s.deliveredAt?.toISOString() ?? null,
    lastError: s.lastError,
    labelReady: v.packages.length > 0 && v.packages.every((p) => p.labelFileId),
    packages: v.packages.map((p) => ({
      id: p.id,
      externalPackageId: p.externalPackageId,
      trackingNumber: p.trackingNumber,
      labelFileId: p.labelFileId,
      items: p.items,
    })),
    trackingStage: s.trackingStage,
    trackingStageLabel: s.trackingStage ? TRACKING_STAGE_LABELS[s.trackingStage] : null,
    trackingEventAt: s.trackingEventAt?.toISOString() ?? null,
    trackingSyncedAt: s.trackingSyncedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

const trackingSchema = z.object({
  orderId: ulidSchema,
  source: z.enum(["marketplace", "manual"]).describe("manual: tahap dari status pesanan, tanpa pelacakan kurir"),
  trackingNumber: z.string().nullable(),
  provider: z.string().nullable(),
  stage: z.enum(TRACKING_STAGES).nullable(),
  stageLabel: z.string().nullable(),
  /** Newest first. Descriptions come from the marketplace and may name who received the parcel. */
  events: z.array(
    z.object({
      at: iso,
      description: z.string(),
      stage: z.enum(TRACKING_STAGES).nullable(),
      stageLabel: z.string().nullable(),
      code: z.string().nullable(),
      packageId: z.string().nullable().describe("paket pesanan Shopee yang dipecah"),
      returnCode: z.string().nullable().describe("kode OTP retur SPX Instant dan Sameday untuk kurir"),
    }),
  ),
  syncedAt: iso.nullable(),
  error: z.string().nullable(),
  refreshable: z.boolean(),
});
export class TrackingDto extends createZodDto(trackingSchema) {}
export class TrackingRefreshDto extends createZodDto(
  z.object({ queued: z.boolean().describe("false: sudah dibaca dalam 10 menit terakhir") }),
) {}

export function trackingView(t: TrackingView): z.infer<typeof trackingSchema> {
  return {
    orderId: t.orderId,
    source: t.source,
    trackingNumber: t.trackingNumber,
    provider: t.provider,
    stage: t.stage,
    stageLabel: t.stage ? TRACKING_STAGE_LABELS[t.stage] : null,
    events: t.events.map((e) => ({
      at: e.at,
      description: e.description,
      stage: e.stage,
      stageLabel: e.stage ? TRACKING_STAGE_LABELS[e.stage] : null,
      code: e.code,
      packageId: e.packageId ?? null,
      returnCode: e.returnCode ?? null,
    })),
    syncedAt: t.syncedAt?.toISOString() ?? null,
    error: t.error,
    refreshable: t.refreshable,
  };
}

const labelTemplateSchema = z.object({
  showSku: z.boolean().describe("SKU tiap barang; tanpa SKU, nama produk"),
  showVariant: z.boolean(),
  showBin: z.boolean().describe("lokasi rak"),
  showBuyerNote: z.boolean(),
  showTags: z.boolean().describe("tag pesanan; juga di daftar kemas"),
});
export class LabelTemplateDto extends createZodDto(labelTemplateSchema) {}
export class UpdateLabelTemplateDto extends createZodDto(
  labelTemplateSchema.partial().refine((v) => Object.keys(v).length > 0, { message: "Tidak ada yang diubah." }),
) {}
export class LabelPreviewQueryDto extends createZodDto(z.object({ format: z.enum(FORMATS).default("thermal") })) {}
export const labelTemplateView = (t: LabelTemplateOptions): z.infer<typeof labelTemplateSchema> => ({ ...t });

export class RequestDocumentDto extends createZodDto(
  z.object({
    /**
     * labels: the orders' shipping labels in one PDF (FR-SHP-01); pick_list: what to take from the shelves
     * (FR-SHP-02); packing_list: one page per order of what goes in the parcel (FR-SHP-03).
     */
    kind: z.enum(KINDS),
    orderIds: z.array(ulidSchema).min(1).max(1000),
    /** Labels and packing lists: 100 x 150 mm thermal, or A4 with 4 per page. */
    format: z.enum(FORMATS).default("thermal"),
    /** Labels: `custom` adds the business's template under marketplace labels (FR-SHP-16). */
    template: z.enum(TEMPLATES).default("standard"),
    /** Labels: each order's packing list right after its label ("Sertakan daftar kemas"). */
    packingList: z.boolean().default(false),
  }),
) {}

const missingSchema = z.object({ orderId: ulidSchema, code: z.string(), message: z.string() });

const documentSchema = z.object({
  id: ulidSchema,
  kind: z.enum(KINDS),
  status: z.enum(DOCUMENT_JOB_STATUSES),
  format: z.enum(FORMATS).nullable(),
  template: z.enum(TEMPLATES).nullable(),
  packingList: z.boolean(),
  orderCount: z.number().int(),
  pageCount: z.number().int().nullable(),
  /** Orders in the file, labels placed, and the orders left out with the reason. */
  result: z.object({
    orders: z.number().int().optional(),
    labels: z.number().int().optional(),
    missing: z.array(missingSchema),
  }),
  error: z.string().nullable(),
  /** GET this path for the PDF once the document is ready. */
  downloadUrl: z.string().nullable(),
  createdAt: iso,
  finishedAt: iso.nullable(),
});

export class DocumentDto extends createZodDto(documentSchema) {}
export class DocumentIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
export class OrderIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export function documentView(d: DocumentRow): z.infer<typeof documentSchema> {
  return {
    id: d.id,
    kind: d.kind,
    status: d.status,
    format: d.kind === "pick_list" ? null : (d.params.format ?? "thermal"),
    template: d.kind === "labels" ? (d.params.template ?? "standard") : null,
    packingList: d.kind === "labels" ? (d.params.packingList ?? false) : false,
    orderCount: d.params.orderIds.length,
    pageCount: d.pageCount,
    result: {
      ...(d.result.orders !== undefined ? { orders: d.result.orders } : {}),
      ...(d.result.labels !== undefined ? { labels: d.result.labels } : {}),
      missing: d.result.missing ?? [],
    },
    error: d.error,
    downloadUrl: d.status === "ready" && d.fileObjectId ? `/v1/files/${d.fileObjectId}/download` : null,
    createdAt: d.createdAt.toISOString(),
    finishedAt: d.finishedAt?.toISOString() ?? null,
  };
}

export class PickListRequestDto extends createZodDto(z.object({ orderIds: z.array(ulidSchema).min(1).max(1000) })) {}

const pickListSchema = z.object({
  sections: z.array(
    z.object({
      warehouseId: ulidSchema.nullable(),
      warehouse: z.string(),
      orders: z.number().int(),
      units: z.number().int(),
      lines: z.array(
        z.object({
          variantId: ulidSchema.nullable(),
          sku: z.string(),
          name: z.string(),
          variantName: z.string().nullable(),
          bin: z.string().nullable(),
          qty: z.number().int(),
          orders: z.number().int(),
        }),
      ),
    }),
  ),
  missing: z.array(missingSchema),
});

export class PickListDto extends createZodDto(pickListSchema) {}

export function pickListView(p: { sections: PickListSection[]; missing: z.infer<typeof missingSchema>[] }) {
  return {
    sections: p.sections.map((s) => ({
      warehouseId: s.warehouseId,
      warehouse: s.warehouse,
      orders: s.orders,
      units: s.units,
      lines: s.lines.map((l) => ({
        variantId: l.variantId,
        sku: l.sku,
        name: l.name,
        variantName: l.variantName,
        bin: l.bin,
        qty: l.qty,
        orders: l.orders,
      })),
    })),
    missing: p.missing,
  };
}
