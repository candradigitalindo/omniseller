import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

const pair = z.object({ variantId: ulidSchema, warehouseId: ulidSchema });

/**
 * Stock of these (variant, warehouse) pairs changed or was confirmed. Every service that calls
 * apply_stock_movement or confirm_stock writes this in the same transaction; the stock pusher marks the
 * pairs dirty and pushes them after they have been quiet for a few seconds (backend doc 9.4).
 */
export const inventoryChanged = defineEvent({
  type: "inventory.changed",
  aggregate: "inventory",
  schema: z.object({ pairs: z.array(pair).min(1).max(500) }),
});

/**
 * Push a store's stock again: after an allocation rule changed (only the variants it covers), or when
 * the seller asks. `force` pushes even values the marketplace already received.
 */
export const stockResyncRequested = defineEvent({
  type: "stock.resync_requested",
  aggregate: "store",
  schema: z.object({
    storeId: ulidSchema,
    variantIds: z.array(ulidSchema).max(1000).optional(),
    force: z.boolean(),
  }),
});
