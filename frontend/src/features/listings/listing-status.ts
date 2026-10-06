import type { components } from "@/lib/api/schema";

type Listing = components["schemas"]["ListingPageDto_Output"]["items"][number];

/**
 * Whether a listing can be switched on or off from here (FR-PRD-10): not deleted on the marketplace, and its
 * store's connection works (the api refuses the others).
 */
export function switchable(l: Pick<Listing, "status">, storeUsable: boolean): boolean {
  return l.status !== "deleted" && storeUsable;
}

/**
 * How many marketplace products the chosen listings are: a marketplace switches a whole product, so every
 * variant of it goes on or off together.
 */
export function marketplaceItems(listings: readonly Pick<Listing, "storeId" | "externalItemId">[]): number {
  return new Set(listings.map((l) => `${l.storeId}|${l.externalItemId}`)).size;
}
