import { ulidSchema } from "@omniseller/shared";
import { z } from "zod";
import { defineEvent } from "../../jobs/define";

/** A copy was asked for, or its next batch of items should be prepared. */
export const listingCopyRequested = defineEvent({
  type: "listing_copy.requested",
  aggregate: "listing_copy",
  schema: z.object({ copyId: ulidSchema }),
});

/** Drafts whose category changed: read that category's rules and map the source to it again. */
export const listingDraftRecheckRequested = defineEvent({
  type: "listing_draft.recheck_requested",
  aggregate: "listing_draft",
  schema: z.object({ draftIds: z.array(ulidSchema).min(1).max(100) }),
});

/** A reviewed draft should be created in its target store. */
export const listingDraftPublishRequested = defineEvent({
  type: "listing_draft.publish_requested",
  aggregate: "listing_draft",
  schema: z.object({ draftId: ulidSchema, attempt: z.number().int().min(1) }),
});

/** The category tree of a store should be read again from the marketplace. */
export const channelCategoryRefreshRequested = defineEvent({
  type: "channel_category.refresh_requested",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema }),
});

/** The rules (attributes, limits) of a store's leaf category should be read. */
export const channelCategoryRulesRequested = defineEvent({
  type: "channel_category.rules_requested",
  aggregate: "store",
  schema: z.object({ storeId: ulidSchema, categoryId: z.string().min(1).max(64) }),
});
