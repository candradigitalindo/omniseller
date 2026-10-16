import { and, eq } from "drizzle-orm";
import type { RequestContext } from "../../common/context/request-context";
import type { Tx } from "../../db/client";
import { inventory, warehouse } from "../../db/schema/inventory";
import type { StockPair } from "../../jobs/stock-dirty";
import type { Outbox } from "../../outbox/outbox";
import { stockPushRequested } from "./inventory.events";

export async function requestStockPushIn(
  tx: Tx,
  ctx: RequestContext,
  outbox: Outbox,
  pair: StockPair,
  dryRun: boolean,
) {
  const [row] = await tx
    .select({ established: inventory.stockSetAt })
    .from(inventory)
    .where(and(eq(inventory.variantId, pair.variantId), eq(inventory.warehouseId, pair.warehouseId)));
  const [wh] = await tx.select({ active: warehouse.active }).from(warehouse).where(eq(warehouse.id, pair.warehouseId));
  if (!row?.established || !wh?.active) throw new Error("stock must be established in an active warehouse");
  if (!dryRun) await outbox.enqueue(tx, ctx, stockPushRequested, pair, pair.variantId);
  return { selected: 1 };
}
