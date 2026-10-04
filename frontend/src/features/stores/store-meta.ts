import type { Tone } from "@/components/common/page";
import type { components } from "@/lib/api/schema";

export type Store = components["schemas"]["StoreListDto_Output"]["items"][number];
export type StoreStatus = Store["status"];
export type MarketplaceChannel = components["schemas"]["StartAuthorizationDto"]["channel"];
export type Authorization = components["schemas"]["AuthorizationDto_Output"];
export type CallbackBody = components["schemas"]["AuthorizationCallbackDto"];

export const MARKETPLACE_CHANNELS = ["shopee", "tiktokshop"] as const satisfies readonly MarketplaceChannel[];

export function isMarketplaceChannel(value: string): value is MarketplaceChannel {
  return (MARKETPLACE_CHANNELS as readonly string[]).includes(value);
}

/** Connection pill per store status (L40): red only when the seller has to act. */
export const STORE_TONE: Record<StoreStatus, Tone> = {
  connecting: "info",
  active: "success",
  token_expiring: "warning",
  reauth_required: "danger",
  disconnected: "neutral",
};

/** Statuses whose card offers "Hubungkan ulang". */
export function needsReconnect(status: StoreStatus): boolean {
  return status === "reauth_required" || status === "token_expiring";
}

/** An authorization is done once it succeeded, failed, or expired; until then the callback page polls it. */
export function isFinal(status: Authorization["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "expired";
}

/**
 * What the marketplace appended to `/integrasi/callback/{channel}`, as the api's callback body (backend
 * 8.2): `code` and `state`, Shopee's `shop_id` or `main_account_id`, TikTok Shop's `error` when the seller
 * declined. Null when the link is not a marketplace's answer (no state).
 */
export function callbackBody(channel: string, params: URLSearchParams): CallbackBody | null {
  const state = params.get("state");
  if (!isMarketplaceChannel(channel) || !state) return null;
  const value = (key: string) => {
    const v = params.get(key)?.trim();
    return v ? v : undefined;
  };
  const code = value("code");
  const shopId = value("shop_id");
  const mainAccountId = value("main_account_id");
  const error = value("error");
  return {
    channel,
    state,
    ...(code ? { code } : {}),
    ...(shopId ? { shopId } : {}),
    ...(mainAccountId ? { mainAccountId } : {}),
    ...(error ? { error } : {}),
  };
}

/** Marketplace stores first, then manual sales channels, disconnected ones last; by name within each. */
export function sortStores(stores: readonly Store[]): Store[] {
  const rank = (s: Store) => (s.status === "disconnected" ? 2 : s.channel === "manual" ? 1 : 0);
  return [...stores].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "id"));
}
