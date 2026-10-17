import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

export const tenantDekRotationRequested = defineEvent({
  type: "tenant.dek_rotation_requested",
  aggregate: "tenant",
  schema: z.object({ rotationId: ulidSchema }),
});

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

/** A seller selected the verified shops of an App Store grant; the code has already been exchanged. */
export const storeInstallationSelected = defineEvent({
  type: "store.installation_selected",
  aggregate: "store_authorization",
  schema: z.object({ authorizationId: ulidSchema }),
});

/** A store was connected or reconnected and has fresh credentials. */
export const storeConnected = defineEvent({
  type: "store.connected",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema, reconnected: z.boolean() }),
});

/**
 * The seller disconnected a store (FR-INT-07): its open orders stop holding stock. `keepData` false
 * also asks for its data to be deleted (`store.data_deletion_requested`).
 */
export const storeDisconnected = defineEvent({
  type: "store.disconnected",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema, reason: z.string(), keepData: z.boolean().default(true) }),
});

/**
 * Delete the orders, listings, marketplace warehouses, and sync log of a store disconnected without its
 * data; also the continuation of a deletion that stopped for time (module retention, backend doc 8.23).
 */
export const storeDataDeletionRequested = defineEvent({
  type: "store.data_deletion_requested",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema }),
});

/** The seller has to authorize again (revoked, expired, refresh failing, shop banned). */
export const storeReauthRequired = defineEvent({
  type: "store.reauth_required",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema, reason: z.string() }),
});

/** The seller's authorization ends soon: the store shows "token_expiring" (FR-INT-03). */
export const storeAuthorizationExpiring = defineEvent({
  type: "store.authorization_expiring",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema, expiresAt: z.iso.datetime().nullable() }),
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

/** A seller warehouse was mapped to another OmniSeller warehouse, or unmapped (FR-WHS-02). */
export const channelWarehouseMappingChanged = defineEvent({
  type: "channel_warehouse.mapping_changed",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema, channelWarehouseId: ulidSchema, warehouseId: ulidSchema.nullable() }),
});

export const storeSyncModeChanged = defineEvent({
  type: "store.sync_mode_changed",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema, syncMode: z.enum(["read_only", "live"]) }),
});

/** Clear encrypted staged grants after local cancellation; authorization history remains. */
export const storeAuthorizationCleanupRequested = defineEvent({
  type: "store.authorization_cleanup_requested",
  aggregate: "store_authorization",
  schema: z.object({ authorizationId: ulidSchema }),
});
