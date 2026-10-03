import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { FilesService } from "./files.service";

/**
 * `files.cleanup_expired` (scheduler, hourly per tenant with expired files): labels and documents carry
 * buyer names and addresses and are kept only as long as they are useful (backend doc 8.15).
 */
export const filesCleanupJob = defineJob({
  queue: "pdf",
  name: "files.cleanup_expired",
  schema: z.object({ slot: z.string().min(1) }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  jobId: (p) => jobKey("files.cleanup_expired", p.tenantId, p.slot),
  handler: async (_p, run) => {
    await run.deps.resolve(FilesService).cleanupExpired(run.ctx);
  },
});

export const FILES_JOBS = [filesCleanupJob];
