import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { commerceRequested } from "./commerce.events";
import { CommerceService } from "./commerce.service";
import { CommerceWorkerService } from "./commerce-worker.service";
export const commerceExecuteJob = defineJob({
  queue: "mp.outbound",
  name: "commerce.execute",
  schema: z.object({ requestId: ulidSchema }),
  triggeredBy: [commerceRequested],
  actsForRequester: true,
  options: { attempts: 5, backoff: { type: "marketplace" } },
  jobId: (p) => jobKey("commerce.execute", p.requestId),
  handler: async (p, run) => {
    await run.deps.resolve(CommerceWorkerService).execute(run.ctx, p.requestId, run.attemptsMade);
  },
});
export const commerceCleanupJob = defineJob({
  queue: "mp.poll",
  name: "commerce.cleanup",
  schema: z.object({ slot: z.string().min(1) }),
  jobId: (p) => jobKey("commerce.cleanup", p.tenantId, p.slot),
  handler: async (_p, run) => {
    await run.deps.resolve(CommerceService).cleanup(run.ctx);
  },
});
export const COMMERCE_JOBS = [commerceExecuteJob, commerceCleanupJob];
