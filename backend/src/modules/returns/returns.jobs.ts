import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { storeConnected } from "../channel/channel.events";
import { orderCancelledAfterShipping, orderCancelRequestChanged, orderReturnStarted } from "../orders/orders.events";
import type { WebhookConsumers } from "../sync/webhook-consumer";
import { ReturnAlertsService } from "./return-alerts.service";
import { ReturnSyncService } from "./return-sync.service";
import {
  returnDetailsRequested,
  returnPullRequested,
  returnRefreshRequested,
  returnRespondRequested,
} from "./returns.events";

const RESPOND_ATTEMPTS = 5;
/** Pulls wait this long before they run, and a burst of returning orders within it shares one pull. */
const RETURN_PULL_DELAY_MS = 10_000;

/**
 * Reads a store's return requests (FR-RET-01): 30 days when the store connects, every 10 minutes for
 * every connected store (scheduler `mp.poll.returns`), when an order says its buyer started a return
 * (Shopee TO_RETURN, which has no return push), and page by page.
 */
export const returnPullJob = defineJob({
  queue: "mp.poll",
  name: "return.pull",
  schema: z.object({
    storeId: ulidSchema,
    cursor: z.string().optional(),
    startedAt: z.iso.datetime().optional(),
    from: z.iso.datetime().optional(),
    initial: z.boolean().optional(),
    /** `order.return_started`: when the order changed; a pull that started later covered it. */
    at: z.iso.datetime().optional(),
  }),
  triggeredBy: [storeConnected, returnPullRequested, orderReturnStarted],
  // the delay lets a burst of `order.return_started` share one run: their ids are the same within 10
  // seconds of the orders' change, and the run starts after the slot is over
  options: { attempts: 5, backoff: { type: "exponential", delay: 10_000 }, delay: RETURN_PULL_DELAY_MS },
  jobId: (p, meta) =>
    p.at
      ? jobKey("return.pull", p.storeId, `at${Math.floor(Date.parse(p.at) / RETURN_PULL_DELAY_MS)}`)
      : jobKey("return.pull", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ReturnSyncService).pull(run.ctx, p, run.jobId);
  },
});

/** Decisions of a store's changed requests, 50 a job, continued while more wait. */
export const returnDetailsJob = defineJob({
  queue: "mp.poll",
  name: "return.details",
  schema: z.object({ storeId: ulidSchema }),
  triggeredBy: [returnDetailsRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("return.details", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ReturnSyncService).continueDecisions(run.ctx, p.storeId, run.jobId);
  },
});

/** One request read again with its decisions (the seller asked). */
export const returnRefreshJob = defineJob({
  queue: "mp.poll",
  name: "return.refresh",
  schema: z.object({ returnRequestId: ulidSchema }),
  triggeredBy: [returnRefreshRequested],
  options: { attempts: 3, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("return.refresh", p.returnRequestId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ReturnSyncService).refreshRequest(run.ctx, p.returnRequestId, run.jobId);
  },
});

/**
 * Sends the seller's decision (FR-RET-02). Each decision is its own occurrence (`attempt`), so answering
 * again after a failure is a new job.
 */
export const returnRespondJob = defineJob({
  queue: "mp.outbound",
  name: "return.respond",
  schema: z.object({ returnRequestId: ulidSchema, attempt: z.number().int().min(1) }),
  triggeredBy: [returnRespondRequested],
  actsForRequester: true,
  options: { attempts: RESPOND_ATTEMPTS, backoff: { type: "exponential", delay: 15_000 } },
  jobId: (p) => jobKey("return.respond", p.returnRequestId, p.attempt),
  handler: async (p, run) => {
    await run.deps
      .resolve(ReturnSyncService)
      .respond(run.ctx, p.returnRequestId, p.attempt, run.jobId, run.attemptsMade + 1 < RESPOND_ATTEMPTS);
  },
});

/** The buyer asked to cancel an order, or the request ended: the cancellation request is read. */
export const returnCancellationFollowJob = defineJob({
  queue: "mp.poll",
  name: "return.cancellation_follow",
  schema: z.object({ orderId: ulidSchema, storeId: ulidSchema, requested: z.boolean() }),
  triggeredBy: [orderCancelRequestChanged],
  options: { attempts: 5, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("return.cancellation_follow", p.orderId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ReturnSyncService).followCancellations(run.ctx, p.storeId, [p.orderId], run.jobId);
  },
});

/** FR-RET-06: an order cancelled after it shipped; its parcel is expected back (rto). */
export const returnRtoOpenJob = defineJob({
  queue: "order.ingest",
  name: "return.rto_open",
  schema: z.object({ orderId: ulidSchema, storeId: ulidSchema }),
  triggeredBy: [orderCancelledAfterShipping],
  options: { attempts: 5, backoff: { type: "exponential", delay: 2_000 } },
  jobId: (p) => jobKey("return.rto_open", p.orderId),
  handler: async (p, run) => {
    await run.deps.resolve(ReturnSyncService).openRto(run.ctx, p.orderId);
  },
});

/** New requests and returning parcels, from the scheduler every 5 minutes for tenants with some. */
export const returnNewNoticeJob = defineJob({
  queue: "notify",
  name: "return.new_notice",
  schema: z.object({ slot: z.string().min(1) }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p) => jobKey("return.new_notice", p.tenantId, p.slot),
  handler: async (_p, run) => {
    await run.deps.resolve(ReturnAlertsService).notifyNew(run.ctx);
  },
});

/** FR-RET-07: deadlines within 12 hours, from the scheduler every 15 minutes for tenants with some. */
export const returnDueAlertJob = defineJob({
  queue: "notify",
  name: "return.due_alert",
  schema: z.object({ slot: z.string().min(1) }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p) => jobKey("return.due_alert", p.tenantId, p.slot),
  handler: async (_p, run) => {
    await run.deps.resolve(ReturnAlertsService).alertDue(run.ctx);
  },
});

export const RETURN_JOBS = [
  returnPullJob,
  returnDetailsJob,
  returnRefreshJob,
  returnRespondJob,
  returnCancellationFollowJob,
  returnRtoOpenJob,
  returnNewNoticeJob,
  returnDueAlertJob,
];

/** TikTok Shop return status notifications: the return is read again by its id. */
const refreshReturn: NonNullable<WebhookConsumers["return.changed"]>[number] = async (run, event) => {
  if (!event.data.externalReturnId) return;
  await run.deps
    .resolve(ReturnSyncService)
    .refreshReturns(run.ctx, event.storeId, [event.data.externalReturnId], run.jobId);
};

export const RETURN_WEBHOOK_CONSUMERS: WebhookConsumers = {
  "return.changed": [refreshReturn],
};
