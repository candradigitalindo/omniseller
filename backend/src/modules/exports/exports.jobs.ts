import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { ExportRenderService } from "./export-render.service";
import { exportRequested } from "./exports.events";

/**
 * FR-MIG-09: renders one full data export. Runs once: a failed export says so and the next request
 * starts a new one. A job whose worker stopped is handed to another worker by BullMQ and renders again.
 */
export const exportRenderJob = defineJob({
  queue: "export",
  name: "export.render",
  schema: z.object({ exportId: ulidSchema }),
  triggeredBy: [exportRequested],
  options: { attempts: 1 },
  jobId: (p) => jobKey("export.render", p.exportId),
  handler: async (p, run) => {
    await run.deps.resolve(ExportRenderService).render(run.ctx, p.exportId);
  },
});

export const EXPORT_JOBS = [exportRenderJob];
