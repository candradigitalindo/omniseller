import { CHANNELS, ORDER_STATUSES, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { channelDisplayName } from "../channel/stores.service";
import type { DashboardService } from "./dashboard.service";
import type { SalesReportService } from "./sales-report.service";
import { daysBetween } from "./sales-report-plan";

const iso = z.iso.datetime();

export class DashboardQueryDto extends createZodDto(
  z.object({
    /** Period of the sales cards: today so far, or the last 7 or 30 days including today. */
    range: z.enum(["today", "7d", "30d"]).default("today"),
    storeId: ulidSchema.optional(),
  }),
) {}

const money = z.number().int();

const dashboardSchema = z.object({
  timezone: z.string(),
  range: z.enum(["today", "7d", "30d"]),
  generatedAt: iso,
  period: z.object({ from: iso, to: iso, previousFrom: iso, previousTo: iso }),
  /** `report:read`. Paid, not cancelled orders by order time; the change against the period before. */
  sales: z
    .object({
      revenue: money,
      orders: z.number().int(),
      previousRevenue: money,
      previousOrders: z.number().int(),
      revenueChangePct: z.number().nullable(),
      ordersChangePct: z.number().nullable(),
    })
    .nullable(),
  /** `finance:read`. Line totals minus cost price (HPP) where it is known; marketplace fees not included. */
  grossProfit: z.object({ amount: money, revenueWithCost: money, costCoveragePct: z.number().nullable() }).nullable(),
  orders: z.object({
    /** Every status, zero included. */
    statuses: z.record(z.enum(ORDER_STATUSES), z.number().int()),
    overdue: z.number().int(),
    dueSoon: z.number().int(),
    codOutstanding: z.object({ orders: z.number().int(), total: money }),
  }),
  urgentOrders: z.array(
    z.object({
      id: ulidSchema,
      externalOrderId: z.string(),
      storeId: ulidSchema,
      channel: z.string(),
      status: z.enum(ORDER_STATUSES),
      shipByAt: iso.nullable(),
      sla: z.object({ state: z.enum(["ok", "warning", "overdue"]), remainingMs: z.number() }).nullable(),
    }),
  ),
  /** `report:read`. Daily sales of the last 30 days per channel. */
  salesChart: z
    .object({
      dates: z.array(z.string()),
      series: z.array(
        z.object({
          channel: z.string(),
          displayName: z.string(),
          revenue: z.array(money),
          orders: z.array(z.number().int()),
        }),
      ),
    })
    .nullable(),
  /** `report:read`. Best sellers of the last 7 days by units. */
  topProducts: z
    .array(
      z.object({
        variantId: ulidSchema.nullable(),
        sku: z.string(),
        name: z.string(),
        variantName: z.string().nullable(),
        units: z.number().int(),
        revenue: money,
      }),
    )
    .nullable(),
  /** `inventory:read`. Established stock that ran out or is at or under its minimum. */
  criticalStock: z
    .object({
      count: z.number().int(),
      items: z.array(
        z.object({
          variantId: ulidSchema,
          sku: z.string(),
          name: z.string(),
          variantName: z.string(),
          warehouseId: ulidSchema,
          warehouse: z.string(),
          available: z.number().int(),
          minStock: z.number().int().nullable(),
        }),
      ),
    })
    .nullable(),
  stores: z.array(
    z.object({
      id: ulidSchema,
      name: z.string(),
      channel: z.string(),
      displayName: z.string(),
      status: z.string(),
      syncMode: z.string(),
      health: z.enum(["healthy", "attention", "problem"]),
      reason: z.string().nullable(),
    }),
  ),
  tasks: z.array(
    z.object({
      kind: z.enum([
        "orders_due",
        "orders_problem",
        "orders_new",
        "stock_critical",
        "stores_reconnect",
        "listings_unmapped",
        "legal_nib",
        "legal_documents",
      ]),
      severity: z.enum(["critical", "warning", "info"]),
      count: z.number().int(),
      title: z.string(),
    }),
  ),
});

export class DashboardDto extends createZodDto(dashboardSchema) {}

export function dashboardView(d: Awaited<ReturnType<DashboardService["get"]>>): z.infer<typeof dashboardSchema> {
  return {
    timezone: d.timezone,
    range: d.range,
    generatedAt: d.generatedAt.toISOString(),
    period: {
      from: d.period.current.from.toISOString(),
      to: d.period.current.to.toISOString(),
      previousFrom: d.period.previous.from.toISOString(),
      previousTo: d.period.previous.to.toISOString(),
    },
    sales: d.sales,
    grossProfit: d.grossProfit,
    orders: {
      ...d.orders,
      statuses: Object.fromEntries(ORDER_STATUSES.map((s) => [s, d.orders.statuses[s] ?? 0])) as Record<
        (typeof ORDER_STATUSES)[number],
        number
      >,
    },
    urgentOrders: d.urgentOrders.map(({ order, sla }) => ({
      id: order.id,
      externalOrderId: order.externalOrderId,
      storeId: order.storeId,
      channel: order.channel,
      status: order.status,
      shipByAt: order.shipByAt?.toISOString() ?? null,
      sla,
    })),
    salesChart: d.salesChart
      ? {
          dates: d.salesChart.dates,
          series: d.salesChart.series.map((s) => ({ ...s, displayName: channelDisplayName(s.channel) })),
        }
      : null,
    topProducts: d.topProducts,
    criticalStock: d.criticalStock
      ? {
          count: d.criticalStock.count,
          items: d.criticalStock.items.map((i) => ({
            variantId: i.variantId,
            sku: i.sku,
            name: i.productName,
            variantName: i.variantName,
            warehouseId: i.warehouseId,
            warehouse: i.warehouse,
            available: i.available,
            minStock: i.minStock,
          })),
        }
      : null,
    stores: d.stores.map((s) => ({
      id: s.store.id,
      name: s.store.name,
      channel: s.store.channel,
      displayName: channelDisplayName(s.store.channel),
      status: s.store.status,
      syncMode: s.store.syncMode,
      health: s.health,
      reason: s.reason,
    })),
    tasks: d.tasks,
  };
}

// ---- sales report (FR-RPT-02, UI L30) ----

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Format tanggal YYYY-MM-DD.")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Tanggal tidak valid.");

const salesQuerySchema = z
  .object({
    /** First local day; with `to`. This month so far when both are absent. */
    from: isoDate.optional(),
    /** Last local day, included; at most 366 days after `from`. */
    to: isoDate.optional(),
    granularity: z.enum(["day", "week", "month"]).default("day"),
    storeId: ulidSchema.optional(),
    channel: z.enum(CHANNELS).optional(),
    /** Compare with the period before (the same months, or as many days). */
    compare: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), {
    path: ["from"],
    message: "Isi tanggal awal dan akhir bersama.",
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    path: ["to"],
    message: "Tanggal akhir harus sama dengan atau setelah tanggal awal.",
  })
  .refine((q) => !q.from || !q.to || daysBetween(q.from, q.to) <= 366, {
    path: ["to"],
    message: "Periode paling panjang 366 hari.",
  });

export class SalesReportQueryDto extends createZodDto(salesQuerySchema) {}

export class SalesExportQueryDto extends createZodDto(
  salesQuerySchema.and(
    z.object({
      /** Which part of the report; the chart's figures per period by default. */
      section: z.enum(["series", "channels", "stores", "products", "categories", "regions", "hours"]).default("series"),
    }),
  ),
) {}

const totalsSchema = z.object({
  /** Sold orders: paid, not cancelled, by order time. */
  revenue: money,
  orders: z.number().int(),
  units: z.number().int(),
  averageOrderValue: money,
  /** Orders placed in the period that were paid, and how many of them were cancelled later. */
  paidOrders: z.number().int(),
  cancelledOrders: z.number().int(),
  cancellationRate: z.number().nullable(),
  /** Orders handed to couriers in the period (by ship time), a second view of sales. */
  shippedOrders: z.number().int(),
  shippedRevenue: money,
});

const window = z.object({ from: iso, to: iso });
const dateRange = z.object({ from: z.string(), to: z.string() });

const salesReportSchema = z.object({
  timezone: z.string(),
  range: dateRange,
  granularity: z.enum(["day", "week", "month"]),
  period: window,
  previousRange: dateRange.nullable(),
  previousPeriod: window.nullable(),
  summary: totalsSchema.extend({
    previous: totalsSchema.nullable(),
    change: z
      .object({
        revenue: z.number().nullable(),
        orders: z.number().nullable(),
        averageOrderValue: z.number().nullable(),
        /** Percentage points. */
        cancellationRate: z.number().nullable(),
      })
      .nullable(),
  }),
  series: z.array(
    z.object({
      bucket: z.string(),
      orders: z.number().int(),
      revenue: money,
      previousOrders: z.number().int().nullable(),
      previousRevenue: money.nullable(),
    }),
  ),
  byChannel: z.array(
    z.object({
      channel: z.string(),
      displayName: z.string(),
      orders: z.number().int(),
      revenue: money,
      share: z.number(),
    }),
  ),
  byStore: z.array(
    z.object({
      storeId: z.string(),
      name: z.string(),
      channel: z.string(),
      displayName: z.string(),
      orders: z.number().int(),
      revenue: money,
      share: z.number(),
    }),
  ),
  byProduct: z.array(
    z.object({
      variantId: ulidSchema.nullable(),
      sku: z.string(),
      name: z.string(),
      variantName: z.string().nullable(),
      units: z.number().int(),
      orders: z.number().int(),
      revenue: money,
    }),
  ),
  byCategory: z.array(
    z.object({ category: z.string().nullable(), units: z.number().int(), orders: z.number().int(), revenue: money }),
  ),
  byRegion: z.array(
    z.object({ province: z.string().nullable(), orders: z.number().int(), revenue: money, share: z.number() }),
  ),
  /** Weekday 1 (Monday) to 7 (Sunday) and hour of the business's time zone; empty cells left out. */
  byHour: z.array(
    z.object({ weekday: z.number().int(), hour: z.number().int(), orders: z.number().int(), revenue: money }),
  ),
});

export class SalesReportDto extends createZodDto(salesReportSchema) {}

const windowView = (w: { from: Date; to: Date }) => ({ from: w.from.toISOString(), to: w.to.toISOString() });

export function salesReportView(
  r: Awaited<ReturnType<SalesReportService["report"]>>,
): z.infer<typeof salesReportSchema> {
  return {
    ...r,
    period: windowView(r.period),
    previousPeriod: r.previousPeriod ? windowView(r.previousPeriod) : null,
  };
}
