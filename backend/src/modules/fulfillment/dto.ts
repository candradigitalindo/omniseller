import { DOCUMENT_JOB_STATUSES, SHIPMENT_STATUSES, type ShipmentStatus, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { DocumentRow } from "./fulfillment.repository";
import type { ShipmentView } from "./fulfillment.service";
import type { PickListSection } from "./pick-list.builder";

/** Request and response DTOs of the fulfillment endpoints (backend doc 10.6). */

const iso = z.iso.datetime();
const METHODS = ["pickup", "dropoff"] as const;
const FORMATS = ["thermal", "a4"] as const;

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
    createdAt: s.createdAt.toISOString(),
  };
}

export class RequestDocumentDto extends createZodDto(
  z.object({
    /** labels: the orders' shipping labels in one PDF (FR-SHP-01); pick_list: what to take from the shelves (FR-SHP-02). */
    kind: z.enum(["labels", "pick_list"]),
    orderIds: z.array(ulidSchema).min(1).max(1000),
    /** Labels only: 100 x 150 mm thermal, or A4 with 4 labels per page. */
    format: z.enum(FORMATS).default("thermal"),
  }),
) {}

const missingSchema = z.object({ orderId: ulidSchema, code: z.string(), message: z.string() });

const documentSchema = z.object({
  id: ulidSchema,
  kind: z.enum(["labels", "pick_list"]),
  status: z.enum(DOCUMENT_JOB_STATUSES),
  format: z.enum(FORMATS).nullable(),
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
    format: d.kind === "labels" ? (d.params.format ?? "thermal") : null,
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
