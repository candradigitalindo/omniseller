import { RETURN_KINDS, RETURN_REQUEST_STATUSES, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { pageSchema, paginationQuery } from "../../common/http/pagination";
import { channelDisplayName } from "../channel/stores.service";
import type { ReturnView } from "./returns.service";

/** Request and response DTOs of returns, refunds, and cancellation requests (FR-RET-01..07, backend doc 8.26). */

const iso = z.iso.datetime();

export class ReturnIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export class ReturnQueryDto extends createZodDto(
  paginationQuery.extend({
    group: z
      .enum(["returns", "cancellations", "rto"])
      .optional()
      .describe("tab layar Retur & Batal: retur dan refund, pembatalan, paket kembali"),
    status: z.enum(RETURN_REQUEST_STATUSES).optional(),
    awaitingDecision: z.enum(["true"]).optional().describe("hanya yang menunggu keputusan penjual"),
    toReceive: z.enum(["true"]).optional().describe("hanya barang yang akan kembali dan belum diterima"),
    storeId: ulidSchema.optional(),
    warehouseId: ulidSchema.optional(),
    orderId: ulidSchema.optional(),
  }),
) {}

export class ReturnSummaryQueryDto extends createZodDto(
  z.object({ storeId: ulidSchema.optional(), warehouseId: ulidSchema.optional() }),
) {}

const evidenceSchema = z.object({
  type: z.enum(["image", "video"]),
  url: z.string().describe("alamat foto atau video di marketplace"),
  thumbnailUrl: z.string().nullable(),
  by: z.enum(["buyer", "seller", "marketplace"]),
});

const decisionSchema = z.object({
  code: z.string().describe("dikirim kembali sebagai `decision`"),
  action: z.enum(["accept", "reject"]),
  label: z.string(),
  reasons: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      evidence: z
        .array(z.object({ module: z.number().int(), requirement: z.string(), required: z.boolean() }))
        .describe("bukti yang diminta marketplace untuk alasan ini (Shopee); kosong bila foto bebas"),
    }),
  ),
  needsEmail: z.boolean().describe("marketplace meminta email kontak penjual (sanggahan Shopee)"),
});

const itemSchema = z.object({
  id: ulidSchema,
  orderItemId: ulidSchema.nullable().describe("baris pesanan asal; null bila pesanan tidak punya listing itu"),
  sku: z.string().nullable(),
  title: z.string().nullable(),
  qty: z.number().int(),
  refundAmount: z.number().int().nullable(),
  sellableQty: z.number().int().nullable(),
  damagedQty: z.number().int().nullable(),
  missingQty: z.number().int().nullable(),
  receivedAt: iso.nullable(),
});

const returnSchema = z.object({
  id: ulidSchema,
  store: z.object({ id: ulidSchema, name: z.string(), channel: z.string(), channelName: z.string() }).nullable(),
  orderId: ulidSchema,
  externalOrderId: z.string().nullable(),
  warehouseId: ulidSchema.nullable(),
  kind: z.enum(RETURN_KINDS),
  externalReturnId: z.string().nullable(),
  status: z.enum(RETURN_REQUEST_STATUSES),
  statusChangedAt: iso,
  externalStatus: z.string().nullable(),
  initiator: z.enum(["buyer", "seller", "marketplace"]).nullable(),
  reasonCode: z.string().nullable(),
  reason: z.string().nullable(),
  evidence: z.array(evidenceSchema),
  refundAmount: z.number().int().nullable(),
  currency: z.string(),
  respondByAt: iso.nullable().describe("marketplace memutuskan sendiri setelah ini (FR-RET-07)"),
  sellerAction: z.string().nullable(),
  awaitingDecision: z.boolean().describe("menunggu keputusan penjual sekarang"),
  goodsReturn: z.boolean().describe("barang dikirim kembali ke gudang penjual"),
  returnTrackingNumber: z.string().nullable(),
  returnCarrier: z.string().nullable(),
  decisions: z
    .array(decisionSchema)
    .nullable()
    .describe("keputusan yang bisa diambil sekarang; null selagi dibaca ulang dari marketplace"),
  decisionsReadAt: iso.nullable(),
  sellerEvidence: z.array(
    z.object({ fileId: ulidSchema, contentType: z.string(), size: z.number().int(), uploadedAt: iso }),
  ),
  response: z
    .object({
      decision: z.string(),
      action: z.enum(["accept", "reject"]),
      label: z.string(),
      reason: z.string().nullable(),
      reasonLabel: z.string().nullable(),
      comment: z.string().nullable(),
      evidence: z.array(z.object({ fileId: ulidSchema, module: z.number().int().nullable() })),
      status: z.enum(["pending", "sent", "failed"]),
      error: z.string().nullable(),
      decidedAt: iso.nullable(),
      decidedBy: ulidSchema.nullable(),
    })
    .nullable()
    .describe("keputusan penjual terakhir dan status pengirimannya ke marketplace"),
  receivedAt: iso.nullable(),
  receivedBy: ulidSchema.nullable(),
  receivedWarehouseId: ulidSchema.nullable(),
  receiptNote: z.string().nullable(),
  items: z.array(itemSchema),
  createdAt: iso,
  updatedAt: iso,
});

const at = (d: Date | null) => (d ? d.toISOString() : null);

export const returnView = (v: ReturnView): z.infer<typeof returnSchema> => {
  const r = v.request;
  return {
    id: r.id,
    store: v.store ? { ...v.store, channelName: channelDisplayName(v.store.channel) } : null,
    orderId: r.orderId,
    externalOrderId: v.externalOrderId,
    warehouseId: r.warehouseId,
    kind: r.kind,
    externalReturnId: r.externalReturnId,
    status: r.status,
    statusChangedAt: r.statusChangedAt.toISOString(),
    externalStatus: r.externalStatus,
    initiator: r.initiator,
    reasonCode: r.reasonCode,
    reason: r.reason,
    evidence: r.evidence,
    refundAmount: r.refundAmount,
    currency: r.currency,
    respondByAt: at(r.respondByAt),
    sellerAction: r.sellerAction,
    awaitingDecision: v.awaitingDecision,
    goodsReturn: r.goodsReturn,
    returnTrackingNumber: r.returnTrackingNumber,
    returnCarrier: r.returnCarrier,
    decisions: v.decisions,
    decisionsReadAt: at(r.decisionsReadAt),
    sellerEvidence: r.sellerEvidence.map((e) => ({
      fileId: e.fileId,
      contentType: e.contentType,
      size: e.size,
      uploadedAt: e.uploadedAt,
    })),
    response:
      r.response && r.decision && r.decisionAction && r.responseStatus
        ? {
            decision: r.decision,
            action: r.decisionAction,
            label: r.response.label,
            reason: r.response.reason,
            reasonLabel: r.response.reasonLabel,
            comment: r.response.comment,
            evidence: r.response.evidence,
            status: r.responseStatus,
            error: r.responseError,
            decidedAt: at(r.decidedAt),
            decidedBy: r.decidedBy,
          }
        : null,
    receivedAt: at(r.receivedAt),
    receivedBy: r.receivedBy,
    receivedWarehouseId: r.receivedWarehouseId,
    receiptNote: r.receiptNote,
    items: v.items.map((i) => ({
      id: i.id,
      orderItemId: i.orderItemId,
      sku: i.sku,
      title: i.title,
      qty: i.qty,
      refundAmount: i.refundAmount,
      sellableQty: i.sellableQty,
      damagedQty: i.damagedQty,
      missingQty: i.missingQty,
      receivedAt: at(i.receivedAt),
    })),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
};

export class ReturnDto extends createZodDto(returnSchema) {}
export class ReturnPageDto extends createZodDto(pageSchema(returnSchema)) {}

export class ReturnSummaryDto extends createZodDto(
  z.object({
    awaitingDecision: z.number().int().describe("menunggu keputusan penjual"),
    dueSoon: z.number().int().describe("menunggu keputusan dengan tenggat dalam 12 jam"),
    toReceive: z.number().int().describe("barang akan kembali dan belum diterima gudang"),
    cancellations: z.number().int().describe("permintaan pembatalan pembeli yang terbuka"),
    rto: z.number().int().describe("paket kembali (RTO) yang belum diterima"),
    failedResponses: z.number().int().describe("keputusan yang gagal dikirim ke marketplace"),
  }),
) {}

export class AcceptReturnDto extends createZodDto(
  z.object({
    decision: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .optional()
      .describe("kode keputusan dari `decisions`; boleh kosong bila hanya ada satu"),
  }),
) {}

export class RejectReturnDto extends createZodDto(
  z.object({
    decision: z.string().trim().min(1).max(64).optional(),
    reason: z.string().trim().min(1).max(128).optional().describe("kode alasan dari `decisions[].reasons`"),
    comment: z.string().trim().max(1000).optional(),
    evidence: z
      .array(
        z.object({
          fileId: ulidSchema,
          module: z.number().int().min(0).max(100).optional().describe("bukti mana yang dijawab foto ini (Shopee)"),
        }),
      )
      .max(9)
      .optional(),
    email: z.email().max(254).optional().describe("email kontak penjual; wajib untuk sanggahan Shopee"),
  }),
) {}

export class AddEvidenceDto extends createZodDto(
  z.object({
    /** The photo, base64 encoded: JPEG or PNG, at most 5 MB. */
    content: z
      .string()
      .min(1)
      .max(7_000_000)
      .regex(/^[A-Za-z0-9+/=\r\n]+$/, "Isi berkas harus base64."),
  }),
) {}

export class EvidenceDto extends createZodDto(
  z.object({ fileId: ulidSchema, contentType: z.string(), size: z.number().int(), uploadedAt: iso }),
) {}

export class ReceiveReturnDto extends createZodDto(
  z.object({
    warehouseId: ulidSchema.optional().describe("gudang yang menerima; bawaan gudang pesanannya"),
    note: z.string().trim().max(500).optional(),
    items: z
      .array(
        z.object({
          returnItemId: ulidSchema,
          sellable: z.number().int().min(0).max(100_000).describe("layak jual, kembali ke stok"),
          damaged: z.number().int().min(0).max(100_000).describe("rusak, masuk stok karantina"),
          missing: z.number().int().min(0).max(100_000).describe("tidak diterima"),
        }),
      )
      .min(1)
      .max(500),
  }),
) {}

export class RefreshReturnDto extends createZodDto(z.object({ requested: z.literal(true) })) {}
