import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { storeDataDeletionRequested } from "../channel/channel.events";
import { BuyerDataRetentionService } from "./buyer-data-retention.service";
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

/**
 * PRD 12.1, backend doc 8.34: one business's orders past its buyer data retention lose the buyer's personal
 * data. Queued by the hourly `retention.buyer_scan`, once per business and hour.
 */
export const buyerDataAnonymizeJob = defineJob({
  queue: "import",
  name: "retention.buyer_anonymize",
  schema: z.object({ slot: z.string().min(1) }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 60_000 } },
  jobId: (p) => jobKey("retention.buyer_anonymize", p.tenantId, p.slot),
  handler: async (_p, run) => {
    await run.deps.resolve(BuyerDataRetentionService).run(run.ctx);
  },
});

export const RETENTION_JOBS = [storeDataDeleteJob, buyerDataAnonymizeJob];
