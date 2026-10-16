import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import type { WebhookConsumers } from "../sync/webhook-consumer";
import type { StoreStatusReason } from "./channel.errors";
import {
  channelWarehouseChanged,
  storeAuthorizationExpiring,
  storeAuthorizationReceived,
  storeConnected,
  storeReauthRequired,
  storeWarehousesSyncRequested,
  tenantDekRotationRequested,
} from "./channel.events";
import { ChannelAlertsService } from "./channel-alerts.service";
import { ChannelSyncService } from "./channel-sync.service";
import { CredentialService } from "./credential.service";
import { KeyRotationService } from "./key-rotation.service";
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

/** FR-NTF-01: the store must be authorized again; the people who manage it are told. */
export const storeReauthNoticeJob = defineJob({
  queue: "notify",
  name: "store.reauth_notice",
  schema: z.object({ storeId: ulidSchema, reason: z.string() }),
  triggeredBy: [storeReauthRequired],
  options: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p, meta) => jobKey("store.reauth_notice", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ChannelAlertsService).reauthRequired(run.ctx, p.storeId, p.reason);
  },
});

/** FR-NTF-01: the seller's authorization ends soon. */
export const storeExpiryNoticeJob = defineJob({
  queue: "notify",
  name: "store.expiry_notice",
  schema: z.object({ storeId: ulidSchema, expiresAt: z.iso.datetime().nullable() }),
  triggeredBy: [storeAuthorizationExpiring],
  options: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p, meta) => jobKey("store.expiry_notice", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ChannelAlertsService).authorizationExpiring(run.ctx, p.storeId, p.expiresAt);
  },
});

/** FR-WHS-10: marketplace warehouses appeared or disappeared; the people who manage the store are told. */
export const storeWarehousesNoticeJob = defineJob({
  queue: "notify",
  name: "store.warehouses_notice",
  schema: z.object({ storeId: ulidSchema, added: z.number().int(), removed: z.number().int() }),
  triggeredBy: [channelWarehouseChanged],
  options: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p, meta) => jobKey("store.warehouses_notice", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(ChannelAlertsService).warehousesChanged(run.ctx, p.storeId, p.added, p.removed);
  },
});

/**
 * FR-INT-08: connections down for more than 15 minutes, and connections back, of one tenant. Enqueued by
 * the scheduler's `store.connection_scan` with one id per tenant per 5-minute slot.
 */
export const storeConnectionCheckJob = defineJob({
  queue: "notify",
  name: "store.connection_check",
  schema: z.object({}),
  options: { attempts: 3, backoff: { type: "exponential", delay: 10_000 } },
  jobId: () => jobKey("store.connection_check", "direct"),
  handler: async (_p, run) => {
    await run.deps.resolve(ChannelAlertsService).checkConnections(run.ctx);
  },
});

export const tenantDekRotateJob = defineJob({
  queue: "import",
  name: "tenant.dek_rotate",
  schema: z.object({ rotationId: ulidSchema }),
  triggeredBy: [tenantDekRotationRequested],
  options: { attempts: 5, backoff: { type: "exponential", delay: 30_000 } },
  jobId: (p) => jobKey("tenant.dek_rotate", p.tenantId, p.rotationId),
  handler: async (p, run) => {
    await run.deps.resolve(KeyRotationService).run(run.ctx, p.rotationId);
  },
});

export const CHANNEL_JOBS = [
  tenantDekRotateJob,
  storeAuthorizeJob,
  storeWarehousesSyncJob,
  storeWebhooksSubscribeJob,
  storeTokenRefreshJob,
  storeReauthNoticeJob,
  storeExpiryNoticeJob,
  storeWarehousesNoticeJob,
  storeConnectionCheckJob,
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
