import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";
export const affiliateAuthorizationReceived = defineEvent({
  type: "affiliate_account.authorization_received",
  aggregate: "affiliate_authorization",
  schema: z.object({ authorizationId: ulidSchema, code: z.string().min(1).max(2000) }),
});
export const affiliateAccountRefreshRequested = defineEvent({
  type: "affiliate_account.refresh_requested",
  aggregate: "affiliate_account",
  schema: z.object({ accountId: ulidSchema }),
});
export const affiliateGrantCleanupRequested = defineEvent({
  type: "affiliate_account.grant_cleanup_requested",
  aggregate: "affiliate_authorization",
  schema: z.object({ authorizationId: ulidSchema }),
});
