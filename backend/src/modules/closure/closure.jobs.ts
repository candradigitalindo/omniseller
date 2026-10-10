import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { AccountClosureService } from "./closure.service";

/**
 * Backend doc 8.36: who manages billing hears once, a week before, that a closed account's data is about to
 * be deleted. Queued by the scheduler's account.closure_scan; `purgeAfter` keys it, so a reopened and
 * closed again account is reminded again.
 */
export const purgeReminderJob = defineJob({
  queue: "notify",
  name: "account.purge_reminder",
  schema: z.object({ purgeAfter: z.iso.datetime() }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 60_000 } },
  jobId: (p) => jobKey("account.purge_reminder", p.tenantId, String(Date.parse(p.purgeAfter))),
  handler: async (_p, run) => {
    await run.deps.resolve(AccountClosureService).remind(run.ctx);
  },
});

export const CLOSURE_JOBS = [purgeReminderJob];
