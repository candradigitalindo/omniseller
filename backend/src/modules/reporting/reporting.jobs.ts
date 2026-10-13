import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { digestEmailRequested, digestSummarySchema } from "./digest.events";
import { DigestService } from "./digest.service";
import { ScheduledReportService } from "./scheduled-report.service";

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

const localDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * FR-RPT-05: plans one business's weekly or monthly report emails for a period; from the scheduler's
 * `report.scan`, once per hour slot (a failed job is queued again next hour; the run row keeps the period once).
 */
export const reportScheduledJob = defineJob({
  queue: "notify",
  name: "report.scheduled",
  schema: z.object({
    cadence: z.enum(["weekly", "monthly"]),
    periodStart: localDay,
    periodEnd: localDay,
    slot: z.string().min(1),
  }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  jobId: (p) => jobKey("report.scheduled", p.tenantId, p.cadence, p.periodStart, p.slot),
  handler: async (p, run) => {
    await run.deps.resolve(ScheduledReportService).run(run.ctx, p);
  },
});

export const REPORTING_JOBS = [digestDailyJob, digestEmailJob, reportScheduledJob];
