import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

/**
 * The seller came back from the marketplace with a one-time authorization code. The code is exchanged
 * by the worker (backend doc 8.6, ADR-029); it is useless once exchanged and expires within minutes.
 */
export const storeAuthorizationReceived = defineEvent({
  type: "store.authorization_received",
  aggregate: "store_authorization",
  schema: z.object({
    authorizationId: ulidSchema,
    code: z.string().min(1).max(512),
    shopId: z.string().max(40).optional(),
    mainAccountId: z.string().max(40).optional(),
  }),
});

/** A store was connected or reconnected and has fresh credentials. */
export const storeConnected = defineEvent({
  type: "store.connected",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema, reconnected: z.boolean() }),
});

export const storeDisconnected = defineEvent({
  type: "store.disconnected",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema, reason: z.string() }),
});

/** The seller has to authorize again (revoked, expired, refresh failing, shop banned). */
export const storeReauthRequired = defineEvent({
  type: "store.reauth_required",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema, reason: z.string() }),
});

export const storeWarehousesSyncRequested = defineEvent({
  type: "store.warehouses_sync_requested",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema }),
});

/** Marketplace warehouses appeared or disappeared (FR-WHS-10): the mapping may need attention. */
export const channelWarehouseChanged = defineEvent({
  type: "channel_warehouse.changed",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema, added: z.number().int(), removed: z.number().int() }),
});

export const storeSyncModeChanged = defineEvent({
  type: "store.sync_mode_changed",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema, syncMode: z.enum(["read_only", "live"]) }),
});
