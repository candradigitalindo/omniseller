import { STOCK_COUNT_STATUSES, STOCK_TRANSFER_STATUSES, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { pageSchema, paginationQuery } from "../../common/http/pagination";
import type { StockCountView } from "./stock-count.service";
import type { CountLineDetail } from "./stock-ops.repository";
import { MAX_TRANSFER_LINES } from "./stock-ops-plan";
import type { StockTransferView } from "./stock-transfer.service";

/** Request and response DTOs of stock counts and transfers (FR-STK-08, 09; backend doc 8.27). */

const iso = z.iso.datetime();
const at = (d: Date | null) => (d ? d.toISOString() : null);
const units = z.number().int();
const warehouseRef = z.object({ id: ulidSchema, code: z.string(), name: z.string() });
const note = z.string().trim().max(500).nullish();

// ---- stock counts ----

export class StockCountIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export class StockCountQueryDto extends createZodDto(
  paginationQuery.extend({
    status: z.enum(STOCK_COUNT_STATUSES).optional(),
    warehouseId: ulidSchema.optional(),
  }),
) {}

export class CreateStockCountDto extends createZodDto(
  z
    .object({
      warehouseId: ulidSchema,
      mode: z.enum(["full", "partial"]).describe("full: semua SKU gudang; partial: varian atau rak tertentu"),
      variantIds: z.array(ulidSchema).max(5_000).optional().describe("opname parsial: varian yang dihitung"),
      binPrefix: z
        .string()
        .trim()
        .min(1)
        .max(50)
        .optional()
        .describe("opname parsial: rak yang lokasinya diawali teks ini, misalnya `A-01`"),
      blind: z.boolean().optional().describe("sembunyikan jumlah sistem selama menghitung; bawaan ya"),
      note,
    })
    .superRefine((v, c) => {
      const chosen = (v.variantIds?.length ?? 0) > 0 || !!v.binPrefix;
      if (v.mode === "partial" && !chosen) {
        c.addIssue({ code: "custom", path: ["variantIds"], message: "Pilih varian atau rak yang dihitung." });
      }
      if (v.mode === "full" && chosen) {
        c.addIssue({
          code: "custom",
          path: ["mode"],
          message: "Opname penuh menghitung semua SKU gudang; pilih parsial untuk varian atau rak tertentu.",
        });
      }
    }),
) {}

export class StockCountLinesQueryDto extends createZodDto(
  paginationQuery.extend({
    filter: z
      .enum(["all", "uncounted", "counted", "differences"])
      .default("all")
      .describe("differences hanya setelah hitungan dikirim untuk ditinjau bila opname buta"),
    q: z.string().trim().max(100).optional().describe("SKU, nama produk, rak, atau barcode"),
  }),
) {}

const countQty = z.number().int().min(0).max(10_000_000);

export class RecordCountDto extends createZodDto(
  z.object({
    lines: z
      .array(
        z
          .object({
            variantId: ulidSchema,
            qty: countQty,
            mode: z.enum(["set", "add"]).describe("set: jumlah di rak; add: tambahkan unit yang dipindai"),
          })
          .superRefine((l, c) => {
            if (l.mode === "add" && l.qty === 0) {
              c.addIssue({ code: "custom", path: ["qty"], message: "Jumlah yang ditambahkan minimal 1." });
            }
          }),
      )
      .min(1)
      .max(500),
  }),
) {}

export class ScanCountDto extends createZodDto(
  z.object({
    code: z.string().trim().min(1).max(100).describe("barcode atau SKU yang dipindai"),
    qty: z.number().int().min(1).max(10_000).default(1),
  }),
) {}

export class ApplyStockCountDto extends createZodDto(
  z.object({
    zeroUncounted: z
      .boolean()
      .default(false)
      .describe("SKU yang tidak dihitung dianggap habis (0); bawaan: dibiarkan seperti catatan"),
  }),
) {}

const statsSchema = z.object({
  lines: units,
  counted: units,
  differences: units.nullable().describe("null selama opname buta masih dihitung"),
  added: units.describe("SKU yang ditemukan di rak tetapi tidak ada di daftar"),
});

const stockCountSchema = z.object({
  id: ulidSchema,
  number: z.string(),
  warehouse: warehouseRef.nullable(),
  mode: z.enum(["full", "partial"]),
  blind: z.boolean(),
  status: z.enum(STOCK_COUNT_STATUSES),
  statusChangedAt: iso,
  note: z.string().nullable(),
  createdBy: ulidSchema.nullable(),
  submittedAt: iso.nullable(),
  submittedBy: ulidSchema.nullable(),
  applyRequestedAt: iso.nullable().describe("disetujui; stok sedang atau sudah diterapkan"),
  applyRequestedBy: ulidSchema.nullable(),
  zeroUncounted: z.boolean(),
  appliedAt: iso.nullable(),
  stats: statsSchema,
  difference: z
    .object({
      unitsOver: units,
      unitsUnder: units,
      value: z.number().int().nullable().describe("selisih nilai pada HPP; null tanpa izin finance:read"),
    })
    .nullable()
    .describe("null selama opname buta masih dihitung"),
  rowVersion: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
});

export class StockCountDto extends createZodDto(stockCountSchema) {}
export class StockCountPageDto extends createZodDto(pageSchema(stockCountSchema)) {}

export const stockCountView = (v: StockCountView): z.infer<typeof stockCountSchema> => {
  const c = v.count;
  return {
    id: c.id,
    number: c.number,
    warehouse: v.warehouse,
    mode: c.mode,
    blind: c.blind,
    status: c.status,
    statusChangedAt: c.statusChangedAt.toISOString(),
    note: c.note,
    createdBy: c.createdBy,
    submittedAt: at(c.submittedAt),
    submittedBy: c.submittedBy,
    applyRequestedAt: at(c.applyRequestedAt),
    applyRequestedBy: c.applyRequestedBy,
    zeroUncounted: c.zeroUncounted,
    appliedAt: at(c.appliedAt),
    stats: { ...v.stats, differences: v.hidden ? null : v.stats.differences },
    difference: v.difference,
    rowVersion: c.rowVersion,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
};

const countLineSchema = z.object({
  id: ulidSchema,
  variantId: ulidSchema,
  sku: z.string().describe("SKU, nama, barcode, dan rak saat baris didaftar atau ditemukan"),
  productName: z.string(),
  variantName: z.string(),
  barcode: z.string().nullable(),
  binLocation: z.string().nullable(),
  expectedQty: units.nullable().describe("jumlah sistem saat dihitung; null selama opname buta masih dihitung"),
  countedQty: units.nullable(),
  diff: units.nullable().describe("dihitung dikurangi sistem; null bila belum dihitung atau masih buta"),
  reserved: units.nullable().describe("unit pesanan terbuka di gudang ini sekarang; null selama opname buta"),
  added: z.boolean().describe("ditemukan di rak, tidak ada di daftar"),
  countedAt: iso.nullable(),
  countedBy: ulidSchema.nullable(),
  appliedDelta: units.nullable().describe("perubahan stok saat diterapkan"),
});

export class StockCountLinePageDto extends createZodDto(pageSchema(countLineSchema)) {}
export class StockCountLinesDto extends createZodDto(z.object({ items: z.array(countLineSchema) })) {}
export class ScanCountResultDto extends createZodDto(
  z.object({ matchedBy: z.enum(["barcode", "sku"]), line: countLineSchema }),
) {}

export const countLineView = (d: CountLineDetail, hidden: boolean): z.infer<typeof countLineSchema> => ({
  id: d.line.id,
  variantId: d.line.variantId,
  sku: d.line.sku,
  productName: d.line.productName,
  variantName: d.line.variantName,
  barcode: d.line.barcode,
  binLocation: d.line.binLocation,
  expectedQty: hidden ? null : d.line.expectedQty,
  countedQty: d.line.countedQty,
  diff: hidden ? null : d.line.diff,
  reserved: hidden ? null : d.reserved,
  added: d.line.added,
  countedAt: at(d.line.countedAt),
  countedBy: d.line.countedBy,
  appliedDelta: d.line.appliedDelta,
});

// ---- stock transfers ----

export class StockTransferIdParamDto extends createZodDto(z.object({ id: ulidSchema })) {}

export class StockTransferQueryDto extends createZodDto(
  paginationQuery.extend({
    status: z.enum(STOCK_TRANSFER_STATUSES).optional(),
    warehouseId: ulidSchema.optional().describe("transfer yang keluar dari atau masuk ke gudang ini"),
    direction: z
      .enum(["out", "in"])
      .optional()
      .describe("out: keluar; in: masuk (dengan warehouseId atau cakupan Anda)"),
  }),
) {}

const transferLines = z
  .array(z.object({ variantId: ulidSchema, qty: z.number().int().min(1).max(10_000_000) }))
  .min(1)
  .max(MAX_TRANSFER_LINES);

export class CreateStockTransferDto extends createZodDto(
  z.object({ fromWarehouseId: ulidSchema, toWarehouseId: ulidSchema, note, lines: transferLines }),
) {}

export class UpdateStockTransferDto extends createZodDto(
  z
    .object({
      toWarehouseId: ulidSchema.optional(),
      note,
      lines: transferLines.optional().describe("menggantikan semua baris"),
    })
    .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Tidak ada yang diubah." }),
) {}

export class ReceiveStockTransferDto extends createZodDto(
  z.object({
    lines: z
      .array(z.object({ lineId: ulidSchema, receivedQty: z.number().int().min(0).max(10_000_000) }))
      .max(MAX_TRANSFER_LINES)
      .optional()
      .describe("hanya baris yang tidak tiba lengkap; baris lain dianggap diterima penuh"),
    note,
  }),
) {}

const transferLineSchema = z.object({
  id: ulidSchema,
  variantId: ulidSchema,
  sku: z.string().nullable(),
  productName: z.string().nullable(),
  variantName: z.string().nullable(),
  qty: units,
  receivedQty: units.nullable(),
  missingQty: units.nullable().describe("dikirim tetapi tidak tiba"),
});

const stockTransferSchema = z.object({
  id: ulidSchema,
  number: z.string(),
  from: warehouseRef.nullable(),
  to: warehouseRef.nullable(),
  status: z.enum(STOCK_TRANSFER_STATUSES),
  statusChangedAt: iso,
  note: z.string().nullable(),
  createdBy: ulidSchema.nullable(),
  sentAt: iso.nullable(),
  sentBy: ulidSchema.nullable(),
  receivedAt: iso.nullable(),
  receivedBy: ulidSchema.nullable(),
  receiptNote: z.string().nullable(),
  cancelledAt: iso.nullable(),
  cancelledBy: ulidSchema.nullable(),
  units: units.describe("jumlah unit dikirim"),
  lines: z.array(transferLineSchema),
  rowVersion: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
});

export class StockTransferDto extends createZodDto(stockTransferSchema) {}
export class StockTransferPageDto extends createZodDto(pageSchema(stockTransferSchema)) {}
export class TransferDestinationsDto extends createZodDto(z.object({ items: z.array(warehouseRef) })) {}

export const stockTransferView = (v: StockTransferView): z.infer<typeof stockTransferSchema> => {
  const t = v.transfer;
  return {
    id: t.id,
    number: t.number,
    from: v.from,
    to: v.to,
    status: t.status,
    statusChangedAt: t.statusChangedAt.toISOString(),
    note: t.note,
    createdBy: t.createdBy,
    sentAt: at(t.sentAt),
    sentBy: t.sentBy,
    receivedAt: at(t.receivedAt),
    receivedBy: t.receivedBy,
    receiptNote: t.receiptNote,
    cancelledAt: at(t.cancelledAt),
    cancelledBy: t.cancelledBy,
    units: v.lines.reduce((n, l) => n + l.qty, 0),
    lines: v.lines.map((l) => ({
      id: l.id,
      variantId: l.variantId,
      sku: l.sku,
      productName: l.productName,
      variantName: l.variantName,
      qty: l.qty,
      receivedQty: l.receivedQty,
      missingQty: l.receivedQty === null ? null : l.qty - l.receivedQty,
    })),
    rowVersion: t.rowVersion,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
};
