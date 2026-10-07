import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { BusinessProfileService } from "./business-profile.service";

/**
 * Renewal reminders of one business (backend doc 8.29): documents 30 and 7 days before their end date
 * and once expired, and the NIB's six-month deadline. Started per business and hour by
 * `business.legal_scan`; each reminder is claimed in its row, so a repeated run sends nothing twice.
 */
export const businessLegalAlertJob = defineJob({
  queue: "notify",
  name: "business.legal_alert",
  schema: z.object({ slot: z.string().min(1) }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p) => jobKey("business.legal_alert", p.tenantId, p.slot),
  handler: async (_p, run) => {
    await run.deps.resolve(BusinessProfileService).alertLegal(run.ctx);
  },
});

export const BUSINESS_JOBS = [businessLegalAlertJob];
