import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

/** A listing pull should run (or continue with the next page). */
export const listingPullRequested = defineEvent({
  type: "listing.pull_requested",
  aggregate: "store",
  schema: z.object({
    storeId: ulidSchema,
    mode: z.enum(["full", "incremental"]),
    cursor: z.string().max(2000).optional(),
    /** When the pull began; on the last page of a full pull, listings not seen since are closed. */
    startedAt: z.iso.datetime().optional(),
    since: z.iso.datetime().optional(),
  }),
});

/** Activate or deactivate whole items on the marketplace (FR-PRD-10). */
export const listingStatusPushRequested = defineEvent({
  type: "listing.status_push_requested",
  aggregate: "store",
  schema: z.object({
    storeId: ulidSchema,
    externalItemIds: z.array(z.string().min(1)).min(1).max(500),
    active: z.boolean(),
  }),
});

/** A listing got or lost its variant; stock push and order matching consume these later. */
export const listingMapped = defineEvent({
  type: "listing.mapped",
  aggregate: "channel_listing",
  schema: z.object({
    listingId: ulidSchema,
    variantId: ulidSchema,
    source: z.enum(["auto_sku", "manual", "created", "copied"]),
  }),
});

export const listingUnmapped = defineEvent({
  type: "listing.unmapped",
  aggregate: "channel_listing",
  schema: z.object({ listingId: ulidSchema, previousVariantId: ulidSchema }),
});
