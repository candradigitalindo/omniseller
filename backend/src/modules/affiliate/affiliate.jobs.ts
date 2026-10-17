import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { affiliateProductsRequested } from "./affiliate.events";
import { AffiliateWorkerService } from "./affiliate-worker.service";
export const affiliateProductsReadJob = defineJob({
  queue: "mp.poll",
  name: "affiliate.products_read",
  schema: z.object({ requestId: ulidSchema }),
  triggeredBy: [affiliateProductsRequested],
  actsForRequester: true,
  options: { attempts: 5, backoff: { type: "marketplace" } },
  jobId: (p) => jobKey("affiliate.products_read", p.requestId),
  handler: async (p, run) => {
    await run.deps.resolve(AffiliateWorkerService).read(run.ctx, p.requestId, run.attemptsMade);
  },
});
export const AFFILIATE_JOBS = [affiliateProductsReadJob];
