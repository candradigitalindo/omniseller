import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { NotificationEmailService } from "./email.service";
import { notificationEmailRequested } from "./notification.events";

/** One notification by email to its recipient, once (backend doc 8.17). */
export const notificationEmailJob = defineJob({
  queue: "notify",
  name: "notification.email",
  schema: z.object({ notificationId: ulidSchema }),
  triggeredBy: [notificationEmailRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 30_000 } },
  jobId: (p) => jobKey("notification.email", p.notificationId),
  handler: async (p, run) => {
    await run.deps.resolve(NotificationEmailService).send(run.ctx, p.notificationId);
  },
});

export const NOTIFICATION_JOBS = [notificationEmailJob];
