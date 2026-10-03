import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { listingMapped } from "../catalog/catalog.events";
import { storeConnected } from "../channel/channel.events";
import { inventoryChanged } from "../inventory/inventory.events";
import type { WebhookConsumers } from "../sync/webhook-consumer";
import { OrderSyncService } from "./order-sync.service";
import { orderCancelRequested, orderPullRequested } from "./orders.events";

/**
 * Reads orders: 90 days of history when a store connects (FR-INT-04), every 5 minutes as a fallback
 * for missed webhooks (FR-INT-05, scheduler `mp.poll.orders`), on request, and page by page.
 */
export const orderPullJob = defineJob({
  queue: "mp.poll",
  name: "order.pull",
  schema: z.object({
    storeId: ulidSchema,
    mode: z.enum(["initial", "incremental"]).default("initial"),
    reconnected: z.boolean().optional(),
    cursor: z.string().optional(),
    startedAt: z.iso.datetime().optional(),
    from: z.iso.datetime().optional(),
  }),
  triggeredBy: [storeConnected, orderPullRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("order.pull", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    // a reconnected store continues from its cursor instead of importing 90 days again
    const mode = p.reconnected ? "incremental" : p.mode;
    await run.deps.resolve(OrderSyncService).pull(run.ctx, { ...p, mode }, run.jobId);
  },
});

/** Seller cancellation at the marketplace, then a fresh read of the order (FR-ORD-13). */
export const orderCancelJob = defineJob({
  queue: "mp.outbound",
  name: "order.cancel",
  schema: z.object({ orderId: ulidSchema, reason: z.string().min(1) }),
  triggeredBy: [orderCancelRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p, meta) => jobKey("order.cancel", p.orderId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(OrderSyncService).cancel(run.ctx, p.orderId, p.reason, run.jobId);
  },
});

/** A listing got its variant: orders that sold it lose their unmapped SKU problem and reserve stock. */
export const orderListingMappedJob = defineJob({
  queue: "order.ingest",
  name: "order.listing_mapped",
  schema: z.object({ listingId: ulidSchema }),
  triggeredBy: [listingMapped],
  options: { attempts: 5, backoff: { type: "exponential", delay: 2_000 } },
  jobId: (p, meta) => jobKey("order.listing_mapped", p.listingId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(OrderSyncService).attachListing(run.ctx, p.listingId);
  },
});

/** Stock changed: orders short of these items may no longer be (insufficient_stock). */
export const orderStockRecheckJob = defineJob({
  queue: "order.ingest",
  name: "order.stock_recheck",
  schema: z.object({
    pairs: z
      .array(z.object({ variantId: ulidSchema, warehouseId: ulidSchema }))
      .min(1)
      .max(500),
  }),
  triggeredBy: [inventoryChanged],
  options: { attempts: 3, backoff: { type: "exponential", delay: 2_000 } },
  jobId: (p, meta) => jobKey("order.stock_recheck", p.tenantId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(OrderSyncService).recheckStock(run.ctx, p.pairs);
  },
});

export const ORDER_JOBS = [orderPullJob, orderCancelJob, orderListingMappedJob, orderStockRecheckJob];

/** Order notifications: the order is read again from the marketplace (FR-ORD-01). */
const refresh: NonNullable<WebhookConsumers["order.status_changed"]>[number] = async (run, event) => {
  if (!event.data.externalOrderId) return;
  await run.deps.resolve(OrderSyncService).refresh(run.ctx, event.storeId, [event.data.externalOrderId], {
    source: "webhook",
    rawRef: event.inboxId,
    queueJobId: run.jobId,
  });
};

export const ORDER_WEBHOOK_CONSUMERS: WebhookConsumers = {
  "order.status_changed": [refresh],
  "order.tracking_updated": [refresh],
};
