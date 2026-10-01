/**
 * Normalized types shared by every marketplace connector (technology doc 8.1, 26.4). Core logic in the
 * backend only ever sees these shapes; marketplace field names stay inside each connector package.
 */

export type ChannelId = "shopee" | "tiktokshop";

/** Tokens as issued by a marketplace. Times are absolute; connectors convert "expires in" values. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date;
  /** For TikTok Shop this is also the end of the seller's authorization. */
  refreshExpiresAt: Date | null;
  scopes: string[];
}

/** One shop the seller granted in an authorization, as far as the token exchange reveals it. */
export interface GrantedShop {
  externalShopId: string;
  /** TikTok Shop `shop_cipher`: an opaque shop identifier required by shop-scoped endpoints. */
  shopCipher: string | null;
  name: string | null;
  region: string | null;
  /** Non-secret shop metadata the exchange already returned (seller type, shop code). */
  info?: Record<string, unknown>;
}

/** Result of exchanging an authorization code. */
export interface AuthorizationGrant {
  tokens: TokenSet;
  shops: GrantedShop[];
  /** Non-secret identifiers of who authorized (open_id, seller name, main account id), for support. */
  principal: Record<string, string | number | null>;
}

/** Everything needed to call a shop-scoped endpoint. */
export interface ShopCredentials {
  externalShopId: string;
  shopCipher: string | null;
  accessToken: string;
}

/** Shop details used to create or update the `store` row. */
export interface ShopProfile {
  externalShopId: string;
  shopCipher: string | null;
  name: string;
  /** ISO 3166-1 alpha-2, upper case (`ID`). */
  region: string;
  /** When the seller's authorization for this app ends (Shopee up to 365 days, TikTok Shop per grant). */
  authorizationExpiresAt: Date | null;
  /** Non-secret marketplace metadata kept on the store for display and support. */
  info: Record<string, unknown>;
}

export type WarehouseKind = "seller" | "fulfillment";

export interface MarketplaceWarehouse {
  /** Stable id used for stock and orders (Shopee `location_id`, TikTok Shop warehouse `id`). */
  externalId: string;
  name: string;
  kind: WarehouseKind;
  isDefault: boolean;
  address: Record<string, unknown> | null;
}

export type WebhookEventKind =
  | "authorization.granted"
  | "authorization.revoked"
  | "authorization.expiring"
  | "order.status_changed"
  | "order.tracking_updated"
  | "other";

export interface NormalizedWebhookEvent {
  /** Unique per delivery source: the marketplace notification id, or a hash of the raw body. */
  eventId: string;
  kind: WebhookEventKind;
  /** Marketplace-native event code or topic, kept for logs and later consumers. */
  code: string;
  /** Shops the event concerns; empty for partner-level notices. */
  externalShopIds: string[];
  occurredAt: Date;
  /** Kind-specific data, already normalized (e.g. `expiresAt` for authorization.expiring). */
  data: {
    expiresAt?: Date;
    reason?: string;
    externalOrderId?: string;
    status?: string;
  };
}

export interface WebhookRequest {
  /** The exact public URL the marketplace posted to (Shopee signs it). */
  url: string;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  rawBody: Buffer;
}

export interface RateLimitRule {
  capacity: number;
  refillPerSecond: number;
}

export interface ConnectorManifest {
  id: ChannelId;
  /** Name shown to Indonesian sellers (TikTok Shop appears as "Tokopedia & Shop", see its package). */
  displayName: string;
  /** Per-shop call budget, enforced by the backend with a Redis token bucket. */
  shopRateLimit: RateLimitRule;
  /** Typical access-token lifetime; the backend refreshes at 80% of the actual lifetime. */
  accessTokenLifetimeSeconds: number;
  /** Regions OmniSeller connects; shops outside are skipped with a reason. */
  supportedRegions: readonly string[];
}

export interface MarketplaceConnector {
  readonly manifest: ConnectorManifest;

  auth: {
    /** Link the seller opens to authorize OmniSeller. `redirectUri` is ignored where it is configured in the console. */
    authorizeUrl(input: { state: string; redirectUri: string }): string;
    /** Where a seller revokes the authorization on the marketplace side, when the marketplace offers a link. */
    revokeUrl(input: { redirectUri: string }): string | null;
    exchangeCode(input: { code: string; shopId?: string; mainAccountId?: string }): Promise<AuthorizationGrant>;
    refresh(input: { refreshToken: string; externalShopId: string }): Promise<TokenSet>;
  };

  shops: {
    /** Full profile for each granted shop, called right after the exchange with the new access token. */
    describe(grant: AuthorizationGrant): Promise<ShopProfile[]>;
  };

  warehouses: {
    list(shop: ShopCredentials): Promise<MarketplaceWarehouse[]>;
  };

  webhooks: {
    verify(req: WebhookRequest): boolean;
    parse(rawBody: Buffer): NormalizedWebhookEvent[];
    /**
     * Registers the callback for a shop where the marketplace subscribes per shop (TikTok Shop).
     * Undefined where subscriptions are app-level and configured once in the console (Shopee).
     */
    subscribe?(shop: ShopCredentials, address: string): Promise<string[]>;
  };
}
