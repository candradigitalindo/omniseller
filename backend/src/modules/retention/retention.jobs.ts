import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { storeDataDeletionRequested } from "../channel/channel.events";
import { StoreDataDeletionService } from "./store-data-deletion.service";

/**
 * FR-INT-07: deletes the data of a store disconnected without keeping it; a large store continues
 * through the same event, one job per run (queue `import`, bulk data work).
 */
export const storeDataDeleteJob = defineJob({
  queue: "import",
  name: "store.data_delete",
  schema: z.object({ storeId: ulidSchema }),
  triggeredBy: [storeDataDeletionRequested],
  // the seller chose to disconnect without keeping the data: the deletions are theirs
  actsForRequester: true,
  options: { attempts: 5, backoff: { type: "exponential", delay: 30_000 } },
  jobId: (p, meta) => jobKey("store.data_delete", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(StoreDataDeletionService).run(run.ctx, p.storeId);
  },
});

export const RETENTION_JOBS = [storeDataDeleteJob];
