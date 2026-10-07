import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import { seesCost } from "../../common/cost-visibility";
import { localDate, startOfDate } from "../../common/time-zone";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { BusinessProfileService } from "../business/business-profile.service";
import { ListingsService } from "../catalog/listings.service";
import { isManualChannel, StoresService, statusMessage } from "../channel/stores.service";
import { TenantsService } from "../identity/tenants.service";
import { InventoryService } from "../inventory/inventory.service";
import { slaOf } from "../orders/order-plan";
import { OrdersService } from "../orders/orders.service";
import {
  bySeverity,
  changePct,
  type DashboardRange,
  lastDates,
  rangeWindows,
  salesSeries,
  storeHealth,
  tasksFrom,
} from "./dashboard-plan";

const CHART_DAYS = 30;
const TOP_DAYS = 7;
const TOP_PRODUCTS = 5;
const URGENT_ORDERS = 5;
const CRITICAL_ITEMS = 5;

/**
 * The home dashboard (PRD FR-RPT-01, UI L01): sales against the period before, orders per status and
 * near their ship-by deadline, best sellers, critical stock, store health, and what needs doing. Owns no
 * tables: every figure comes from the module that owns the data, in one transaction, inside the caller's
 * store and warehouse scope. Sections need their permission: sales `report:read`, profit
 * `finance:read`, stock `inventory:read`, unmapped listings `catalog:read`.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(ListingsService) private readonly listings: ListingsService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
    @Inject(BusinessProfileService) private readonly business: BusinessProfileService,
  ) {}

  async get(ctx: RequestContext, q: { range: DashboardRange; storeId?: string | undefined }) {
    const can = (p: string) => ctx.permissions.has(p);
    const timezone = await this.tenants.timezone(ctx);
    const now = new Date();
    if (q.storeId) await this.stores.get(ctx, q.storeId); // 404 outside the caller's stores
    const window = rangeWindows(q.range, timezone, now);
    const chartDates = lastDates(timezone, now, CHART_DAYS);
    const topFrom = startOfDate(timezone, lastDates(timezone, now, TOP_DAYS)[0]!);
    // manual sales channels have no connection whose health could fail
    const storeViews = (await this.stores.list(ctx)).filter(
      (v) =>
        v.store.status !== "disconnected" &&
        !isManualChannel(v.store.channel) &&
        (!q.storeId || v.store.id === q.storeId),
    );
    const filter = { storeId: q.storeId };

    return withTenantTx(this.db, ctx, async (tx) => {
      const summary = await this.orders.summaryIn(tx, ctx, filter);
      const urgent = await this.orders.urgentIn(tx, ctx, filter, URGENT_ORDERS);

      let sales = null;
      let salesChart = null;
      let topProducts = null;
      if (can("report:read")) {
        const current = await this.orders.salesIn(tx, ctx, filter, window.current.from, window.current.to);
        const previous = await this.orders.salesIn(tx, ctx, filter, window.previous.from, window.previous.to);
        sales = {
          revenue: current.revenue,
          orders: current.orders,
          previousRevenue: previous.revenue,
          previousOrders: previous.orders,
          revenueChangePct: changePct(current.revenue, previous.revenue),
          ordersChangePct: changePct(current.orders, previous.orders),
        };
        const rows = await this.orders.salesByDayIn(
          tx,
          ctx,
          filter,
          startOfDate(timezone, chartDates[0]!),
          now,
          timezone,
        );
        salesChart = { dates: chartDates, series: salesSeries(rows, chartDates) };
        const top = await this.orders.topProductsIn(tx, ctx, filter, topFrom, now, TOP_PRODUCTS);
        const variants = await this.inventory.variantsIn(
          tx,
          top.flatMap((t) => (t.variantId ? [t.variantId] : [])),
        );
        topProducts = top.map((t) => {
          const v = t.variantId ? variants.get(t.variantId) : undefined;
          return {
            variantId: t.variantId,
            sku: v?.sku ?? t.sku,
            name: v?.productName ?? t.title,
            variantName: v?.variantName ?? null,
            units: t.units,
            revenue: t.revenue,
          };
        });
      }

      let grossProfit = null;
      if (seesCost(ctx)) {
        const p = await this.orders.grossProfitIn(tx, ctx, filter, window.current.from, window.current.to);
        grossProfit = {
          amount: p.profit,
          revenueWithCost: p.costedRevenue,
          costCoveragePct: p.revenue > 0 ? Math.round((p.costedRevenue / p.revenue) * 1000) / 10 : null,
        };
      }

      const criticalStock = can("inventory:read") ? await this.inventory.criticalIn(tx, ctx, CRITICAL_ITEMS) : null;
      const unmappedListings = can("catalog:read") ? await this.listings.unmappedCountIn(tx, ctx) : null;

      const stores = storeViews.map((v) => ({
        store: v.store,
        ...storeHealth(
          {
            status: v.store.status,
            reasonText: statusMessage(v.store.statusReason),
            syncMode: v.store.syncMode,
            lastOrderSyncAt: v.store.lastOrderSyncAt,
            unmappedWarehouses: v.unmappedWarehouses,
          },
          now,
        ),
      }));

      return {
        timezone,
        range: q.range,
        generatedAt: now,
        period: window,
        sales,
        grossProfit,
        orders: summary,
        urgentOrders: urgent.map((o) => ({ order: o, sla: slaOf(o.shipByAt, o.status, now) })),
        salesChart,
        topProducts,
        criticalStock,
        stores,
        tasks: bySeverity([
          ...tasksFrom({
            overdue: summary.overdue,
            dueSoon: summary.dueSoon,
            problem: summary.statuses.problem ?? 0,
            newOrders: summary.statuses.new ?? 0,
            criticalStock: criticalStock?.count ?? null,
            storesToReconnect: stores.filter((s) => s.health === "problem").length,
            unmappedListings,
          }),
          // the NIB and legal papers are the business keeper's (settings:billing, UI L47)
          ...(can("settings:billing") ? await this.business.legalTasksIn(tx, localDate(timezone, now)) : []),
        ]),
      };
    });
  }
}
