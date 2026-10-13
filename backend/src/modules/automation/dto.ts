import { ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { MAX_ORDER_RULES } from "./automation-plan";
import type { OrderRule } from "./order-rules.service";

/** Automatic order processing rules (UI L55, backend doc 8.37). */

const ids = z.array(ulidSchema).max(50);
const rupiah = z.number().int().min(0).max(1_000_000_000_000);
const someField = <T extends Record<string, unknown>>(v: T) => Object.values(v).some((x) => x !== undefined);

const conditionsInput = z
  .object({
    storeIds: ids.optional().describe("toko marketplace; kosong berarti semua toko"),
    couriers: z
      .array(z.string().trim().min(1).max(60))
      .max(20)
      .optional()
      .describe("nama kurir seperti di marketplace, misalnya J&T Express; kosong berarti semua kurir"),
    warehouseIds: ids.optional().describe("gudang asal pesanan; kosong berarti semua gudang"),
    skus: z
      .array(z.string().trim().min(1).max(100))
      .max(100)
      .optional()
      .describe("pesanan yang memuat salah satu SKU ini (SKU produk atau SKU di marketplace)"),
    items: z
      .enum(["any", "single", "multiple"])
      .optional()
      .describe("jenis paket: single tepat satu barang, multiple dua barang atau lebih"),
    minTotal: rupiah.nullable().optional().describe("total pesanan paling sedikit, rupiah"),
    maxTotal: rupiah.nullable().optional().describe("total pesanan paling banyak, rupiah"),
    withinOperatingHours: z.boolean().optional().describe("hanya selama jam operasional bisnis (L43)"),
  })
  .describe("semua kondisi harus terpenuhi; yang kosong berarti apa saja");

const timeOfDay = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "Jam ditulis JJ:MM, misalnya 13:00.");
const printInput = z
  .object({
    deviceId: ulidSchema.describe("agen cetak tujuan (GET /v1/print-agents)"),
    format: z.enum(["thermal", "a4"]).optional(),
    template: z.enum(["standard", "custom"]).optional(),
    packingList: z.boolean().optional().describe("daftar kemas tepat setelah label"),
  })
  .describe("cetak label ke agen ini begitu labelnya siap (FR-SHP-18); hanya bersama arrange");

const actionsInput = z
  .object({
    warehouseId: ulidSchema.nullable().optional().describe("pindahkan pesanan ke gudang ini"),
    tagIds: z.array(ulidSchema).max(10).optional().describe("beri tag ini"),
    accept: z.boolean().optional().describe("terima pesanan"),
    arrange: z
      .enum(["pickup", "dropoff"])
      .nullable()
      .optional()
      .describe("atur pengiriman dengan pickup atau drop-off; pesanan diterima sekaligus"),
    arrangeAt: timeOfDay
      .nullable()
      .optional()
      .describe(
        "jam (zona waktu bisnis) saat permintaan atur kirim dikirim ke marketplace, pesanan diterima lebih dulu; kosong: segera. Lewat batas kirim atau jam operasional: segera",
      ),
    print: printInput.nullable().optional(),
  })
  .describe(
    "dijalankan berurutan: gudang, tag, terima, atur pengiriman (segera atau pada jamnya), cetak label saat siap",
  );

export class CreateOrderRuleDto extends createZodDto(
  z.object({
    name: z.string().trim().min(1).max(60),
    active: z.boolean().optional(),
    conditions: conditionsInput.optional(),
    actions: actionsInput,
  }),
) {}

export class UpdateOrderRuleDto extends createZodDto(
  z
    .object({
      name: z.string().trim().min(1).max(60).optional(),
      active: z.boolean().optional(),
      conditions: conditionsInput.optional().describe("menggantikan semua kondisi"),
      actions: actionsInput.optional().describe("menggantikan semua tindakan"),
    })
    .refine(someField, { message: "Tidak ada perubahan." }),
) {}

export class ReorderOrderRulesDto extends createZodDto(
  z.object({
    ids: z
      .array(ulidSchema)
      .min(1)
      .max(MAX_ORDER_RULES)
      .describe("semua aturan yang Anda kelola, yang diperiksa lebih dulu di depan"),
  }),
) {}

const ruleSchema = z.object({
  id: ulidSchema,
  name: z.string(),
  priority: z.number().int().describe("1 diperiksa lebih dulu"),
  active: z.boolean(),
  conditions: z.object({
    storeIds: z.array(z.string()),
    couriers: z.array(z.string()),
    warehouseIds: z.array(z.string()),
    skus: z.array(z.string()),
    items: z.enum(["any", "single", "multiple"]),
    minTotal: z.number().int().nullable(),
    maxTotal: z.number().int().nullable(),
    withinOperatingHours: z.boolean(),
  }),
  actions: z.object({
    warehouseId: z.string().nullable(),
    tagIds: z.array(z.string()),
    accept: z.boolean(),
    arrange: z.enum(["pickup", "dropoff"]).nullable(),
    arrangeAt: z.string().nullable().describe("JJ:MM zona waktu bisnis; null: segera"),
    print: z
      .object({
        deviceId: z.string(),
        format: z.enum(["thermal", "a4"]),
        template: z.enum(["standard", "custom"]),
        packingList: z.boolean(),
      })
      .nullable(),
  }),
  pending: z.number().int().describe("pesanan yang menunggu jam atur kirim aturan ini"),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  rowVersion: z.number().int(),
});
export class OrderRuleDto extends createZodDto(ruleSchema) {}
export class OrderRuleListDto extends createZodDto(z.object({ items: z.array(ruleSchema), next_cursor: z.null() })) {}

export function orderRuleDto(r: OrderRule) {
  return {
    id: r.id,
    name: r.name,
    priority: r.priority,
    active: r.active,
    conditions: r.conditions,
    actions: r.actions,
    pending: r.pending,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    rowVersion: r.rowVersion,
  };
}
