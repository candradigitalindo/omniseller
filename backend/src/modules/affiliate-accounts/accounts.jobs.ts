import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import {
  affiliateAccountRefreshRequested,
  affiliateAuthorizationReceived,
  affiliateGrantCleanupRequested,
} from "./accounts.events";
import { AffiliateAccountConnectService } from "./accounts-connect.service";
import { AffiliateAccountCredentialsService } from "./accounts-credentials.service";
export const affiliateAccountAuthorizeJob = defineJob({
  queue: "mp.outbound",
  name: "affiliate_account.authorize",
  schema: z.object({ authorizationId: ulidSchema, code: z.string().min(1).max(2000) }),
  triggeredBy: [affiliateAuthorizationReceived],
  options: { attempts: 5, backoff: { type: "marketplace" } },
  jobId: (p) => jobKey("affiliate_account.authorize", p.authorizationId),
  handler: async (p, run) => {
    await run.deps
      .resolve(AffiliateAccountConnectService)
      .complete(run.ctx, p.authorizationId, p.code, run.attemptsMade);
  },
});
export const affiliateAccountRefreshJob = defineJob({
  queue: "mp.outbound",
  name: "affiliate_account.refresh",
  schema: z.object({ accountId: ulidSchema }),
  triggeredBy: [affiliateAccountRefreshRequested],
  options: { attempts: 5, backoff: { type: "marketplace" } },
  jobId: (p, meta) => jobKey("affiliate_account.refresh", p.accountId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(AffiliateAccountCredentialsService).refresh(run.ctx, p.accountId, run.attemptsMade < 4);
  },
});
export const affiliateGrantCleanupJob = defineJob({
  queue: "mp.outbound",
  name: "affiliate_account.grant_cleanup",
  schema: z.object({ authorizationId: ulidSchema }),
  triggeredBy: [affiliateGrantCleanupRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 3000 } },
  jobId: (p) => jobKey("affiliate_account.grant_cleanup", p.authorizationId),
  handler: async (p, run) => {
    await run.deps.resolve(AffiliateAccountConnectService).clearCancelledGrant(run.ctx, p.authorizationId);
  },
});
export const AFFILIATE_ACCOUNT_JOBS = [
  affiliateAccountAuthorizeJob,
  affiliateAccountRefreshJob,
  affiliateGrantCleanupJob,
];
