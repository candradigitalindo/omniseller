import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import { type CsvValue, toCsv } from "../../common/csv";
import { localDate } from "../../common/time-zone";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { channelDisplayName, StoresService } from "../channel/stores.service";
import { TenantsService } from "../identity/tenants.service";
import { InventoryService } from "../inventory/inventory.service";
import { OrdersService, type SalesFilter } from "../orders/orders.service";
import { changePct } from "./dashboard-plan";
import {
  alignSeries,
  averageOrderValue,
  cancellationRate,
  type Granularity,
  reportWindows,
  share,
} from "./sales-report-plan";

/** Products shown on the page; the CSV has them all. */
const TOP_PRODUCTS = 50;

export interface SalesQuery {
  from?: string | undefined;
  to?: string | undefined;
  granularity: Granularity;
  storeId?: string | undefined;
  channel?: string | undefined;
  compare: boolean;
}

export type SalesSection = "series" | "channels" | "stores" | "products" | "categories" | "regions" | "hours";

const WEEKDAYS = ["", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];

/**
 * Sales report (PRD FR-RPT-02, UI L30, backend doc 8.20): sold orders (paid, not cancelled, by order
 * time in the business's time zone) per period bucket, channel, store, product, category, buyer's
 * province, and hour, with the period before for comparison; also cancellations and orders handed to
 * couriers. Owns no tables: the figures come from OrdersService in one transaction, in the caller's
 * store and warehouse scope. Every section can be downloaded as CSV.
 */
@Injectable()
export class SalesReportService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(StoresService) private readonly stores: StoresService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  async report(ctx: RequestContext, q: SalesQuery, opts: { allProducts?: boolean } = {}) {
    const timezone = await this.tenants.timezone(ctx);
    if (q.storeId) await this.stores.get(ctx, q.storeId); // 404 outside the caller's stores
    const now = new Date();
    // this month so far unless asked otherwise
    const today = localDate(timezone, now);
    const range = { from: q.from ?? `${today.slice(0, 8)}01`, to: q.to ?? today };
    const w = reportWindows(timezone, range, now);
    const filter: SalesFilter = { storeId: q.storeId, channel: q.channel };

    return withTenantTx(this.db, ctx, async (tx) => {
      const totals = async (from: Date, to: Date) => {
        const sales = await this.orders.salesIn(tx, ctx, filter, from, to);
        const units = await this.orders.unitsSoldIn(tx, ctx, filter, from, to);
        const cancel = await this.orders.cancellationsIn(tx, ctx, filter, from, to);
        const shipped = await this.orders.shippedIn(tx, ctx, filter, from, to);
        return {
          revenue: sales.revenue,
          orders: sales.orders,
          units,
          averageOrderValue: averageOrderValue(sales),
          paidOrders: cancel.paid,
          cancelledOrders: cancel.cancelled,
          cancellationRate: cancellationRate(cancel),
          shippedOrders: shipped.orders,
          shippedRevenue: shipped.revenue,
        };
      };
      const current = await totals(w.current.from, w.current.to);
      const previous = q.compare ? await totals(w.previous.from, w.previous.to) : null;

      const series = alignSeries(
        await this.orders.salesBucketsIn(tx, ctx, filter, w.current.from, w.current.to, q.granularity, timezone),
        previous
          ? await this.orders.salesBucketsIn(tx, ctx, filter, w.previous.from, w.previous.to, q.granularity, timezone)
          : null,
        range,
        w.previousRange,
        q.granularity,
      );

      const storeRows = await this.stores.listIn(tx, ctx);
      const storeOf = new Map(storeRows.map((s) => [s.id, s]));
      const byChannel = (await this.orders.salesByIn(tx, ctx, filter, w.current.from, w.current.to, "channel")).map(
        (r) => ({
          channel: r.key ?? "",
          displayName: channelDisplayName(r.key ?? ""),
          orders: r.orders,
          revenue: r.revenue,
          share: share(r.revenue, current.revenue),
        }),
      );
      const byStore = (await this.orders.salesByIn(tx, ctx, filter, w.current.from, w.current.to, "store")).map((r) => {
        const s = storeOf.get(r.key ?? "");
        return {
          storeId: r.key ?? "",
          name: s?.name ?? "",
          channel: s?.channel ?? "",
          displayName: channelDisplayName(s?.channel ?? ""),
          orders: r.orders,
          revenue: r.revenue,
          share: share(r.revenue, current.revenue),
        };
      });
      const products = await this.products(tx, ctx, filter, w.current, opts.allProducts ? null : TOP_PRODUCTS);
      const byCategory = (
        await this.orders.itemSalesIn(tx, ctx, filter, w.current.from, w.current.to, "category", null)
      ).map((r) => ({ category: r.category, units: r.units, orders: r.orders, revenue: r.revenue }));
      const byRegion = (await this.orders.salesByIn(tx, ctx, filter, w.current.from, w.current.to, "province")).map(
        (r) => ({ province: r.label, orders: r.orders, revenue: r.revenue, share: share(r.revenue, current.revenue) }),
      );
      const byHour = await this.orders.salesByHourIn(tx, ctx, filter, w.current.from, w.current.to, timezone);

      return {
        timezone,
        range,
        granularity: q.granularity,
        period: w.current,
        previousRange: q.compare ? w.previousRange : null,
        previousPeriod: q.compare ? w.previous : null,
        summary: {
          ...current,
          previous,
          change: previous
            ? {
                revenue: changePct(current.revenue, previous.revenue),
                orders: changePct(current.orders, previous.orders),
                averageOrderValue: changePct(current.averageOrderValue, previous.averageOrderValue),
                // percentage points, not percent
                cancellationRate:
                  current.cancellationRate !== null && previous.cancellationRate !== null
                    ? Math.round((current.cancellationRate - previous.cancellationRate) * 10) / 10
                    : null,
              }
            : null,
        },
        series,
        byChannel,
        byStore,
        byProduct: products,
        byCategory,
        byRegion,
        byHour,
      };
    });
  }

  /** One section as CSV (UI L30 "Unduh laporan"); products are all of them, not the top 50. */
  async csv(ctx: RequestContext, q: SalesQuery, section: SalesSection): Promise<{ fileName: string; csv: string }> {
    const r = await this.report(ctx, q, { allProducts: section === "products" });
    const rows: CsvValue[][] = (() => {
      switch (section) {
        case "series":
          return [
            ["periode", "omzet", "pesanan", "omzet_pembanding", "pesanan_pembanding"],
            ...r.series.map((s) => [s.bucket, s.revenue, s.orders, s.previousRevenue, s.previousOrders]),
          ];
        case "channels":
          return [
            ["marketplace", "omzet", "pesanan", "porsi_persen"],
            ...r.byChannel.map((c) => [c.displayName, c.revenue, c.orders, c.share]),
          ];
        case "stores":
          return [
            ["toko", "marketplace", "omzet", "pesanan", "porsi_persen"],
            ...r.byStore.map((s) => [s.name, s.displayName, s.revenue, s.orders, s.share]),
          ];
        case "products":
          return [
            ["sku", "produk", "varian", "unit", "pesanan", "omzet"],
            ...r.byProduct.map((p) => [p.sku, p.name, p.variantName, p.units, p.orders, p.revenue]),
          ];
        case "categories":
          return [
            ["kategori", "unit", "pesanan", "omzet"],
            ...r.byCategory.map((c) => [c.category ?? "Tanpa kategori", c.units, c.orders, c.revenue]),
          ];
        case "regions":
          return [
            ["provinsi", "pesanan", "omzet", "porsi_persen"],
            ...r.byRegion.map((x) => [x.province ?? "Tidak diketahui", x.orders, x.revenue, x.share]),
          ];
        case "hours":
          return [
            ["hari", "jam", "pesanan", "omzet"],
            ...r.byHour.map((h) => [WEEKDAYS[h.weekday], h.hour, h.orders, h.revenue]),
          ];
      }
    })();
    return {
      fileName: `penjualan-${section}-${r.range.from}-${r.range.to}.csv`,
      csv: toCsv(rows, { timeZone: r.timezone }),
    };
  }

  private async products(
    tx: Parameters<OrdersService["itemSalesIn"]>[0],
    ctx: RequestContext,
    filter: SalesFilter,
    w: { from: Date; to: Date },
    limit: number | null,
  ) {
    const rows = await this.orders.itemSalesIn(tx, ctx, filter, w.from, w.to, "variant", limit);
    const variants = await this.inventory.variantsIn(
      tx,
      rows.flatMap((r) => (r.variantId ? [r.variantId] : [])),
    );
    return rows.map((r) => {
      const v = r.variantId ? variants.get(r.variantId) : undefined;
      return {
        variantId: r.variantId,
        sku: v?.sku ?? r.sku,
        name: v?.productName ?? r.title,
        variantName: v?.variantName ?? null,
        units: r.units,
        orders: r.orders,
        revenue: r.revenue,
      };
    });
  }
}
