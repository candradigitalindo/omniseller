import { CHANNELS, ORDER_STATUSES, type OrderStatus, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import type { RequestContext } from "../../common/context/request-context";
import { MAX_LIMIT, pageSchema } from "../../common/http/pagination";
import { type OrderProblemCode, PAYMENT_METHODS } from "../../db/schema";
import { internalSlaOf } from "../campaign/cutoff-plan";
import { channelDisplayName } from "../channel/stores.service";
import { slaOf, TO_SHIP_STATUSES } from "./order-plan";
import type { OrderEventRow, OrderItemRow, OrderProblemRow } from "./orders.repository";
import { type ActionResult, type OrderView, orderStatusLabel } from "./orders.service";
import type { OrderTagRef, TagRow } from "./tags.repository";

/** Request and response DTOs of the order endpoints (backend doc 10.6). */

const iso = z.iso.datetime();
const PROBLEM_CODES = [
  "unmapped_sku",
  "insufficient_stock",
  "unmapped_warehouse",
  "address_incomplete",
  "duplicate",
  "watchlist",
  "high_value",
  "fulfillment_conflict",
] as const satisfies readonly OrderProblemCode[];

export class OrderQueryDto extends createZodDto(
  z.object({
    cursor: z.string().max(300).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
    storeId: ulidSchema.optional(),
    channel: z.enum(CHANNELS).optional(),
    status: z
      .string()
      .max(300)
      .optional()
      .describe("satu atau beberapa status dipisah koma")
      .refine((v) => !v || v.split(",").every((s) => (ORDER_STATUSES as readonly string[]).includes(s.trim())), {
        message: "Status tidak dikenal.",
      }),
    from: iso.optional().describe("waktu pesanan dibuat, sejak"),
    to: iso.optional(),
    q: z.string().trim().max(100).optional().describe("nomor pesanan, resi, nama pembeli, SKU, atau nama produk"),
    warehouseId: ulidSchema.optional(),
    problem: z.enum(PROBLEM_CODES).optional(),
    cod: z.enum(["true", "false"]).optional(),
    due: z
      .enum(["overdue", "soon", "cutoff"])
      .optional()
      .describe(
        "overdue: lewat batas kirim; soon: batas kirim dalam 6 jam; cutoff: harus dikirim sebelum cut-off kurir hari ini (termasuk yang sudah lewat)",
      ),
    tagId: ulidSchema.optional().describe("pesanan yang memakai tag ini (FR-ORD-04)"),
    sort: z.enum(["newest", "ship_by"]).default("newest"),
  }),
) {}

export class CourierQueryDto extends createZodDto(z.object({ warehouseId: ulidSchema.optional() })) {}

export class CourierListDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({
        courier: z.string().describe("nama kurir seperti dikirim marketplace"),
        orders: z.number().int().describe("pesanan 90 hari terakhir"),
      }),
    ),
    next_cursor: z.null(),
  }),
) {}

export class OrderSummaryQueryDto extends createZodDto(
  z.object({ storeId: ulidSchema.optional(), warehouseId: ulidSchema.optional() }),
) {}

export class OrderIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
export class OrderProblemParamDto extends createZodDto(z.object({ id: ulidSchema, problemId: ulidSchema })) {}

export class OrderIdsDto extends createZodDto(z.object({ orderIds: z.array(ulidSchema).min(1).max(500) })) {}
export class CancelOrderDto extends createZodDto(
  z.object({ reason: z.string().min(1).max(200).describe("kode alasan dari GET /v1/orders/{id}/cancel-reasons") }),
) {}
export class OrderNoteDto extends createZodDto(z.object({ note: z.string().max(2000).nullable() })) {}
export class ResolveProblemDto extends createZodDto(z.object({ resolution: z.string().trim().max(500).optional() })) {}
export class OrderSyncDto extends createZodDto(z.object({ storeId: ulidSchema })) {}

// ---- manual orders (FR-ORD-09, 12) and tags (FR-ORD-04), backend doc 8.21 ----

const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{5,19}$/, "Nomor telepon tidak valid.");
const manualAddress = z.object({
  name: z.string().trim().min(1).max(100).optional().describe("penerima; bawaan nama pembeli"),
  phone: phone.optional().describe("telepon penerima; bawaan telepon pembeli"),
  line1: z.string().trim().min(5).max(300),
  district: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
  province: z.string().trim().max(100).optional().describe("dipakai untuk mencari gudang terdekat"),
  postalCode: z
    .string()
    .trim()
    .regex(/^[0-9]{5}$/, "Kode pos 5 angka.")
    .optional(),
});
const money = (max: number) => z.number().int().min(0).max(max);
const DAY_MS = 86_400_000;
const notFuture = (v: string | undefined) => !v || Date.parse(v) <= Date.now() + 60_000;

export class CreateManualOrderDto extends createZodDto(
  z
    .object({
      storeId: ulidSchema
        .optional()
        .describe("saluran pesanan manual; kosong: saluran pertama, dibuat otomatis bila belum ada"),
      warehouseId: ulidSchema.optional().describe("kosong: gudang terdekat dengan pembeli yang stoknya cukup"),
      buyer: z.object({ name: z.string().trim().min(1).max(100), phone: phone.optional() }),
      shippingAddress: manualAddress.nullable().optional().describe("kosong: diambil pembeli atau dijual di tempat"),
      items: z
        .array(
          z.object({
            variantId: ulidSchema,
            qty: z.number().int().min(1).max(9999),
            unitPrice: money(1_000_000_000).optional().describe("harga per unit; kosong: harga dasar varian"),
          }),
        )
        .min(1)
        .max(100)
        .refine((items) => new Set(items.map((i) => i.variantId)).size === items.length, {
          message: "Satu varian cukup satu baris; ubah jumlahnya.",
        }),
      shippingFee: money(100_000_000).default(0).describe("ongkir yang dibayar pembeli"),
      discount: money(10_000_000_000).default(0).describe("potongan untuk seluruh pesanan"),
      paymentMethod: z.enum(PAYMENT_METHODS),
      paid: z
        .boolean()
        .optional()
        .describe("sudah dibayar; bawaan: tunai sudah, lainnya belum. COD dibayar saat barang diterima"),
      shippingProvider: z.string().trim().min(1).max(60).optional(),
      shippingService: z.string().trim().min(1).max(60).optional(),
      buyerNote: z.string().trim().max(1000).optional(),
      internalNote: z.string().trim().max(2000).optional(),
      orderedAt: iso.optional().describe("waktu pesanan; bawaan sekarang, paling lama 90 hari ke belakang"),
    })
    .refine((v) => notFuture(v.orderedAt) && (!v.orderedAt || Date.parse(v.orderedAt) >= Date.now() - 90 * DAY_MS), {
      path: ["orderedAt"],
      message: "Waktu pesanan tidak boleh di masa depan atau lebih dari 90 hari lalu.",
    }),
) {}

export class UpdateManualOrderDto extends createZodDto(
  z
    .object({
      buyer: z
        .object({ name: z.string().trim().min(1).max(100).optional(), phone: phone.nullable().optional() })
        .optional(),
      shippingAddress: manualAddress.nullable().optional().describe("menggantikan seluruh alamat; null: tanpa kirim"),
      shippingProvider: z.string().trim().min(1).max(60).nullable().optional(),
      shippingService: z.string().trim().min(1).max(60).nullable().optional(),
      trackingNumber: z.string().trim().min(3).max(60).nullable().optional(),
      buyerNote: z.string().trim().max(1000).nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: "Tidak ada yang diubah." }),
) {}

export class PayOrderDto extends createZodDto(
  z
    .object({ paidAt: iso.optional().describe("bawaan sekarang") })
    .refine((v) => notFuture(v.paidAt), { path: ["paidAt"], message: "Waktu bayar tidak boleh di masa depan." }),
) {}

export class ShipOrderDto extends createZodDto(
  z.object({
    shippingProvider: z.string().trim().min(1).max(60).optional().describe("kurir, misalnya JNE atau J&T Express"),
    trackingNumber: z.string().trim().min(3).max(60).optional().describe("nomor resi"),
  }),
) {}

export class ChangeWarehouseDto extends createZodDto(z.object({ warehouseId: ulidSchema })) {}

const tagRefSchema = z.object({ id: ulidSchema, name: z.string(), color: z.string().nullable() });
const color = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Warna heksadesimal, contoh #1E6B8C.")
  .transform((c) => c.toUpperCase());
export class CreateTagDto extends createZodDto(
  z.object({ name: z.string().trim().min(1).max(30), color: color.nullable().optional() }),
) {}
export class UpdateTagDto extends createZodDto(
  z
    .object({ name: z.string().trim().min(1).max(30).optional(), color: color.nullable().optional() })
    .refine((v) => Object.keys(v).length > 0, { message: "Tidak ada yang diubah." }),
) {}
export class TagIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
const tagSchema = tagRefSchema.extend({ orders: z.number().int().describe("pesanan yang memakai tag ini") });
export class TagDto extends createZodDto(tagSchema) {}
export class TagListDto extends createZodDto(z.object({ items: z.array(tagSchema) })) {}
export const tagView = (t: TagRow & { orders?: number }): z.infer<typeof tagSchema> => ({
  id: t.id,
  name: t.name,
  color: t.color,
  orders: t.orders ?? 0,
});
const tagRefView = (t: OrderTagRef): z.infer<typeof tagRefSchema> => ({ id: t.id, name: t.name, color: t.color });

export class OrderTagsDto extends createZodDto(
  z
    .object({
      orderIds: z.array(ulidSchema).min(1).max(500),
      add: z.array(ulidSchema).max(20).default([]),
      remove: z.array(ulidSchema).max(20).default([]),
    })
    .refine((v) => v.add.length + v.remove.length > 0, {
      path: ["add"],
      message: "Pilih tag yang dipasang atau dilepas.",
    }),
) {}
export class OrderTagsResultDto extends createZodDto(
  z.object({ items: z.array(z.object({ orderId: ulidSchema, tags: z.array(tagRefSchema) })) }),
) {}
export const orderTagsView = (r: { orderId: string; tags: OrderTagRef[] }) => ({
  orderId: r.orderId,
  tags: r.tags.map(tagRefView),
});

const problemSchema = z.object({
  id: ulidSchema,
  code: z.enum(PROBLEM_CODES),
  detail: z.record(z.string(), z.unknown()).nullable(),
  resolvedAt: iso.nullable(),
  resolution: z.string().nullable(),
});

const firstItemSchema = z.object({
  title: z.string(),
  sku: z.string(),
  variantName: z.string().nullable(),
  imageUrl: z.string().nullable(),
  qty: z.number().int(),
});

const listItemSchema = z.object({
  id: ulidSchema,
  externalOrderId: z.string(),
  store: z.object({ id: ulidSchema, name: z.string(), channel: z.string(), channelName: z.string() }).nullable(),
  platform: z.string().nullable().describe("asal pesanan pada toko multi-platform: TIKTOK_SHOP atau TOKOPEDIA"),
  status: z.enum(ORDER_STATUSES),
  statusLabel: z.string(),
  externalStatus: z.string().nullable(),
  fulfillmentMode: z.enum(["seller", "marketplace"]),
  buyerName: z.string().nullable(),
  itemCount: z.number().int(),
  firstItem: firstItemSchema.nullable(),
  total: z.number().int(),
  currency: z.string(),
  isCod: z.boolean(),
  shippingProvider: z.string().nullable(),
  shippingService: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  shipByAt: iso.nullable(),
  sla: z
    .object({ state: z.enum(["ok", "warning", "overdue"]), remainingMs: z.number().int() })
    .nullable()
    .describe("ok: hijau; warning: kuning (6 jam atau kurang); overdue: merah"),
  internalShipByAt: iso
    .nullable()
    .describe("batas internal: cut-off kurir pertama yang masih terkejar saat pesanan masuk (backend doc 8.31)"),
  internalSla: z
    .object({ state: z.enum(["ok", "warning", "missed"]), remainingMs: z.number().int() })
    .nullable()
    .describe("ok: hijau; warning: kuning (2 jam atau kurang ke cut-off); missed: cut-off sudah lewat"),
  warehouseId: ulidSchema.nullable(),
  problems: z.array(problemSchema),
  cancelRequested: z.boolean(),
  tags: z.array(tagRefSchema),
  orderedAt: iso,
});
export class OrderPageDto extends createZodDto(pageSchema(listItemSchema)) {}

const itemSchema = z.object({
  id: ulidSchema,
  sku: z.string(),
  title: z.string(),
  variantName: z.string().nullable(),
  imageUrl: z.string().nullable(),
  qty: z.number().int(),
  cancelledQty: z.number().int(),
  unitPrice: z.number().int(),
  discount: z.number().int(),
  lineTotal: z.number().int(),
  variantId: ulidSchema.nullable(),
  listingId: ulidSchema.nullable(),
  warehouseId: ulidSchema.nullable(),
  reservedQty: z.number().int(),
  shippedQty: z.number().int(),
  returnedQty: z.number().int().describe("unit yang sudah diterima kembali (retur, paket kembali)"),
});

const eventSchema = z.object({
  id: ulidSchema,
  type: z.string(),
  fromStatus: z.enum(ORDER_STATUSES).nullable(),
  toStatus: z.enum(ORDER_STATUSES).nullable(),
  actorType: z.string(),
  actorId: ulidSchema.nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: iso,
});

const detailSchema = listItemSchema.extend({
  items: z.array(itemSchema),
  buyerUsername: z.string().nullable(),
  buyerPhone: z.string().nullable(),
  shippingAddress: z.record(z.string(), z.unknown()).nullable(),
  addressHidden: z.boolean().describe("alamat dan telepon pembeli disembunyikan untuk peran ini"),
  buyerNote: z.string().nullable(),
  internalNote: z.string().nullable(),
  subtotal: z.number().int(),
  discountTotal: z.number().int(),
  shippingFeeBuyer: z.number().int(),
  voucherSeller: z.number().int(),
  paidAt: iso.nullable(),
  shippedAt: iso.nullable(),
  deliveredAt: iso.nullable(),
  completedAt: iso.nullable(),
  cancelledAt: iso.nullable(),
  cancelReason: z.string().nullable(),
  cancelledBy: z.string().nullable(),
  paymentMethod: z.enum(PAYMENT_METHODS).nullable().describe("pesanan manual: cara bayar"),
  warehouseFixed: z
    .boolean()
    .describe("gudang ditetapkan marketplace (toko multi-gudang); pesanan lain bisa pindah gudang sebelum dikemas"),
  events: z.array(eventSchema),
});
export class OrderDto extends createZodDto(detailSchema) {}

export class OrderSummaryDto extends createZodDto(
  z.object({
    statuses: z.record(z.string(), z.number().int()).describe("jumlah pesanan per status"),
    overdue: z.number().int().describe("belum dikirim dan sudah lewat batas kirim"),
    dueSoon: z.number().int().describe("belum dikirim dengan batas kirim dalam 6 jam (termasuk yang lewat)"),
    codOutstanding: z
      .object({ orders: z.number().int(), total: z.number().int() })
      .describe("COD yang dananya belum diterima"),
  }),
) {}

export class ActionResultsDto extends createZodDto(
  z.object({
    items: z.array(
      z.object({ id: ulidSchema, ok: z.boolean(), code: z.string().optional(), message: z.string().optional() }),
    ),
  }),
) {}
export const actionView = (r: ActionResult) => r;

export class CancelReasonsDto extends createZodDto(
  z.object({ items: z.array(z.object({ code: z.string(), label: z.string(), needsItems: z.boolean() })) }),
) {}

/** Roles that process orders see where they go; others see the order without the buyer's contact. */
export function canSeeAddress(ctx: RequestContext): boolean {
  return ["order:accept", "shipment:print", "order:write"].some((p) => ctx.permissions.has(p));
}

function problemView(p: OrderProblemRow): z.infer<typeof problemSchema> {
  return {
    id: p.id,
    code: p.code,
    detail: p.detail ?? null,
    resolvedAt: p.resolvedAt?.toISOString() ?? null,
    resolution: p.resolution,
  };
}

function firstItem(items: OrderItemRow[]): z.infer<typeof firstItemSchema> | null {
  const i = items[0];
  if (!i) return null;
  const snap = i.variantSnapshot as { name?: string; imageUrl?: string };
  return {
    title: i.titleSnapshot,
    sku: i.skuSnapshot,
    variantName: snap.name ?? null,
    imageUrl: snap.imageUrl ?? null,
    qty: i.qty - i.cancelledQty,
  };
}

export function orderListView(v: OrderView, now = new Date()): z.infer<typeof listItemSchema> {
  const o = v.order;
  const sla = slaOf(o.shipByAt, o.status, now);
  const internal = internalSlaOf(o.internalShipByAt, TO_SHIP_STATUSES.has(o.status), now);
  return {
    id: o.id,
    externalOrderId: o.externalOrderId,
    store: v.store ? { ...v.store, channelName: channelDisplayName(v.store.channel) } : null,
    platform: o.platform,
    status: o.status,
    statusLabel: orderStatusLabel(o.status as OrderStatus),
    externalStatus: o.externalStatus,
    fulfillmentMode: o.fulfillmentMode,
    buyerName: o.buyerName,
    itemCount: v.items.reduce((n, i) => n + i.qty - i.cancelledQty, 0),
    firstItem: firstItem(v.items),
    total: o.total,
    currency: o.currency,
    isCod: o.isCod,
    shippingProvider: o.shippingProvider,
    shippingService: o.shippingService,
    trackingNumber: o.trackingNumber,
    shipByAt: o.shipByAt?.toISOString() ?? null,
    sla: sla ? { state: sla.state, remainingMs: Math.round(sla.remainingMs) } : null,
    internalShipByAt: o.internalShipByAt?.toISOString() ?? null,
    internalSla: internal ? { state: internal.state, remainingMs: Math.round(internal.remainingMs) } : null,
    warehouseId: o.warehouseId,
    problems: v.problems.filter((p) => !p.resolvedAt).map(problemView),
    cancelRequested: o.cancelRequested,
    tags: v.tags.map(tagRefView),
    orderedAt: o.orderedAt.toISOString(),
  };
}

export function orderDetailView(
  ctx: RequestContext,
  v: OrderView & { events: OrderEventRow[]; warehouseFixed: boolean },
): z.infer<typeof detailSchema> {
  const o = v.order;
  const show = canSeeAddress(ctx);
  return {
    ...orderListView(v),
    problems: v.problems.map(problemView),
    items: v.items.map((i) => {
      const snap = i.variantSnapshot as { name?: string; imageUrl?: string };
      return {
        id: i.id,
        sku: i.skuSnapshot,
        title: i.titleSnapshot,
        variantName: snap.name ?? null,
        imageUrl: snap.imageUrl ?? null,
        qty: i.qty,
        cancelledQty: i.cancelledQty,
        unitPrice: i.unitPrice,
        discount: i.discount,
        lineTotal: i.lineTotal,
        variantId: i.variantId,
        listingId: i.listingId,
        warehouseId: i.warehouseId,
        reservedQty: i.reservedQty,
        shippedQty: i.shippedQty,
        returnedQty: i.returnedQty,
      };
    }),
    buyerUsername: o.buyerUsername,
    buyerPhone: show ? o.buyerPhone : null,
    shippingAddress: show ? ((o.shippingAddress as Record<string, unknown> | null) ?? null) : null,
    addressHidden: !show,
    buyerNote: o.buyerNote,
    internalNote: o.internalNote,
    subtotal: o.subtotal,
    discountTotal: o.discountTotal,
    shippingFeeBuyer: o.shippingFeeBuyer,
    voucherSeller: o.voucherSeller,
    paidAt: o.paidAt?.toISOString() ?? null,
    shippedAt: o.shippedAt?.toISOString() ?? null,
    deliveredAt: o.deliveredAt?.toISOString() ?? null,
    completedAt: o.completedAt?.toISOString() ?? null,
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    cancelReason: o.cancelReason,
    cancelledBy: o.cancelledBy,
    paymentMethod: o.paymentMethod,
    warehouseFixed: v.warehouseFixed,
    events: v.events.map((e) => ({
      id: e.id,
      type: e.type,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      actorType: e.actorType,
      actorId: e.actorId,
      payload: e.payload,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}
