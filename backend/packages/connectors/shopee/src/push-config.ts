import type { ShopeeClient } from "./client.js";

/**
 * App-level push settings (v2.push.get_app_push_config / set_app_push_config). Shopee sends a test
 * push to the callback URL when it is set and rejects URLs that do not answer 2xx within 3 seconds,
 * so the webhook process must be reachable before this is called.
 */
export interface ShopeePushConfig {
  callback_url?: string;
  live_push_status?: string;
  suspended_time?: number;
  blocked_shop_id?: number[];
  push_config_on_list?: number[];
  push_config_off_list?: number[];
}

/** Push codes OmniSeller subscribes to: authorization lifecycle, orders, tracking numbers, Shopee updates. */
export const SHOPEE_SUBSCRIBED_PUSH_CODES = [1, 2, 3, 4, 5, 12] as const;

export async function getShopeePushConfig(client: ShopeeClient): Promise<ShopeePushConfig> {
  const res = await client.publicCall<{ response?: ShopeePushConfig }>("GET", "/api/v2/push/get_app_push_config");
  return res.response ?? {};
}

export async function setShopeePushConfig(
  client: ShopeeClient,
  input: { callbackUrl: string; on: readonly number[]; off?: readonly number[] },
): Promise<string> {
  const res = await client.publicCall<{ response?: { result?: string } }>("POST", "/api/v2/push/set_app_push_config", {
    body: {
      callback_url: input.callbackUrl,
      set_push_config_on: [...input.on],
      set_push_config_off: [...(input.off ?? [])],
      blocked_shop_id_list: [],
    },
  });
  return res.response?.result ?? "unknown";
}
