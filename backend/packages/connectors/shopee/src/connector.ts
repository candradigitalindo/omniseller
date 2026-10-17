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
import { shopeeAccounts } from "./accounts.js";
import { shopeeAffiliate } from "./affiliate.js";
import { shopeeCatalog } from "./catalog.js";
import { accessExpiry, ShopeeClient, type ShopeeConfig } from "./client.js";
import { shopeeCommerce } from "./commerce.js";
import { numericId } from "./identifiers.js";
import { shopeeInventory } from "./inventory.js";
import { shopeeLogistics } from "./logistics.js";
import { shopeeOrders } from "./orders.js";
import { shopeeProducts } from "./products.js";
import { shopeeReturns } from "./returns.js";
import { parseShopeePush, verifyShopeePush } from "./webhooks.js";

export const SHOPEE_MANIFEST: ConnectorManifest = {
  id: "shopee",
  displayName: "Shopee",
  // Shopee publishes no per-shop number for these endpoints; 10 calls per second per shop stays well
  // inside the partner-level limits and is revisited with catalog and order sync.
  shopRateLimit: { capacity: 10, refillPerSecond: 10 },
  accessTokenLifetimeSeconds: 4 * 3600,
  supportedRegions: ["ID"],
  // update_stock documents no upper bound.
  maxStockQuantity: null,
};

/** refresh_token lifetime from the authorization guide; each one is single use. */
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 3600 * 1000;

/** `shop_fulfillment_flag` values whose shop holds stock in a Shopee warehouse (Dikelola Shopee / FBS). */
const FBS_FLAGS = new Set(["Pure - FBS Shop", "PFF - FBS Shop", "LFF Hybrid Shop"]);
/** Stock lives only in Shopee's warehouse: no seller warehouse to map. */
const FBS_ONLY_FLAG = "Pure - FBS Shop";

export const SHOPEE_FBS_WAREHOUSE_ID = "shopee_fbs";
/** Shops outside the multi-warehouse programme have one shop-level stock. */
export const SHOPEE_DEFAULT_WAREHOUSE_ID = "default";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expire_in?: number;
  shop_id_list?: (number | string)[];
  merchant_id_list?: (number | string)[];
  shop_id?: number | string;
}

interface ShopInfoResponse {
  shop_name?: string;
  region?: string;
  status?: string;
  expire_time?: number;
  auth_time?: number;
  is_cb?: boolean;
  is_sip?: boolean;
  is_main_shop?: boolean;
  merchant_id?: number | string | null;
  shop_fulfillment_flag?: string;
}

interface ProfileResponse {
  response?: { shop_logo?: string; shop_name?: string };
}

interface WarehouseDetailResponse {
  response?: {
    warehouse_id?: number | string;
    warehouse_name?: string;
    warehouse_type?: number;
    location_id?: string;
    address_id?: number | string;
    region?: string;
    state?: string;
    city?: string;
    district?: string;
    town?: string;
    address?: string;
    zipcode?: string;
    holiday_mode_state?: number;
  }[];
}

interface AddressListResponse {
  response?: {
    address_list?: {
      address_id?: number | string;
      region?: string;
      state?: string;
      city?: string;
      district?: string;
      town?: string;
      address?: string;
      zipcode?: string;
      address_type?: string[];
    }[];
  };
}

function tokenSet(res: TokenResponse): TokenSet {
  if (!res.access_token || !res.refresh_token) {
    throw new PermanentConnectorError({ code: "bad_response", message: "token response without tokens" });
  }
  const now = new Date();
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    accessExpiresAt: accessExpiry(res.expire_in, now),
    refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
    scopes: [],
  };
}

function epoch(seconds: unknown): Date | null {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

export function createShopeeConnector(config: ShopeeConfig): MarketplaceConnector {
  const client = new ShopeeClient(config);

  async function shopInfo(shop: { externalShopId: string; accessToken: string }): Promise<ShopInfoResponse> {
    return client.shopCall<ShopInfoResponse>(shop, "GET", "/api/v2/shop/get_shop_info");
  }

  async function defaultAddress(shop: ShopCredentials): Promise<Record<string, unknown> | null> {
    const res = await client.shopCall<AddressListResponse>(shop, "GET", "/api/v2/logistics/get_address_list");
    const list = res.response?.address_list ?? [];
    const pick =
      list.find((a) => a.address_type?.includes("PICK_UP_ADDRESS")) ??
      list.find((a) => a.address_type?.includes("DEFAULT_ADDRESS")) ??
      list[0];
    if (!pick) return null;
    const { address_type: _types, ...rest } = pick;
    return { ...rest };
  }

  return {
    manifest: SHOPEE_MANIFEST,

    affiliate: shopeeAffiliate(client),
    commerce: shopeeCommerce(client),
    accounts: shopeeAccounts(client),

    auth: {
      // New-style link (no signature): open.shopee.com/auth with state echoed back to redirect_uri,
      // together with `code` and either `shop_id` or `main_account_id`.
      authorizeUrl({ state, redirectUri }) {
        const url = new URL("/auth", config.authBaseUrl);
        url.searchParams.set("partner_id", String(config.partnerId));
        url.searchParams.set("auth_type", "seller");
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("state", state);
        return url.toString();
      },

      revokeUrl({ redirectUri }) {
        const url = new URL("/cancel_auth", config.authBaseUrl);
        url.searchParams.set("partner_id", String(config.partnerId));
        url.searchParams.set("auth_type", "seller");
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("response_type", "code");
        return url.toString();
      },

      async exchangeCode({ code, shopId, mainAccountId }): Promise<AuthorizationGrant> {
        if (!shopId && !mainAccountId) {
          throw new PermanentConnectorError({
            code: "missing_shop",
            message: "shop_id or main_account_id is required",
          });
        }
        const body: Record<string, unknown> = { code, partner_id: config.partnerId };
        if (shopId) body.shop_id = numericId(shopId);
        else body.main_account_id = numericId(mainAccountId!);
        const res = await client.publicCall<TokenResponse>("POST", "/api/v2/auth/token/get", { body });
        const shopIds = shopId ? [shopId] : (res.shop_id_list ?? []).map(String);
        return {
          tokens: tokenSet(res),
          shops: shopIds.map((id) => ({ externalShopId: id, shopCipher: null, name: null, region: null })),
          principal: {
            main_account_id: mainAccountId ?? null,
            merchant_ids: res.merchant_id_list?.length ? res.merchant_id_list.join(",") : null,
          },
        };
      },

      // Each refresh_token works once. The new one must replace it before anything else can fail, which
      // the backend guarantees by refreshing under a row lock (backend doc 8.6).
      async refresh({ refreshToken, externalShopId }): Promise<TokenSet> {
        const res = await client.publicCall<TokenResponse>("POST", "/api/v2/auth/access_token/get", {
          body: { refresh_token: refreshToken, partner_id: config.partnerId, shop_id: numericId(externalShopId) },
        });
        return tokenSet(res);
      },
    },

    shops: {
      async describe(grant): Promise<ShopProfile[]> {
        const out: ShopProfile[] = [];
        for (const shop of grant.shops) {
          const creds = { externalShopId: shop.externalShopId, accessToken: grant.tokens.accessToken };
          const info = await shopInfo(creds);
          let logo: string | undefined;
          try {
            logo = (await client.shopCall<ProfileResponse>(creds, "GET", "/api/v2/shop/get_profile")).response
              ?.shop_logo;
          } catch (err) {
            // The logo is cosmetic; anything but a transport failure is not worth failing the connection for.
            if (!isConnectorError(err) || err.kind === "transient") throw err;
          }
          out.push({
            externalShopId: shop.externalShopId,
            shopCipher: null,
            name: info.shop_name?.trim() || `Shopee ${shop.externalShopId}`,
            region: (info.region ?? "").toUpperCase(),
            authorizationExpiresAt: epoch(info.expire_time),
            info: {
              status: info.status ?? null,
              is_cb: typeof info.is_cb === "boolean" ? info.is_cb : null,
              is_sip: info.is_sip ?? false,
              merchant_id: info.merchant_id ?? null,
              fulfillment_flag: info.shop_fulfillment_flag ?? null,
              authorized_at: epoch(info.auth_time)?.toISOString() ?? null,
              logo: logo ?? null,
              ...grant.principal,
            },
          });
        }
        return out;
      },
    },

    warehouses: {
      /**
       * Multi-warehouse shops list their pickup warehouses with v2.shop.get_warehouse_detail; stock is
       * kept per `location_id`, so that is the external id (addresses sharing a location share stock).
       * Shops outside the programme get one shop-level warehouse. Shops with Shopee-held stock (FBS)
       * also get a marketplace-managed warehouse that OmniSeller never pushes to.
       */
      async list(shop): Promise<MarketplaceWarehouse[]> {
        const info = await shopInfo(shop);
        const flag = info.shop_fulfillment_flag ?? "";
        const out: MarketplaceWarehouse[] = [];

        if (flag !== FBS_ONLY_FLAG) {
          let rows: NonNullable<WarehouseDetailResponse["response"]> = [];
          try {
            const res = await client.shopCall<WarehouseDetailResponse>(
              shop,
              "GET",
              "/api/v2/shop/get_warehouse_detail",
              {
                query: { warehouse_type: "1" },
              },
            );
            rows = res.response ?? [];
          } catch (err) {
            const notMulti =
              isConnectorError(err) &&
              (err.code === "warehouse.error_not_in_whitelist" ||
                err.code === "warehouse.error_can_not_find_warehouse");
            if (!notMulti) throw err;
          }
          const byLocation = new Map<string, MarketplaceWarehouse>();
          for (const w of rows) {
            if (w.warehouse_type !== undefined && w.warehouse_type !== 1) continue;
            const id = w.location_id || (w.warehouse_id !== undefined ? String(w.warehouse_id) : "");
            if (!id) continue;
            const existing = byLocation.get(id);
            const name = w.warehouse_name?.trim() || `Gudang ${id}`;
            if (existing) {
              existing.name = `${existing.name} / ${name}`;
              continue;
            }
            byLocation.set(id, {
              externalId: id,
              name,
              kind: "seller",
              isDefault: false,
              address: {
                warehouse_id: w.warehouse_id ?? null,
                address_id: w.address_id ?? null,
                region: w.region ?? null,
                state: w.state ?? null,
                city: w.city ?? null,
                district: w.district ?? null,
                town: w.town ?? null,
                address: w.address ?? null,
                zipcode: w.zipcode ?? null,
                holiday_mode: (w.holiday_mode_state ?? 0) !== 0,
              },
            });
          }
          if (byLocation.size > 0) {
            out.push(...byLocation.values());
          } else {
            out.push({
              externalId: SHOPEE_DEFAULT_WAREHOUSE_ID,
              name: "Gudang toko",
              kind: "seller",
              isDefault: true,
              address: await defaultAddress(shop),
            });
          }
        }

        if (FBS_FLAGS.has(flag)) {
          out.push({
            externalId: SHOPEE_FBS_WAREHOUSE_ID,
            name: "Dikelola Shopee",
            kind: "fulfillment",
            isDefault: false,
            address: null,
          });
        }
        return out;
      },
    },

    catalog: shopeeCatalog(client, { fbs: SHOPEE_FBS_WAREHOUSE_ID, shopLevel: SHOPEE_DEFAULT_WAREHOUSE_ID }),

    products: shopeeProducts(client, { shopLevel: SHOPEE_DEFAULT_WAREHOUSE_ID }),

    orders: shopeeOrders(client),

    fulfillment: shopeeLogistics(client),

    returns: shopeeReturns(client),

    inventory: shopeeInventory(client, SHOPEE_DEFAULT_WAREHOUSE_ID),

    webhooks: {
      verify(req) {
        return verifyShopeePush(client.partnerKey, req);
      },
      parse: parseShopeePush,
      // Shopee push is configured once per app (console or v2.push.set_app_push_config), not per shop.
    },
  };
}
