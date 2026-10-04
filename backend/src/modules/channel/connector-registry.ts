import type { ConnectorManifest, HttpConfig, MarketplaceConnector } from "@omniseller/connector-core";
import { createShopeeConnector, SHOPEE_MANIFEST } from "@omniseller/connector-shopee";
import { createTiktokShopConnector, TIKTOKSHOP_MANIFEST } from "@omniseller/connector-tiktokshop";
import type { Env } from "../../config/env.schema";
import { connectorCallObserver, connectorRequestGate } from "../sync/connector-calls";
import { channelNotConfigured } from "./channel.errors";

/** Channels with a connector today. Lazada and Blibli follow in phase 2 (PRD 14). */
export const SUPPORTED_CHANNELS = ["shopee", "tiktokshop"] as const;
export type SupportedChannel = (typeof SUPPORTED_CHANNELS)[number];

export function isSupportedChannel(value: string): value is SupportedChannel {
  return (SUPPORTED_CHANNELS as readonly string[]).includes(value);
}

export const MANIFESTS: Record<SupportedChannel, ConnectorManifest> = {
  shopee: SHOPEE_MANIFEST,
  tiktokshop: TIKTOKSHOP_MANIFEST,
};

export const CONNECTORS = Symbol("CONNECTORS");

function str(env: Env, key: string): string | undefined {
  const v = (env as unknown as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(env: Env, key: string): number | undefined {
  const v = (env as unknown as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

/**
 * The connectors this process may use, built from its environment (backend doc 5.2): the api process
 * only builds authorization links from public ids, the webhook process only verifies signatures, and
 * the worker calls the marketplace APIs. A channel without its keys is "not configured".
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<SupportedChannel, MarketplaceConnector>();

  constructor(entries: [SupportedChannel, MarketplaceConnector][] = []) {
    for (const [ch, c] of entries) this.connectors.set(ch, c);
  }

  static fromEnv(env: Env, fetchImpl?: typeof fetch): ConnectorRegistry {
    const http: HttpConfig = {
      observer: connectorCallObserver,
      beforeRequest: connectorRequestGate,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    };
    const entries: [SupportedChannel, MarketplaceConnector][] = [];
    const role = env.APP_ROLE;

    const partnerId = num(env, "SHOPEE_PARTNER_ID");
    const partnerKey = str(env, "SHOPEE_PARTNER_KEY");
    if (partnerId && (role === "api" || partnerKey)) {
      entries.push([
        "shopee",
        createShopeeConnector({
          partnerId,
          ...(partnerKey ? { partnerKey } : {}),
          apiBaseUrl: str(env, "SHOPEE_API_BASE_URL") ?? "https://partner.shopeemobile.com",
          authBaseUrl: str(env, "SHOPEE_AUTH_BASE_URL") ?? "https://open.shopee.com",
          ...(num(env, "SHOPEE_VARIANT_DELAY_MS") !== undefined
            ? { variantDelayMs: num(env, "SHOPEE_VARIANT_DELAY_MS")! }
            : {}),
          http,
        }),
      ]);
    }

    const serviceId = str(env, "TIKTOKSHOP_SERVICE_ID");
    const appKey = str(env, "TIKTOKSHOP_APP_KEY");
    const appSecret = str(env, "TIKTOKSHOP_APP_SECRET");
    const tiktokUsable = role === "api" ? !!serviceId : !!appKey && !!appSecret;
    if (tiktokUsable) {
      entries.push([
        "tiktokshop",
        createTiktokShopConnector({
          ...(appKey ? { appKey } : {}),
          ...(appSecret ? { appSecret } : {}),
          ...(serviceId ? { serviceId } : {}),
          apiBaseUrl: str(env, "TIKTOKSHOP_API_BASE_URL") ?? "https://open-api.tiktokglobalshop.com",
          authBaseUrl: str(env, "TIKTOKSHOP_AUTH_BASE_URL") ?? "https://auth.tiktok-shops.com",
          authorizeUrl: str(env, "TIKTOKSHOP_AUTHORIZE_URL") ?? "https://services.tiktokshop.com/open/authorize",
          http,
        }),
      ]);
    }
    return new ConnectorRegistry(entries);
  }

  isConfigured(channel: SupportedChannel): boolean {
    return this.connectors.has(channel);
  }

  get(channel: string): MarketplaceConnector {
    const c = isSupportedChannel(channel) ? this.connectors.get(channel) : undefined;
    if (!c) throw channelNotConfigured(channel);
    return c;
  }
}
