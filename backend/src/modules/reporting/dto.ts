import { ORDER_STATUSES, ulidSchema } from "@omniseller/shared";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { channelDisplayName } from "../channel/stores.service";
import type { DashboardService } from "./dashboard.service";

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
