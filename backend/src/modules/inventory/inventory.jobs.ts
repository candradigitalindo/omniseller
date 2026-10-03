import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineJob } from "../../jobs/define";
import { jobKey } from "../../jobs/job-id";
import { stockPushJobId } from "../../jobs/stock-dirty";
import { listingMapped, listingUnmapped } from "../catalog/catalog.events";
import {
  channelWarehouseChanged,
  channelWarehouseMappingChanged,
  storeSyncModeChanged,
} from "../channel/channel.events";
import { inventoryChanged, stockResyncRequested } from "./inventory.events";
import { StockAlertsService } from "./stock-alerts.service";
import { StockPushService } from "./stock-push.service";
import { StockTriggersService } from "./stock-triggers.service";

const pair = z.object({ variantId: ulidSchema, warehouseId: ulidSchema });

/** Stock changed: mark the pairs dirty; the scheduler flushes them into stock.push after 5 quiet seconds. */
export const stockMarkDirtyJob = defineJob({
  queue: "stock.push",
  name: "stock.mark_dirty",
  schema: z.object({ pairs: z.array(pair).min(1).max(500) }),
  triggeredBy: [inventoryChanged],
  options: { attempts: 5, backoff: { type: "exponential", delay: 1_000 } },
  jobId: (p, meta) => jobKey("stock.mark_dirty", p.tenantId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(StockTriggersService).markPairs(run.ctx, p.pairs);
  },
});

/** Stock changed: variants that ran out or fell to their minimum are announced (FR-NTF-01). */
export const stockAlertJob = defineJob({
  queue: "notify",
  name: "inventory.stock_alert",
  schema: z.object({ pairs: z.array(pair).min(1).max(500) }),
  triggeredBy: [inventoryChanged],
  options: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p, meta) => jobKey("inventory.stock_alert", p.tenantId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(StockAlertsService).check(run.ctx, p.pairs);
  },
});

/**
 * Pushes a batch of debounced changes (backend doc 9.4). Enqueued by the scheduler's stock.dirty_flush,
 * never through the outbox; the id includes the debounce scores (see stock-dirty.ts).
 */
export const stockPushJob = defineJob({
  queue: "stock.push",
  name: "stock.push",
  schema: z.object({
    marks: z
      .array(pair.extend({ score: z.string().min(1).max(32) }))
      .min(1)
      .max(100),
  }),
  options: { attempts: 8, backoff: { type: "exponential", delay: 5_000 } },
  jobId: (p) => stockPushJobId(p.tenantId, p.marks),
  handler: async (p, run) => {
    await run.deps.resolve(StockPushService).push(run.ctx, p.marks, run.jobId);
  },
});

export const stockListingMappedJob = defineJob({
  queue: "stock.push",
  name: "stock.listing_mapped",
  schema: z.object({ listingId: ulidSchema }),
  triggeredBy: [listingMapped],
  options: { attempts: 5, backoff: { type: "exponential", delay: 2_000 } },
  jobId: (p, meta) => jobKey("stock.listing_mapped", p.listingId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(StockTriggersService).listingMapped(run.ctx, p.listingId);
  },
});

export const stockListingUnmappedJob = defineJob({
  queue: "stock.push",
  name: "stock.listing_unmapped",
  schema: z.object({ listingId: ulidSchema }),
  triggeredBy: [listingUnmapped],
  options: { attempts: 5, backoff: { type: "exponential", delay: 2_000 } },
  jobId: (p, meta) => jobKey("stock.listing_unmapped", p.listingId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    await run.deps.resolve(StockTriggersService).listingUnmapped(run.ctx, p.listingId);
  },
});

/**
 * A store's stock is pushed again: it went live, its marketplace warehouses or their mapping changed
 * (everything is sent again), an allocation rule changed (only changed values are sent), or the seller
 * asked. Read-only stores are left alone.
 */
export const stockStoreResyncJob = defineJob({
  queue: "stock.push",
  name: "stock.store_resync",
  schema: z.object({
    storeId: ulidSchema,
    variantIds: z.array(ulidSchema).max(1000).optional(),
    force: z.boolean().default(true),
    syncMode: z.enum(["read_only", "live"]).optional(),
  }),
  triggeredBy: [stockResyncRequested, storeSyncModeChanged, channelWarehouseChanged, channelWarehouseMappingChanged],
  options: { attempts: 5, backoff: { type: "exponential", delay: 2_000 } },
  jobId: (p, meta) => jobKey("stock.store_resync", p.storeId, meta.eventId ?? "direct"),
  handler: async (p, run) => {
    if (p.syncMode === "read_only") return;
    await run.deps
      .resolve(StockTriggersService)
      .resyncStore(run.ctx, p.storeId, { variantIds: p.variantIds, force: p.force });
  },
});

export const INVENTORY_JOBS = [
  stockMarkDirtyJob,
  stockAlertJob,
  stockPushJob,
  stockListingMappedJob,
  stockListingUnmappedJob,
  stockStoreResyncJob,
];
