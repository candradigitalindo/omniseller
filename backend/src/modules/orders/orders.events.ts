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

/**
 * The buyer's request to cancel an order appeared or ended at the marketplace (Shopee IN_CANCEL, TikTok
 * Shop is_buyer_request_cancel). The returns module reads the request so the seller can answer it.
 */
export const orderCancelRequestChanged = defineEvent({
  type: "order.cancel_request_changed",
  aggregate: "order",
  schema: z.object({ orderId: ulidSchema, storeId: ulidSchema, requested: z.boolean() }),
});

/**
 * The marketplace says the buyer is returning the order (Shopee TO_RETURN): its request is read soon.
 * `at` lets a burst of these share one read of the store's requests.
 */
export const orderReturnStarted = defineEvent({
  type: "order.return_started",
  aggregate: "order",
  schema: z.object({ orderId: ulidSchema, storeId: ulidSchema, at: z.iso.datetime() }),
});

/**
 * An order was cancelled after it shipped (failed delivery, a COD parcel refused): its parcel comes back
 * to the seller (RTO, FR-RET-06, FR-SHP-13).
 */
export const orderCancelledAfterShipping = defineEvent({
  type: "order.cancelled_after_shipping",
  aggregate: "order",
  schema: z.object({ orderId: ulidSchema, storeId: ulidSchema }),
});
