import {
  type AuthorizationGrant,
  type ConnectorManifest,
  isConnectorError,
  type MarketplaceConnector,
  type MarketplaceWarehouse,
  PermanentConnectorError,
  type ShopCredentials,
  type ShopProfile,
  type TokenSet,
} from "@omniseller/connector-core";
import { tiktokCatalog } from "./catalog.js";
import { TiktokShopClient, type TiktokShopConfig } from "./client.js";
import { tiktokFulfillment } from "./fulfillment.js";
import { TIKTOK_MAX_STOCK, tiktokInventory } from "./inventory.js";
import { tiktokOrders } from "./orders.js";
import { tiktokProducts } from "./products.js";
import { tiktokReturns } from "./returns.js";
import { parseTiktokWebhook, TIKTOK_WEBHOOK_TOPICS, verifyTiktokWebhook } from "./webhooks.js";

/**
 * In Indonesia TikTok Shop and Tokopedia run as one shop ("Tokopedia & Shop", ID market one-pager):
 * one seller authorization, one shop, one set of TikTok Shop APIs, and orders that carry the app they
 * came from. Indonesian regulation forbids "TikTok" branding in third-party interfaces for this market,
 * so sellers see the channel as "Tokopedia & Shop".
 */
export const TIKTOKSHOP_MANIFEST: ConnectorManifest = {
  id: "tiktokshop",
  displayName: "Tokopedia & Shop",
  shopRateLimit: { capacity: 10, refillPerSecond: 10 },
  // Access tokens last 7 days by default (Authorization overview).
  accessTokenLifetimeSeconds: 7 * 24 * 3600,
  supportedRegions: ["ID"],
  // Update Inventory: quantity at most 99,999 per warehouse.
  maxStockQuantity: TIKTOK_MAX_STOCK,
};

const SELLER_USER_TYPE = 0;

interface TokenData {
  access_token?: string;
  access_token_expire_in?: number;
  refresh_token?: string;
  refresh_token_expire_in?: number;
  open_id?: string;
  seller_name?: string;
  seller_base_region?: string;
  user_type?: number;
  granted_scopes?: string[];
}

interface AuthorizedShopsData {
  shops?: { id?: string; name?: string; region?: string; seller_type?: string; cipher?: string; code?: string }[];
}

interface WarehousesData {
  warehouses?: {
    id?: string;
    entity_id?: string;
    name?: string;
    effect_status?: string;
    type?: string;
    sub_type?: string;
    is_default?: boolean;
    address?: Record<string, unknown>;
  }[];
}

interface FbtRegionsData {
  onboarded_regions?: { region_code?: string }[];
}

interface FbtWarehousesData {
  warehouses?: {
    fbt_warehouse_id?: string;
    warehouse_ids?: string[];
    name?: string;
    type?: string;
    subscribed?: boolean;
    addresses?: Record<string, unknown>[];
  }[];
}

interface WebhooksData {
  webhooks?: { event_type?: string; address?: string }[];
}

function epoch(seconds: unknown): Date | null {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

function tokenSet(data: TokenData): TokenSet {
  const accessExpiresAt = epoch(data.access_token_expire_in);
  if (!data.access_token || !data.refresh_token || !accessExpiresAt) {
    throw new PermanentConnectorError({ code: "bad_response", message: "token response without tokens" });
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt,
    refreshExpiresAt: epoch(data.refresh_token_expire_in),
    scopes: data.granted_scopes ?? [],
  };
}

/** Address fields worth keeping for the warehouse mapping screen; contact names and phones are left out. */
function warehouseAddress(a: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!a) return null;
  const keep = [
    "region",
    "region_code",
    "state",
    "city",
    "distict",
    "district",
    "town",
    "postal_code",
    "full_address",
    "geolocation",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (a[k] !== undefined) out[k === "distict" ? "district" : k] = a[k];
  return out;
}

export function createTiktokShopConnector(config: TiktokShopConfig): MarketplaceConnector {
  const client = new TiktokShopClient(config);
  const region = TIKTOKSHOP_MANIFEST.supportedRegions[0]!;

  return {
    manifest: TIKTOKSHOP_MANIFEST,

    auth: {
      // The redirect URL is fixed in Partner Center; the seller comes back with ?code=...&state=...
      authorizeUrl({ state }) {
        if (!config.serviceId) {
          throw new PermanentConnectorError({ code: "not_configured", message: "TIKTOKSHOP_SERVICE_ID is not set" });
        }
        const url = new URL(config.authorizeUrl);
        url.searchParams.set("service_id", config.serviceId);
        url.searchParams.set("state", state);
        return url.toString();
      },

      // No revoke endpoint exists; sellers cancel under Seller Center > App Store > My apps.
      revokeUrl() {
        return null;
      },

      async exchangeCode({ code }): Promise<AuthorizationGrant> {
        const data = await client.token<TokenData>("/api/v2/token/get", {
          auth_code: code,
          grant_type: "authorized_code",
        });
        if (data.user_type !== undefined && data.user_type !== SELLER_USER_TYPE) {
          throw new PermanentConnectorError({
            code: "wrong_user_type",
            message: `authorization is for user_type ${data.user_type}, not a seller`,
          });
        }
        const tokens = tokenSet(data);
        const shops = await client.call<AuthorizedShopsData>({
          method: "GET",
          path: "/authorization/202309/shops",
          accessToken: tokens.accessToken,
        });
        return {
          tokens,
          shops: (shops.shops ?? [])
            .filter((s) => s.id)
            .map((s) => ({
              externalShopId: String(s.id),
              shopCipher: s.cipher ?? null,
              name: s.name ?? null,
              region: s.region?.toUpperCase() ?? null,
              info: { seller_type: s.seller_type ?? null, shop_code: s.code ?? null },
            })),
          principal: {
            open_id: data.open_id ?? null,
            seller_name: data.seller_name ?? null,
            seller_base_region: data.seller_base_region ?? null,
          },
        };
      },

      async refresh({ refreshToken }): Promise<TokenSet> {
        const data = await client.token<TokenData>("/api/v2/token/refresh", {
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        });
        return tokenSet(data);
      },
    },

    shops: {
      async describe(grant): Promise<ShopProfile[]> {
        return grant.shops.map((s) => ({
          externalShopId: s.externalShopId,
          shopCipher: s.shopCipher,
          name: s.name?.trim() || `Toko ${s.externalShopId}`,
          region: s.region ?? "",
          // The refresh token lives exactly as long as the seller's authorization.
          authorizationExpiresAt: grant.tokens.refreshExpiresAt,
          info: { ...s.info, ...grant.principal },
        }));
      },
    },

    warehouses: {
      async list(shop): Promise<MarketplaceWarehouse[]> {
        const sales = await client.call<WarehousesData>({
          method: "GET",
          path: "/logistics/202309/warehouses",
          accessToken: shop.accessToken,
          shopCipher: shop.shopCipher,
        });
        const out: MarketplaceWarehouse[] = (sales.warehouses ?? [])
          .filter((w) => w.id && (w.type ?? "SALES_WAREHOUSE") === "SALES_WAREHOUSE")
          .map((w) => ({
            externalId: String(w.id),
            name: w.name?.trim() || `Gudang ${w.id}`,
            kind: "seller" as const,
            isDefault: w.is_default === true,
            address: {
              ...warehouseAddress(w.address),
              effect_status: w.effect_status ?? null,
              sub_type: w.sub_type ?? null,
            },
          }));
        out.push(...(await fbtWarehouses(shop)));
        return out;
      },
    },

    catalog: tiktokCatalog(client),

    products: tiktokProducts(client),

    orders: tiktokOrders(client),

    fulfillment: tiktokFulfillment(client),

    returns: tiktokReturns(client),

    inventory: tiktokInventory(client),

    webhooks: {
      verify(req) {
        return verifyTiktokWebhook(client.appKey, client.appSecret, req);
      },
      parse: parseTiktokWebhook,
      async subscribe(shop, address): Promise<string[]> {
        const current = await client.call<WebhooksData>({
          method: "GET",
          path: "/event/202309/webhooks",
          accessToken: shop.accessToken,
          shopCipher: shop.shopCipher,
        });
        const have = new Set(
          (current.webhooks ?? []).filter((w) => w.address === address).map((w) => w.event_type ?? ""),
        );
        for (const topic of TIKTOK_WEBHOOK_TOPICS) {
          if (have.has(topic)) continue;
          await client.call<unknown>({
            method: "PUT",
            path: "/event/202309/webhooks",
            accessToken: shop.accessToken,
            shopCipher: shop.shopCipher,
            body: { address, event_type: topic },
          });
        }
        return [...TIKTOK_WEBHOOK_TOPICS];
      },
    },
  };

  /**
   * Fulfilled by TikTok: only for sellers onboarded in the shop's region. Apps without the FBT scope
   * get an access-denied answer, which means the same as "not onboarded" for connection purposes.
   */
  async function fbtWarehouses(shop: ShopCredentials): Promise<MarketplaceWarehouse[]> {
    try {
      const regions = await client.call<FbtRegionsData>({
        method: "GET",
        path: "/fbt/202409/merchants/onboarded_regions",
        accessToken: shop.accessToken,
        shopCipher: shop.shopCipher,
      });
      if (!(regions.onboarded_regions ?? []).some((r) => r.region_code?.toUpperCase() === region)) return [];
      const list = await client.call<FbtWarehousesData>({
        method: "GET",
        path: "/fbt/202408/warehouses",
        accessToken: shop.accessToken,
        shopCipher: shop.shopCipher,
      });
      return (list.warehouses ?? [])
        .filter((w) => w.subscribed && w.fbt_warehouse_id)
        .map((w) => ({
          externalId: String(w.fbt_warehouse_id),
          name: w.name?.trim() || "Fulfilled by Tokopedia & Shop",
          kind: "fulfillment" as const,
          isDefault: false,
          address: { ...warehouseAddress(w.addresses?.[0]), warehouse_ids: w.warehouse_ids ?? [] },
        }));
    } catch (err) {
      if (isConnectorError(err) && err.kind === "permanent") return [];
      throw err;
    }
  }
}
