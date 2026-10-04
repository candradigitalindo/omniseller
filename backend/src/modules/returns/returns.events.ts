import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

/** A pull of a store's return requests should continue with the next page (cursor). */
export const returnPullRequested = defineEvent({
  type: "return.pull_requested",
  aggregate: "store",
  schema: z.object({
    storeId: ulidSchema,
    cursor: z.string().max(2000).optional(),
    /** When the pull began; the next pull starts here. */
    startedAt: z.iso.datetime().optional(),
    from: z.iso.datetime().optional(),
    /** The store's first pull: what it reads is history and is not announced. */
    initial: z.boolean().optional(),
  }),
});

/** More of a store's requests wait for their decisions to be read (a burst of new requests). */
export const returnDetailsRequested = defineEvent({
  type: "return.details_requested",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema }),
});

/** One request should be read again from the marketplace, with what the seller may decide. */
export const returnRefreshRequested = defineEvent({
  type: "return.refresh_requested",
  aggregate: "return_request",
  schema: z.object({ returnRequestId: ulidSchema }),
});

/** The seller's decision on a request should be sent to the marketplace (FR-RET-02). */
export const returnRespondRequested = defineEvent({
  type: "return.respond_requested",
  aggregate: "return_request",
  schema: z.object({ returnRequestId: ulidSchema, attempt: z.number().int().min(1) }),
});
