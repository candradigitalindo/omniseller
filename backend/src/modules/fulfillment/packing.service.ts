import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle, Tx } from "../../db/client";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { InventoryService } from "../inventory/inventory.service";
import type { OrderRow } from "../orders/orders.repository";
import { OrdersService } from "../orders/orders.service";
import { packingMismatch } from "./fulfillment.errors";
import type { PrintTarget } from "./print.service";
import { type LabelPrint, type ScanLabelOptions, ScanService } from "./scan.service";
import { checkPacking } from "./scan-plan";
import type { Refusal } from "./shipping-plan";

/** One thing to put in the parcel: a variant (or a line without a product) and how many. */
export interface PackingLine {
  key: string;
  variantId: string | null;
  sku: string;
  barcode: string | null;
  name: string;
  variantName: string | null;
  imageUrl: string | null;
  qty: number;
  /** What a scan of this line may read: barcode, SKU, the SKU on the order, and the key (counted by hand). */
  codes: string[];
}

export interface PackingView {
  order: OrderRow;
  /** Why "Tandai dikemas" would refuse the order now; null: it can be packed. */
  packRefusal: Refusal | null;
  /** Why its label cannot be printed now; null: "Cetak label dan lanjut" works. */
  labelRefusal: Refusal | null;
  lines: PackingLine[];
}

/**
 * Packing by scan (PRD FR-SHP-04, UI L06, backend doc 8.24): scan the order number or tracking number,
 * then every item; the station counts each scan against the order's lines and the server checks the
 * whole parcel once more before marking the order packed, refusing a wrong SKU or quantity. "Cetak label
 * dan lanjut" prints the label on the station's agent in the same request.
 */
@Injectable()
export class PackingService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(ScanService) private readonly scan: ScanService,
  ) {}

  /** L06: the order behind a scanned code, what goes in its parcel, and whether it can be packed now. */
  async lookup(ctx: RequestContext, code: string): Promise<PackingView> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const order = await this.scan.orderIn(tx, ctx, code);
      // one connection runs one query at a time: no Promise.all inside a transaction
      const packRefusal = await this.orders.packRefusalIn(tx, order);
      const labelRefusal = await this.scan.labelRefusalIn(tx, order);
      return { order, packRefusal, labelRefusal, lines: await this.linesIn(tx, order) };
    });
  }

  /** The order's open lines, one per variant (lines of the same variant add up). */
  private async linesIn(tx: Tx, o: OrderRow): Promise<PackingLine[]> {
    const { items } = await this.orders.readIn(tx, [o.id]);
    const open = items.filter((i) => i.qty - i.cancelledQty > 0);
    const variants = await this.inventory.variantsIn(
      tx,
      open.flatMap((i) => (i.variantId ? [i.variantId] : [])),
    );
    const lines = new Map<string, PackingLine>();
    for (const i of open) {
      const v = i.variantId ? variants.get(i.variantId) : undefined;
      const key = v ? v.variantId : `sku:${i.skuSnapshot}`;
      const line = lines.get(key);
      if (line) {
        line.qty += i.qty - i.cancelledQty;
        if (i.skuSnapshot && !line.codes.includes(i.skuSnapshot)) line.codes.push(i.skuSnapshot);
        continue;
      }
      lines.set(key, {
        key,
        variantId: v?.variantId ?? null,
        sku: v?.sku ?? i.skuSnapshot,
        barcode: v?.barcode ?? null,
        name: v?.productName ?? i.titleSnapshot,
        variantName: v ? (v.variantName !== v.productName ? v.variantName : null) : null,
        imageUrl: v?.imageUrl ?? null,
        qty: i.qty - i.cancelledQty,
        codes: [...new Set([v?.barcode, v?.sku, i.skuSnapshot, key].filter((c): c is string => !!c))],
      });
    }
    return [...lines.values()];
  }

  /**
   * The station's scans for one order: when they match every line exactly, the order is packed (the
   * checks of "Tandai dikemas") and, with `print`, its label goes to the agent. A label that cannot be
   * printed yet does not stop the packing; the answer says why.
   */
  async complete(
    ctx: RequestContext,
    orderId: string,
    input: { scans: { code: string; qty: number }[]; print?: (PrintTarget & ScanLabelOptions) | undefined },
  ): Promise<{ order: OrderRow; print: LabelPrint | null; printRefusal: Refusal | null }> {
    return withTenantTx(this.db, ctx, async (tx) => {
      const o = await this.orders.visibleIn(tx, ctx, orderId, true);
      const lines = await this.linesIn(tx, o);
      const check = checkPacking(lines, input.scans);
      if (!check.ok) throw packingMismatch(check);
      const units = lines.reduce((n, l) => n + l.qty, 0);
      const order = await this.orders.packIn(tx, ctx, o, { verified: "scan", units });
      if (!input.print) return { order, print: null, printRefusal: null };
      const printRefusal = await this.scan.labelRefusalIn(tx, order);
      if (printRefusal) return { order, print: null, printRefusal };
      return { order, print: await this.scan.printLabelIn(tx, ctx, order, input.print, input.print), printRefusal };
    });
  }
}
