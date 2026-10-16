import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { WEBHOOK_CONSUMERS } from "../../jobs/webhook-consumers";
import { webhookReplayRequested } from "./sync.events";
import { WebhookInboxService } from "./webhook-inbox.service";

/**
 * One stored marketplace notification for one store. Enqueued by the webhook process right after it
 * stored the row, and again by the scheduler's inbox sweep when that enqueue did not happen.
 */
export const webhookProcessJob = defineJob({
  queue: "webhook",
  name: "webhook.process",
  schema: z.object({ inboxId: ulidSchema, replayId: ulidSchema.optional() }),
  triggeredBy: [webhookReplayRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 2_000 } },
  jobId: (p) =>
    p.replayId ? jobKey("webhook.process", p.inboxId, "replay", p.replayId) : jobKey("webhook.process", p.inboxId),
  handler: async (p, run) => {
    await run.deps.resolve(WebhookInboxService).process(run.ctx, p.inboxId, WEBHOOK_CONSUMERS, run);
  },
});

export const SYNC_JOBS = [webhookProcessJob];
