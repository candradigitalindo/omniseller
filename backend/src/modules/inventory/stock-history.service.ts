import { Inject, Injectable } from "@nestjs/common";
import type { RequestContext } from "../../common/context/request-context";
import type { DbHandle } from "../../db/client";
import type { StockReferenceType } from "../../db/schema";
import { withTenantTx } from "../../db/tenant-tx";
import { DB_TENANT } from "../../infra/tokens";
import { OrdersService } from "../orders/orders.service";
import { ReturnsService } from "../returns/returns.service";
import { StockOpsRepository } from "./stock-ops.repository";

/** The document a movement came from, as the seller knows it: an order or return by its marketplace number. */
export interface MovementDocument {
  type: "order" | "return" | "stock_count" | "stock_transfer";
  id: string;
  number: string;
}

/**
 * The stock card's references (L21, 8.13): a movement points at a line (order line, return line, count
 * line, transfer line); the card shows the document of that line. Orders and returns only to callers who
 * may read orders, and only those in their store and warehouse scope.
 */
@Injectable()
export class StockHistoryService {
  constructor(
    @Inject(DB_TENANT) private readonly db: DbHandle,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(ReturnsService) private readonly returns: ReturnsService,
    @Inject(StockOpsRepository) private readonly ops: StockOpsRepository,
  ) {}

  /** The document of each movement, by movement id; movements without one are left out. */
  async documentsOf(
    ctx: RequestContext,
    movements: readonly { id: string; referenceType: string | null; referenceId: string | null }[],
  ): Promise<Map<string, MovementDocument>> {
    const ids = (type: StockReferenceType) =>
      movements.flatMap((m) => (m.referenceType === type && m.referenceId ? [m.referenceId] : []));
    const orderLines = ids("order_item");
    const returnLines = ids("return_item");
    const countLines = ids("stock_count_line");
    const transferLines = ids("stock_transfer_line");
    if (orderLines.length + returnLines.length + countLines.length + transferLines.length === 0) return new Map();
    const readsOrders = ctx.permissions.has("order:read");

    return withTenantTx(this.db, ctx, async (tx) => {
      // keyed by reference type and line id, as the movement names its line
      const byLine = new Map<string, MovementDocument>();
      if (readsOrders) {
        for (const [line, o] of await this.orders.ordersOfItemsIn(tx, ctx, orderLines))
          byLine.set(`order_item:${line}`, { type: "order", id: o.id, number: o.externalOrderId });
        for (const [line, r] of await this.returns.requestsOfItemsIn(tx, ctx, returnLines))
          if (r.externalOrderId)
            byLine.set(`return_item:${line}`, { type: "return", id: r.id, number: r.externalOrderId });
      }
      for (const c of await this.ops.countsOfLines(tx, countLines))
        byLine.set(`stock_count_line:${c.lineId}`, { type: "stock_count", id: c.id, number: c.number });
      for (const t of await this.ops.transfersOfLines(tx, transferLines))
        byLine.set(`stock_transfer_line:${t.lineId}`, { type: "stock_transfer", id: t.id, number: t.number });

      const out = new Map<string, MovementDocument>();
      for (const m of movements) {
        const doc = byLine.get(`${m.referenceType}:${m.referenceId}`);
        if (doc) out.set(m.id, doc);
      }
      return out;
    });
  }
}
