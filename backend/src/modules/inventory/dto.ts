import {
  STOCK_ADJUSTMENT_REASONS,
  STOCK_MOVEMENT_TYPES,
  type StockAdjustmentReason,
  ulidSchema,
} from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { pageSchema, paginationQuery } from "../../common/http/pagination";
import type { InitialStockLine } from "./initial-stock.service";
import type { InventoryRow, MovementRow, RuleRow, StockSummary } from "./inventory.repository";
import type { AdjustmentResult } from "./inventory.service";
import type { RestockItem } from "./restock.service";
import type { StockItem } from "./stock-overview.service";

/** Request and response DTOs of the inventory endpoints (backend doc 10.6). */

const iso = z.iso.datetime();
const count = z.number().int();
const quantity = z.number().int().min(0).max(10_000_000);
const reasons = Object.keys(STOCK_ADJUSTMENT_REASONS) as [StockAdjustmentReason, ...StockAdjustmentReason[]];

// ---- stock list ----

export class StockQueryDto extends createZodDto(
  paginationQuery.extend({
    q: z.string().trim().max(100).optional().describe("SKU, nama produk, nama varian, atau barcode"),
    warehouseId: ulidSchema.optional(),
    stock: z
      .enum(["low", "out", "negative", "unset"])
      .optional()
      .describe("low: menipis; out: habis; negative: kelebihan jual; unset: stok belum pernah ditetapkan"),
    includeArchived: z.enum(["true", "false"]).optional(),
  }),
) {}

const stockRowSchema = z.object({
  warehouseId: ulidSchema,
  onHand: count.describe("stok fisik"),
  reserved: count.describe("dipesan, belum dikirim"),
  buffer: count.describe("cadangan"),
  damaged: count.describe("rusak, tidak dijual"),
  available: count.describe("siap jual = fisik - dipesan - cadangan; negatif berarti kelebihan jual"),
  minStock: count.nullable(),
  binLocation: z.string().nullable(),
  stockSetAt: iso.nullable().describe("terakhir ditetapkan orang; stok yang belum pernah ditetapkan tidak didorong"),
});

const pushSchema = z.object({
  storeId: ulidSchema,
  storeName: z.string(),
  channel: z.string(),
  channelName: z.string(),
  state: z
    .enum(["synced", "pending", "failed", "paused"])
    .describe(
      "synced: marketplace punya nilai terbaru; failed: ada push gagal; paused: mode baca saja atau gudang belum dipetakan",
    ),
  listings: count,
  lastPushedAt: iso.nullable(),
  lastAttemptAt: iso.nullable(),
  failCount: count,
  lastError: z.string().nullable(),
});

const stockItemSchema = z.object({
  id: ulidSchema.describe("id varian"),
  productId: ulidSchema,
  sku: z.string(),
  name: z.string(),
  productName: z.string(),
  imageUrl: z.string().nullable(),
  status: z.enum(["active", "archived"]),
  available: count.describe("siap jual di gudang yang terlihat"),
  established: z.boolean(),
  warehouses: z.array(stockRowSchema),
  push: z.array(pushSchema),
});
export class StockPageDto extends createZodDto(pageSchema(stockItemSchema)) {}

function stockRowView(r: InventoryRow): z.infer<typeof stockRowSchema> {
  return {
    warehouseId: r.warehouseId,
    onHand: r.onHand,
    reserved: r.reserved,
    buffer: r.buffer,
    damaged: r.damaged,
    available: r.available ?? r.onHand - r.reserved - r.buffer,
    minStock: r.minStock,
    binLocation: r.binLocation,
    stockSetAt: r.stockSetAt?.toISOString() ?? null,
  };
}

export function stockItemView(i: StockItem): z.infer<typeof stockItemSchema> {
  const rows = i.rows.map(stockRowView);
  return {
    id: i.variant.variantId,
    productId: i.variant.productId,
    sku: i.variant.sku,
    name: i.variant.variantName,
    productName: i.variant.productName,
    imageUrl: i.variant.imageUrl,
    status: i.variant.productStatus === "archived" ? "archived" : i.variant.variantStatus,
    available: rows.reduce((n, r) => n + r.available, 0),
    established: rows.some((r) => r.stockSetAt !== null),
    warehouses: rows,
    push: i.push.map((p) => ({
      ...p,
      lastPushedAt: p.lastPushedAt?.toISOString() ?? null,
      lastAttemptAt: p.lastAttemptAt?.toISOString() ?? null,
    })),
  };
}

export class StockSummaryQueryDto extends createZodDto(z.object({ warehouseId: ulidSchema.optional() })) {}
export class StockSummaryDto extends createZodDto(
  z.object({
    skus: count.describe("varian aktif"),
    low: count.describe("menipis: di bawah stok minimum, belum habis"),
    out: count.describe("habis: siap jual 0 atau kurang"),
    negative: count.describe("kelebihan jual"),
    unset: count.describe("stok belum pernah ditetapkan"),
    value: count.describe("nilai persediaan (stok fisik x HPP), rupiah"),
  }),
) {}
export const summaryView = (s: StockSummary) => s;

// ---- adjustments (FR-STK-05) ----

export class AdjustStockDto extends createZodDto(
  z
    .object({
      lines: z
        .array(
          z
            .object({
              variantId: ulidSchema,
              warehouseId: ulidSchema,
              mode: z.enum(["set", "delta"]).describe("set: jumlah hasil hitung; delta: tambah atau kurangi"),
              quantity: z.number().int().min(-10_000_000).max(10_000_000),
            })
            .superRefine((l, c) => {
              if (l.mode === "set" && l.quantity < 0) {
                c.addIssue({ code: "custom", path: ["quantity"], message: "Jumlah tidak boleh negatif." });
              }
              if (l.mode === "delta" && l.quantity === 0) {
                c.addIssue({ code: "custom", path: ["quantity"], message: "Selisih tidak boleh 0." });
              }
            }),
        )
        .min(1)
        .max(500),
      reason: z.enum(reasons).describe(
        Object.entries(STOCK_ADJUSTMENT_REASONS)
          .map(([k, v]) => `${k}: ${v}`)
          .join("; "),
      ),
      note: z.string().trim().max(500).nullable().optional(),
    })
    .superRefine((v, c) => {
      if (v.reason === "other" && !v.note) {
        c.addIssue({ code: "custom", path: ["note"], message: "Tulis catatan untuk alasan Lainnya." });
      }
    }),
) {}

const adjustmentSchema = z.object({
  variantId: ulidSchema,
  warehouseId: ulidSchema,
  onHandBefore: count,
  onHandAfter: count,
  available: count,
  changed: z.boolean().describe("false: jumlah sama, hanya dikonfirmasi"),
  movementId: ulidSchema.nullable(),
});
export class AdjustmentResultDto extends createZodDto(z.object({ items: z.array(adjustmentSchema) })) {}
export const adjustmentView = (r: AdjustmentResult): z.infer<typeof adjustmentSchema> => r;

// ---- bin location and minimum (FR-STK-07, 12) ----

export class InventoryLocationParamDto extends createZodDto(
  z.object({ variantId: ulidSchema, warehouseId: ulidSchema }),
) {}
export class InventoryLocationDto extends createZodDto(
  z
    .object({
      minStock: quantity.nullable().optional(),
      binLocation: z.string().trim().max(50).nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: "Tidak ada yang diubah." }),
) {}
const inventoryRowSchema = stockRowSchema.extend({ variantId: ulidSchema });
export class InventoryRowDto extends createZodDto(inventoryRowSchema) {}
export const inventoryRowView = (r: InventoryRow): z.infer<typeof inventoryRowSchema> => ({
  variantId: r.variantId,
  ...stockRowView(r),
});

// ---- stock card (FR-STK-06) ----

export class MovementQueryDto extends createZodDto(
  paginationQuery.extend({
    variantId: ulidSchema.optional(),
    warehouseId: ulidSchema.optional(),
    type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
  }),
) {}

const movementSchema = z.object({
  id: ulidSchema,
  variantId: ulidSchema,
  warehouseId: ulidSchema,
  type: z.enum(STOCK_MOVEMENT_TYPES),
  onHandDelta: count,
  reservedDelta: count,
  damagedDelta: count,
  bufferDelta: count,
  onHandAfter: count,
  reservedAfter: count,
  damagedAfter: count,
  bufferAfter: count,
  availableAfter: count,
  referenceType: z.string().nullable(),
  referenceId: ulidSchema.nullable(),
  reason: z.string().nullable(),
  reasonLabel: z.string().nullable(),
  note: z.string().nullable(),
  actorUserId: ulidSchema.nullable(),
  createdAt: iso,
});
export class MovementPageDto extends createZodDto(pageSchema(movementSchema)) {}
export function movementView(m: MovementRow): z.infer<typeof movementSchema> {
  return {
    id: m.id,
    variantId: m.variantId,
    warehouseId: m.warehouseId,
    type: m.type,
    onHandDelta: m.onHandDelta,
    reservedDelta: m.reservedDelta,
    damagedDelta: m.damagedDelta,
    bufferDelta: m.bufferDelta,
    onHandAfter: m.onHandAfter,
    reservedAfter: m.reservedAfter,
    damagedAfter: m.damagedAfter,
    bufferAfter: m.bufferAfter,
    availableAfter: m.onHandAfter - m.reservedAfter - m.bufferAfter,
    referenceType: m.referenceType,
    referenceId: m.referenceId,
    reason: m.reason,
    reasonLabel:
      m.reason && m.reason in STOCK_ADJUSTMENT_REASONS
        ? STOCK_ADJUSTMENT_REASONS[m.reason as StockAdjustmentReason]
        : null,
    note: m.note,
    actorUserId: m.actorUserId,
    createdAt: m.createdAt.toISOString(),
  };
}

// ---- initial stock ----

export class InitialStockDto extends createZodDto(
  z.object({
    storeId: ulidSchema,
    dryRun: z.boolean().default(false).describe("hitung tanpa menyimpan"),
  }),
) {}

const initialLineSchema = z.object({
  variantId: ulidSchema,
  sku: z.string(),
  variantName: z.string(),
  productName: z.string(),
  warehouseId: ulidSchema,
  marketplaceQty: count,
  onHandBefore: count,
  onHandAfter: count,
  status: z
    .enum(["set", "confirmed", "already_set", "out_of_scope"])
    .describe("set: diisi dari marketplace; confirmed: sudah sama; already_set: sudah pernah ditetapkan, tidak diubah"),
});
export class InitialStockResultDto extends createZodDto(
  z.object({ storeId: ulidSchema, dryRun: z.boolean(), lines: z.array(initialLineSchema) }),
) {}
export const initialLineView = (l: InitialStockLine): z.infer<typeof initialLineSchema> => l;

export class ResyncStockDto extends createZodDto(z.object({ storeId: ulidSchema })) {}

// ---- allocation rules (FR-STK-04, FR-WHS-05) ----

const ruleFields = {
  mode: z.enum(["all", "percent", "fixed"]).describe("all: semua stok; percent: persentase; fixed: jumlah tetap"),
  value: quantity.describe("persen (0-100) atau jumlah tetap; diabaikan untuk all"),
  buffer: quantity.describe("dikurangi lebih dulu dari stok siap jual"),
  priority: z.number().int().min(0).max(1000).describe("lebih kecil menang bila dua aturan sama spesifik"),
  active: z.boolean(),
};

export class RuleQueryDto extends createZodDto(z.object({ storeId: ulidSchema.optional() })) {}
export class RuleIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}
export class CreateRuleDto extends createZodDto(
  z.object({
    storeId: ulidSchema,
    channelWarehouseId: ulidSchema.nullable().optional().describe("kosong: semua gudang marketplace toko"),
    variantId: ulidSchema.nullable().optional().describe("kosong: semua varian"),
    mode: ruleFields.mode,
    value: ruleFields.value.optional(),
    buffer: ruleFields.buffer.optional(),
    priority: ruleFields.priority.optional(),
    active: ruleFields.active.optional(),
  }),
) {}
export class UpdateRuleDto extends createZodDto(
  z
    .object(ruleFields)
    .partial()
    .refine((v) => Object.keys(v).length > 0, { message: "Tidak ada yang diubah." }),
) {}

const ruleSchema = z.object({
  id: ulidSchema,
  storeId: ulidSchema,
  channelWarehouseId: ulidSchema.nullable(),
  variantId: ulidSchema.nullable(),
  mode: ruleFields.mode,
  value: count,
  buffer: count,
  priority: count,
  active: z.boolean(),
  createdAt: iso,
  updatedAt: iso,
});
export class RuleDto extends createZodDto(ruleSchema) {}
export class RuleListDto extends createZodDto(z.object({ items: z.array(ruleSchema) })) {}
export function ruleView(r: RuleRow): z.infer<typeof ruleSchema> {
  return {
    id: r.id,
    storeId: r.storeId,
    channelWarehouseId: r.channelWarehouseId,
    variantId: r.variantId,
    mode: r.mode,
    value: r.value,
    buffer: r.buffer,
    priority: r.priority,
    active: r.active,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ---- restock list (FR-STK-07) ----

export class RestockQueryDto extends createZodDto(
  z.object({
    /** Days of sales the pace is measured over. */
    window: z
      .enum(["7", "14", "30"])
      .default("30")
      .transform((v) => Number(v) as 7 | 14 | 30),
    /** Stock lasting fewer days than this needs restocking. */
    coverDays: z.coerce.number().int().min(1).max(365).default(14),
    /** A restock should last this many days. */
    targetDays: z.coerce.number().int().min(1).max(365).default(30),
    warehouseId: ulidSchema.optional(),
    q: z.string().trim().max(100).optional(),
    /** All established stock instead of only what needs restocking. */
    all: z.enum(["true", "false"]).default("false"),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  }),
) {}

const restockItemSchema = z.object({
  /** The variant. */
  id: ulidSchema,
  sku: z.string(),
  productName: z.string(),
  variantName: z.string(),
  warehouseId: ulidSchema,
  warehouse: z.string(),
  available: count,
  minStock: count.nullable(),
  unitsSold: count,
  dailyRate: z.number(),
  daysOfCover: z.number().nullable(),
  suggested: count,
  reason: z.enum(["out", "below_min", "low_cover"]).nullable(),
});

export class RestockListDto extends createZodDto(
  z.object({ items: z.array(restockItemSchema), total: z.number().int(), needed: z.number().int() }),
) {}

export function restockItemView(i: RestockItem): z.infer<typeof restockItemSchema> {
  return {
    id: i.variantId,
    sku: i.sku,
    productName: i.productName,
    variantName: i.variantName,
    warehouseId: i.warehouseId,
    warehouse: i.warehouse,
    available: i.available,
    minStock: i.minStock,
    unitsSold: i.unitsSold,
    dailyRate: i.dailyRate,
    daysOfCover: i.daysOfCover,
    suggested: i.suggested,
    reason: i.reason,
  };
}
