import { isConnectorError } from "@omniseller/connector-core";
import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { CategorySyncService } from "./category-sync.service";
import { CopyWorkerService } from "./copy-worker.service";
import {
  channelCategoryRefreshRequested,
  channelCategoryRulesRequested,
  listingCopyRequested,
  listingDraftPublishRequested,
  listingDraftRecheckRequested,
} from "./listing-copy.events";

const PREPARE_ATTEMPTS = 5;
const RECHECK_ATTEMPTS = 3;
const PUBLISH_ATTEMPTS = 5;

const reasonOf = (err: unknown) => (isConnectorError(err) ? err.detail : "terjadi kesalahan saat membaca marketplace");

/**
 * Prepares the next items of a copy (FR-PRD-13), ten per job; the job queues the next batch itself.
 * After the last attempt the copy fails with the reason, keeping the drafts made so far.
 */
export const listingCopyPrepareJob = defineJob({
  queue: "mp.poll",
  name: "listing_copy.prepare",
  schema: z.object({ copyId: ulidSchema }),
  triggeredBy: [listingCopyRequested],
  options: { attempts: PREPARE_ATTEMPTS, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("listing_copy.prepare", p.copyId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    const worker = run.deps.resolve(CopyWorkerService);
    try {
      await worker.prepare(run.ctx, p.copyId, run.jobId);
    } catch (err) {
      if (run.attemptsMade + 1 < PREPARE_ATTEMPTS) throw err;
      await worker.failCopy(run.ctx, p.copyId, `Salinan berhenti: ${reasonOf(err)}. Salin lagi untuk melanjutkan.`);
    }
  },
});

/** Drafts moved to another category get its rules and their attributes again. */
export const listingDraftRecheckJob = defineJob({
  queue: "mp.poll",
  name: "listing_draft.recheck",
  schema: z.object({ draftIds: z.array(ulidSchema).min(1).max(100) }),
  triggeredBy: [listingDraftRecheckRequested],
  options: { attempts: RECHECK_ATTEMPTS, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("listing_draft.recheck", p.draftIds[0]!, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    const worker = run.deps.resolve(CopyWorkerService);
    try {
      await worker.recheck(run.ctx, p.draftIds, run.jobId);
    } catch (err) {
      if (run.attemptsMade + 1 < RECHECK_ATTEMPTS) throw err;
      await worker.recheckGaveUp(run.ctx, p.draftIds);
    }
  },
});

/**
 * Creates one reviewed draft in its target store. Each publish of a draft is its own occurrence
 * (`attempt`), so publishing again after a failure is a new job.
 */
export const listingDraftPublishJob = defineJob({
  queue: "mp.outbound",
  name: "listing_draft.publish",
  schema: z.object({ draftId: ulidSchema, attempt: z.number().int().min(1) }),
  triggeredBy: [listingDraftPublishRequested],
  options: { attempts: PUBLISH_ATTEMPTS, backoff: { type: "exponential", delay: 15_000 } },
  jobId: (p) => jobKey("listing_draft.publish", p.draftId, p.attempt),
  handler: async (p, run) => {
    await run.deps
      .resolve(CopyWorkerService)
      .publish(run.ctx, p.draftId, p.attempt, run.jobId, run.attemptsMade + 1 < PUBLISH_ATTEMPTS);
  },
});

/** Reads a store's category tree again (asked for by the seller). */
export const channelCategoryRefreshJob = defineJob({
  queue: "mp.poll",
  name: "channel_category.refresh",
  schema: z.object({ storeId: ulidSchema }),
  triggeredBy: [channelCategoryRefreshRequested],
  options: { attempts: 3, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("channel_category.refresh", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(CategorySyncService).refresh(run.ctx, p.storeId, run.jobId);
  },
});

/** Reads the rules of a leaf category someone opened. */
export const channelCategoryRulesJob = defineJob({
  queue: "mp.poll",
  name: "channel_category.rules",
  schema: z.object({ storeId: ulidSchema, categoryId: z.string().min(1).max(64) }),
  triggeredBy: [channelCategoryRulesRequested],
  options: { attempts: 3, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("channel_category.rules", p.storeId, p.categoryId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(CategorySyncService).rulesFor(run.ctx, p.storeId, [p.categoryId], run.jobId);
  },
});

export const LISTING_COPY_JOBS = [
  listingCopyPrepareJob,
  listingDraftRecheckJob,
  listingDraftPublishJob,
  channelCategoryRefreshJob,
  channelCategoryRulesJob,
];
