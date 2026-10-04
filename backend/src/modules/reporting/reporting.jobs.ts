import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { digestEmailRequested, digestSummarySchema } from "./digest.events";
import { DigestService } from "./digest.service";

/** FR-NTF-02: plans one business's daily operational emails; from the scheduler's `digest.scan`. */
export const digestDailyJob = defineJob({
  queue: "notify",
  name: "digest.daily",
  schema: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  jobId: (p) => jobKey("digest.daily", p.tenantId, p.date),
  handler: async (p, run) => {
    await run.deps.resolve(DigestService).run(run.ctx, p.date);
  },
});

/** Sends one person's daily email; retried on its own. */
export const digestEmailJob = defineJob({
  queue: "notify",
  name: "digest.email",
  schema: z.object({ userId: z.string(), tenantName: z.string(), summary: digestSummarySchema }),
  triggeredBy: [digestEmailRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("digest.email", p.userId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(DigestService).send(run.ctx, p);
  },
});

export const REPORTING_JOBS = [digestDailyJob, digestEmailJob];
