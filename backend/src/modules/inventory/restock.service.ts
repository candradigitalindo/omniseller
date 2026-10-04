import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import { toCsv } from "../../common/csv";
import type { DbHandle } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { OrdersService } from "../orders/orders.service";
import { InventoryRepository } from "./inventory.repository";
import { InventoryService } from "./inventory.service";
import { type RestockLine, restockLines } from "./restock-plan";
import { stockKey } from "./stock-plan";

export interface RestockQuery {
  windowDays: 7 | 14 | 30;
  coverDays: number;
  targetDays: number;
  warehouseId?: string | undefined;
  q?: string | undefined;
  /** Only lines that need restocking. */
  needed: boolean;
  limit: number;
}

export interface RestockItem extends RestockLine {
  productName: string;
  variantName: string;
  warehouse: string;
}

const REASON_LABEL: Record<NonNullable<RestockLine["reason"]>, string> = {
  out: "Habis",
  below_min: "Di bawah minimum",
  low_cover: "Cepat habis",
};

/**
 * "Perlu restock" (PRD FR-STK-07, backend doc 8.20): established stock of active variants in the
 * caller's warehouses with how fast it sold over the last 7, 14, or 30 days (seller-fulfilled sold
 * orders, from OrdersService), the days it lasts, and what to order (restock-plan.ts). Purchase
 * orders from it come with the purchasing module (FR-STK-16).
 */
@Injectable()
export class RestockService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(InventoryRepository) private readonly repo: InventoryRepository,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  async list(ctx: RequestContext, q: RestockQuery): Promise<{ items: RestockItem[]; total: number; needed: number }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const warehouses = await this.inventory.warehousesIn(tx, ctx, q.warehouseId);
      const names = new Map(warehouses.map((w) => [w.id, w.name]));
      const now = new Date();
      const sold = new Map(
        (await this.orders.unitsByStockIn(tx, ctx, new Date(now.getTime() - q.windowDays * 86_400_000), now)).map(
          (r) => [stockKey(r.variantId, r.warehouseId), r.units],
        ),
      );
      const rows = await this.repo.restockCandidates(
        tx,
        warehouses.map((w) => w.id),
        q.q?.trim() || undefined,
      );
      const info = new Map(rows.map((r) => [stockKey(r.variantId, r.warehouseId), r]));
      const lines = restockLines(
        rows.map((r) => ({
          variantId: r.variantId,
          warehouseId: r.warehouseId,
          sku: r.sku,
          available: r.available ?? 0,
          minStock: r.minStock,
          unitsSold: sold.get(stockKey(r.variantId, r.warehouseId)) ?? 0,
        })),
        { windowDays: q.windowDays, coverDays: q.coverDays, targetDays: q.targetDays },
      );
      const needed = lines.filter((l) => l.reason !== null);
      const shown = q.needed ? needed : lines;
      return {
        items: shown.slice(0, q.limit).map((l) => {
          const r = info.get(stockKey(l.variantId, l.warehouseId))!;
          return {
            ...l,
            productName: r.productName,
            variantName: r.variantName,
            warehouse: names.get(l.warehouseId) ?? "",
          };
        }),
        total: shown.length,
        needed: needed.length,
      };
    });
  }

  /** The list as CSV, every line (UI L24 "saran restock"). */
  async csv(ctx: RequestContext, q: RestockQuery): Promise<string> {
    const { items } = await this.list(ctx, { ...q, limit: Number.MAX_SAFE_INTEGER });
    return toCsv([
      [
        "sku",
        "produk",
        "varian",
        "gudang",
        "tersedia",
        "stok_minimum",
        `terjual_${q.windowDays}_hari`,
        "terjual_per_hari",
        "cukup_untuk_hari",
        "saran_pesan",
        "alasan",
      ],
      ...items.map((i) => [
        i.sku,
        i.productName,
        i.variantName,
        i.warehouse,
        i.available,
        i.minStock,
        i.unitsSold,
        i.dailyRate,
        i.daysOfCover,
        i.suggested,
        i.reason ? REASON_LABEL[i.reason] : "",
      ]),
    ]);
  }
}
