import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import type { WebhookConsumers } from "../sync/webhook-consumer";
import type { StoreStatusReason } from "./channel.errors";
import { storeAuthorizationReceived, storeConnected, storeWarehousesSyncRequested } from "./channel.events";
import { ChannelSyncService } from "./channel-sync.service";
import { CredentialService } from "./credential.service";
import { StoreConnectService } from "./store-connect.service";
import { StoresService } from "./stores.service";

const STORE_AUTHORIZE_ATTEMPTS = 5;

/** Exchanges the authorization code and connects the shops (once per attempt). */
export const storeAuthorizeJob = defineJob({
  queue: "mp.outbound",
  name: "store.authorize",
  schema: z.object({
    authorizationId: ulidSchema,
    code: z.string().min(1),
    shopId: z.string().optional(),
    mainAccountId: z.string().optional(),
  }),
  triggeredBy: [storeAuthorizationReceived],
  options: { attempts: STORE_AUTHORIZE_ATTEMPTS, backoff: { type: "exponential", delay: 3_000 } },
  jobId: (p) => jobKey("store.authorize", p.authorizationId),
  handler: async (p, run) => {
    await run.deps.resolve(StoreConnectService).complete(run.ctx, p, run.attemptsMade + 1 < STORE_AUTHORIZE_ATTEMPTS);
  },
});

/**
 * Imports the marketplace warehouse list: after a connection, on request, and every 6 hours from the
 * scheduler (`mp.poll.warehouses`). Per occurrence: each trigger is a new pull.
 */
export const storeWarehousesSyncJob = defineJob({
  queue: "mp.poll",
  name: "store.warehouses_sync",
  schema: z.object({ storeId: ulidSchema }),
  triggeredBy: [storeConnected, storeWarehousesSyncRequested],
  options: { attempts: 3, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("store.warehouses_sync", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ChannelSyncService).syncWarehouses(run.ctx, p.storeId, run.jobId);
  },
});

/** Registers OmniSeller's webhook address for the shop where the marketplace subscribes per shop. */
export const storeWebhooksSubscribeJob = defineJob({
  queue: "mp.outbound",
  name: "store.webhooks_subscribe",
  schema: z.object({ storeId: ulidSchema }),
  triggeredBy: [storeConnected],
  options: { attempts: 5, backoff: { type: "exponential", delay: 10_000 } },
  jobId: (p, meta) => jobKey("store.webhooks_subscribe", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ChannelSyncService).subscribeWebhooks(run.ctx, p.storeId, run.jobId);
  },
});

/**
 * Refreshes the access token at 80% of its lifetime and re-evaluates the store status against the
 * end of the authorization. Enqueued by the scheduler's `token.refresh_scan` with a per-slot id.
 */
export const storeTokenRefreshJob = defineJob({
  queue: "mp.outbound",
  name: "store.token_refresh",
  schema: z.object({ storeId: ulidSchema }),
  options: { attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
  jobId: (p) => jobKey("store.token_refresh", p.storeId, "direct"),
  handler: async (p, run) => {
    const outcome = await run.deps.resolve(CredentialService).refresh(run.ctx, p.storeId, { queueJobId: run.jobId });
    if (outcome !== "not_connected") await run.deps.resolve(StoresService).reevaluateStatus(run.ctx, p.storeId);
  },
});

export const CHANNEL_JOBS = [
  storeAuthorizeJob,
  storeWarehousesSyncJob,
  storeWebhooksSubscribeJob,
  storeTokenRefreshJob,
];

/** Shopee authorize_type values of a code 2 push, and TikTok Shop's deauthorization message. */
function revokedReason(reason: string | undefined): StoreStatusReason {
  const r = (reason ?? "").toLowerCase();
  if (r === "expiry") return "authorization_expired";
  if (r.includes("abnormal") || r.includes("frozen")) return "shop_banned";
  return "authorization_revoked";
}

/** What the channel module does with marketplace notifications about a store's authorization. */
export const CHANNEL_WEBHOOK_CONSUMERS: WebhookConsumers = {
  "authorization.revoked": [
    (run, event) =>
      run.deps.resolve(StoresService).markReauthRequired(run.ctx, event.storeId, revokedReason(event.data.reason)),
  ],
  "authorization.expiring": [
    (run, event) =>
      run.deps.resolve(StoresService).noteAuthorizationExpiry(run.ctx, event.storeId, event.data.expiresAt),
  ],
};
