import { ORDER_STATUSES, ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

/** An order pull should run, or continue with the next page (cursor). */
export const orderPullRequested = defineEvent({
  type: "order.pull_requested",
  aggregate: "store",
  schema: z.object({
    storeId: ulidSchema,
    mode: z.enum(["initial", "incremental"]),
    cursor: z.string().max(2000).optional(),
    /** When the pull began; the next incremental pull starts here. */
    startedAt: z.iso.datetime().optional(),
    from: z.iso.datetime().optional(),
  }),
});

/** The seller cancels an order at the marketplace (FR-ORD-13). */
export const orderCancelRequested = defineEvent({
  type: "order.cancel_requested",
  aggregate: "order",
  schema: z.object({ orderId: ulidSchema, reason: z.string().min(1).max(200) }),
});

/**
 * An order moved to another status (marketplace fact, seller step, or problem state). Fulfillment keeps
 * the shipment in line with it (backend doc 8.15).
 */
export const orderStatusChanged = defineEvent({
  type: "order.status_changed",
  aggregate: "order",
  schema: z.object({
    orderId: ulidSchema,
    from: z.enum(ORDER_STATUSES),
    to: z.enum(ORDER_STATUSES),
    actorType: z.enum(["user", "system", "marketplace"]),
    actorId: ulidSchema.nullable(),
  }),
});
