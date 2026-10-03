import { Inject, Injectable } from "@nestjs/common";
import type { OrderStatus } from "@omniseller/shared";
import type { Tx } from "../../db/client";
import { InventoryService } from "../inventory/inventory.service";
import { WarehousesService } from "../inventory/warehouses.service";
import type { OrderRow } from "../orders/orders.repository";
import { OrdersService, orderStatusLabel } from "../orders/orders.service";
import { PICKABLE, type PickInput, type PickLine, pickLines } from "./shipping-plan";

export interface PickListSection {
  warehouseId: string | null;
  warehouse: string;
  orders: number;
  units: number;
  lines: PickLine[];
}

export interface Missing {
  orderId: string;
  code: string;
  message: string;
}

/** Why an order has nothing to pick, in the seller's words. */
export function notPickable(o: OrderRow): Missing | null {
  if (o.fulfillmentMode === "marketplace") {
    return { orderId: o.id, code: "order.marketplace_fulfilled", message: "Pesanan ini dikirim oleh marketplace." };
  }
  if (!PICKABLE.has(o.status)) {
    return {
      orderId: o.id,
      code: "order.not_pickable",
      message: `Pesanan berstatus ${orderStatusLabel(o.status as OrderStatus)}; tidak ada barang yang perlu diambil.`,
    };
  }
  return null;
}

/**
 * The pick list of a set of orders (FR-SHP-02, FR-WHS-08): open units of every line, per warehouse and
 * SKU, with the bin location from inventory. Lines whose SKU is not mapped yet are listed by the
 * marketplace SKU and title, without a bin.
 */
@Injectable()
export class PickListBuilder {
  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
  ) {}

  async buildIn(tx: Tx, orderIds: string[]): Promise<{ sections: PickListSection[]; missing: Missing[] }> {
    const { orders, items } = await this.orders.readIn(tx, orderIds);
    const missing: Missing[] = [];
    const pickable = new Map<string, OrderRow>();
    for (const o of orders) {
      const why = notPickable(o);
      if (why) missing.push(why);
      else pickable.set(o.id, o);
    }
    const open = items.filter((i) => pickable.has(i.orderId) && i.qty - i.cancelledQty > 0);
    const warehouseOf = (i: (typeof open)[number]) => i.warehouseId ?? pickable.get(i.orderId)!.warehouseId;
    const pairs = open
      .filter((i) => i.variantId && warehouseOf(i))
      .map((i) => ({ variantId: i.variantId!, warehouseId: warehouseOf(i)! }));
    const [info, warehouses] = await Promise.all([this.inventory.pickInfoIn(tx, pairs), this.warehouses.activeIn(tx)]);
    const inputs: PickInput[] = open.map((i) => {
      const wh = warehouseOf(i);
      const v = i.variantId ? info.variants.get(i.variantId) : undefined;
      return {
        orderId: i.orderId,
        warehouseId: wh,
        variantId: i.variantId,
        sku: v?.sku ?? (i.skuSnapshot || "(tanpa SKU)"),
        name: v?.productName ?? i.titleSnapshot,
        variantName: v?.variantName ?? ((i.variantSnapshot.name as string | undefined) || null),
        bin: i.variantId && wh ? (info.bins.get(`${i.variantId}|${wh}`) ?? null) : null,
        qty: i.qty - i.cancelledQty,
      };
    });
    const lines = pickLines(inputs);
    const byWarehouse = new Map<string, PickListSection>();
    for (const line of lines) {
      const key = line.warehouseId ?? "";
      const section = byWarehouse.get(key) ?? {
        warehouseId: line.warehouseId,
        warehouse: warehouses.find((w) => w.id === line.warehouseId)?.name ?? "Gudang belum ditetapkan",
        orders: 0,
        units: 0,
        lines: [],
      };
      section.lines.push(line);
      section.units += line.qty;
      byWarehouse.set(key, section);
    }
    for (const section of byWarehouse.values()) {
      section.orders = new Set(
        inputs.filter((i) => (i.warehouseId ?? "") === (section.warehouseId ?? "")).map((i) => i.orderId),
      ).size;
    }
    const sections = [...byWarehouse.values()].sort((a, b) => a.warehouse.localeCompare(b.warehouse));
    return { sections, missing };
  }
}
