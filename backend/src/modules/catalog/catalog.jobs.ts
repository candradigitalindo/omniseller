import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { storeConnected } from "../channel/channel.events";
import type { WebhookConsumers } from "../sync/webhook-consumer";
import { listingPriceRequested, listingPullRequested, listingStatusPushRequested } from "./catalog.events";
import { ListingPriceWorkerService } from "./listing-price-worker.service";
import { ListingSyncService } from "./listing-sync.service";

/**
 * Pulls listings: in full right after a store connects (FR-INT-04), on request, every 6 hours
 * incrementally from the scheduler (`mp.poll.products`), and page by page for large catalogs.
 */
export const listingPullJob = defineJob({
  queue: "mp.poll",
  name: "listing.pull",
  schema: z.object({
    storeId: ulidSchema,
    mode: z.enum(["full", "incremental"]).default("full"),
    cursor: z.string().optional(),
    startedAt: z.iso.datetime().optional(),
    since: z.iso.datetime().optional(),
  }),
  triggeredBy: [storeConnected, listingPullRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("listing.pull", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ListingSyncService).pull(run.ctx, p, run.jobId);
  },
});

/** Activates or deactivates items on the marketplace, then reads them back (FR-PRD-10). */
export const listingStatusPushJob = defineJob({
  queue: "mp.outbound",
  name: "listing.status_push",
  schema: z.object({ storeId: ulidSchema, externalItemIds: z.array(z.string()).min(1), active: z.boolean() }),
  triggeredBy: [listingStatusPushRequested],
  // the seller switched these listings on or off: what the marketplace confirms is theirs
  actsForRequester: true,
  options: { attempts: 5, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p, meta) => jobKey("listing.status_push", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ListingSyncService).pushStatus(run.ctx, p, run.jobId);
  },
});

export const listingPricePushJob = defineJob({
  queue: "mp.outbound",
  name: "listing.price_push",
  schema: z.object({ changeId: ulidSchema }),
  triggeredBy: [listingPriceRequested],
  actsForRequester: true,
  options: { attempts: 5, backoff: { type: "marketplace" } },
  jobId: (p) => jobKey("listing.price_push", p.changeId),
  handler: async (p, run) => {
    await run.deps.resolve(ListingPriceWorkerService).push(run.ctx, p.changeId, run.attemptsMade);
  },
});
export const CATALOG_JOBS = [listingPullJob, listingStatusPushJob, listingPricePushJob];

/** A marketplace says an item changed (banned, audited, price): read that item again. */
export const CATALOG_WEBHOOK_CONSUMERS: WebhookConsumers = {
  "listing.changed": [
    async (run, event) => {
      if (event.data.externalItemId) {
        await run.deps
          .resolve(ListingSyncService)
          .refreshItems(run.ctx, event.storeId, [event.data.externalItemId], run.jobId);
      }
    },
  ],
};
