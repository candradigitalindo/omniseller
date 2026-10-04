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

export type ListingStatus = "active" | "inactive" | "banned" | "reviewing" | "deleted" | "unknown";

/**
 * One sellable variant of a marketplace item (Shopee model, TikTok Shop SKU); items without variants
 * have one listing with `externalVariantId = ""`. Prices are whole rupiah.
 */
export interface NormalizedListing {
  externalItemId: string;
  externalVariantId: string;
  /** Variant SKU set by the seller (Shopee model_sku, or item_sku without models; TikTok Shop seller_sku). */
  sku: string | null;
  /** Parent SKU of the item, when the marketplace has one (Shopee item_sku). */
  itemSku: string | null;
  title: string;
  /** "Hitam, L" */
  variantName: string | null;
  /** { Warna: "Hitam", Ukuran: "L" } */
  attributes: Record<string, string>;
  price: number | null;
  originalPrice: number | null;
  status: ListingStatus;
  /** Marketplace-native statuses, e.g. per platform for Tokopedia & Shop. */
  statusDetail: Record<string, unknown>;
  /** Total sellable stock at the marketplace. */
  stock: number | null;
  /** Stock per marketplace warehouse id (Shopee location_id, TikTok Shop warehouse id). */
  stockByWarehouse: Record<string, number>;
  imageUrl: string | null;
  /** All image URLs of the item, main first. */
  itemImageUrls: string[];
  description: string | null;
  brand: string | null;
  categoryPath: string | null;
  weightG: number | null;
  dimensionsMm: { length: number; width: number; height: number } | null;
  updatedAt: Date | null;
}

export interface ListingPage {
  listings: NormalizedListing[];
  /** Items the marketplace reports as deleted; their listings are closed without fetching details. */
  deletedItemIds: string[];
  /** Opaque, pass back to get the next page; null on the last page. */
  nextCursor: string | null;
  itemCount: number;
}

export interface ListingStatusResult {
  externalItemId: string;
  ok: boolean;
  error?: string;
}

/**
 * Absolute stock for one listing (technology doc 8.1, backend doc 9.4). `warehouses` lists every seller
 * stock location of the listing, as the listing reports them: the marketplace may require all of them in
 * one request (TikTok Shop does), so the backend never sends a subset.
 */
export interface StockUpdate {
  externalItemId: string;
  externalVariantId: string;
  warehouses: { externalWarehouseId: string; quantity: number }[];
}

export interface StockUpdateResult {
  externalItemId: string;
  externalVariantId: string;
  ok: boolean;
  /** The marketplace's reason when not ok. */
  error?: string;
  /** True when trying again later may succeed (marketplace busy, rate limit); false for refusals. */
  retryable?: boolean;
}

/**
 * Where an order stands at the marketplace, as facts the backend maps to its own statuses (backend doc
 * 7.9). Seller-side progress (shipment arranged, waiting for pickup) is `seller_processing`; it only
 * updates the marketplace status shown next to the internal one.
 */
export type OrderState =
  | "unpaid"
  | "to_ship"
  | "seller_processing"
  | "shipped"
  | "delivered"
  | "completed"
  | "cancelled"
  | "returning";

export type ShippingServiceType = "regular" | "next_day" | "same_day" | "instant";

/** One sellable line of an order: a listing (item and variant) with its quantity. */
export interface NormalizedOrderItem {
  /** Stable id of the line within the order (Shopee item:model:promotion group, TikTok Shop sku_id). */
  externalLineId: string;
  /** Listing item and variant, as in NormalizedListing ("" variant for items without variants). */
  externalItemId: string;
  externalVariantId: string;
  sku: string | null;
  title: string;
  variantName: string | null;
  imageUrl: string | null;
  /** Units ordered. */
  quantity: number;
  /** Units of `quantity` cancelled since (partial cancellation); the rest is still to be fulfilled. */
  cancelledQuantity: number;
  /** Price per unit after discounts, whole rupiah. */
  unitPrice: number;
  /** Price per unit before discounts, when the marketplace gives it. */
  originalUnitPrice: number | null;
  /** Discount on the whole line. */
  discount: number;
  lineTotal: number;
  /** Seller warehouse the line ships from, when the marketplace says (multi-warehouse shops). */
  externalWarehouseId: string | null;
}

/**
 * Where a marketplace package stands (backend doc 8.15). An order ships as one or more packages.
 * - waiting: not ready to ship (unpaid, COD screening, held by the marketplace)
 * - ready: the seller can arrange the shipment now
 * - arranged: pickup or drop-off is arranged; the label can be printed
 * - shipped: the courier has the parcel
 * - delivered
 * - cancelled: it will not ship (order cancelled, shipment cancelled)
 * - failed: pickup or delivery failed, or the parcel was lost
 */
export type PackageState = "waiting" | "ready" | "arranged" | "shipped" | "delivered" | "cancelled" | "failed";

export interface NormalizedPackage {
  /** Shopee package_number, TikTok Shop package id; "" for a Shopee order without a package number. */
  externalPackageId: string;
  state: PackageState;
  /** Marketplace package status, as received. */
  externalStatus: string;
  trackingNumber: string | null;
  shippingProvider: string | null;
  /** Order lines in the package (NormalizedOrderItem.externalLineId) and their units. */
  items: { externalLineId: string; quantity: number }[];
}

export type HandoverMethod = "pickup" | "dropoff";

export interface ArrangedPackage {
  externalPackageId: string;
  ok: boolean;
  /** Arranged before this call (in Seller Center or by an earlier attempt); counts as arranged. */
  alreadyArranged?: boolean;
  /** Start of the pickup slot the marketplace booked, when it gives one. */
  pickupAt?: Date | null;
  code?: string;
  message?: string;
}

export interface ArrangeResult {
  externalOrderId: string;
  packages: ArrangedPackage[];
  /** Nothing of the order could be arranged (not found, nothing ready); packages is empty then. */
  error?: { code: string; message: string };
}

export interface PackageRef {
  externalOrderId: string;
  /** "" for a Shopee order without a package number. */
  externalPackageId: string;
}

export type LabelResult =
  | { ref: PackageRef; state: "ready"; pdf: Uint8Array; trackingNumber: string | null }
  | { ref: PackageRef; state: "pending"; trackingNumber: string | null; message: string }
  | { ref: PackageRef; state: "failed"; code: string; message: string };

/**
 * How far a parcel has come, from the marketplace's tracking (backend doc 8.22, PRD FR-SHP-07):
 * - waiting_pickup: arranged and labelled, the courier does not have it yet
 * - in_transit: the courier has it, between its facilities
 * - out_for_delivery: on the way to the buyer, or waiting at a pickup point
 * - delivered
 * - failed: a pickup or delivery attempt failed, or the parcel is late; it may still arrive
 * - returning: on its way back to the seller
 * - returned: back with the seller
 * - lost: lost, damaged, or disposed of by the courier
 * - cancelled: the shipment was cancelled
 */
export type TrackingStage =
  | "waiting_pickup"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "failed"
  | "returning"
  | "returned"
  | "lost"
  | "cancelled";

export interface TrackingEvent {
  at: Date;
  /**
   * As the marketplace or courier wrote it. It may name who received the parcel: personal data, never
   * logged.
   */
  description: string;
  /** Marketplace code of the event: Shopee tracking logistics status, TikTok Shop action code. */
  code: string | null;
  /** Null for a code OmniSeller does not know. */
  stage: TrackingStage | null;
  /** Shopee ID, SPX Instant and Sameday: the OTP the seller gives the driver of a returned parcel. */
  returnCode?: string;
}

export interface ParcelTracking {
  /** Shopee package_number; "" for an order without one and for TikTok Shop (tracked per order). */
  externalPackageId: string;
  /** The newest event's known stage, else the marketplace's own logistics status; null if neither. */
  stage: TrackingStage | null;
  /** Newest first. */
  events: TrackingEvent[];
}

export type TrackingResult =
  | { externalOrderId: string; parcels: ParcelTracking[] }
  | { externalOrderId: string; error: { code: string; message: string } };

/** The stage of a parcel: its newest event with a known stage, else `fallback`. */
export function trackingStageOf(
  events: readonly TrackingEvent[],
  fallback: TrackingStage | null,
): TrackingStage | null {
  const newest = [...events].sort((a, b) => b.at.getTime() - a.at.getTime()).find((e) => e.stage !== null);
  return newest?.stage ?? fallback;
}

export interface NormalizedRecipient {
  name: string | null;
  phone: string | null;
  fullAddress: string | null;
  district: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
}

export interface NormalizedOrder {
  externalOrderId: string;
  state: OrderState;
  /** Marketplace status as received, shown to the seller next to the internal one. */
  externalStatus: string;
  /** Where the buyer ordered when one shop sells on several platforms (TikTok Shop or Tokopedia). */
  platform: string | null;
  /** `marketplace`: fulfilled from a marketplace warehouse (Dikelola Shopee, FBT, Dilayani Tokopedia). */
  fulfillment: "seller" | "marketplace";
  /** The buyer asked to cancel and the seller has to respond. */
  cancelRequested: boolean;
  isCod: boolean;
  createdAt: Date;
  /** Marketplace update time; a snapshot older than the stored one is ignored. */
  updatedAt: Date;
  paidAt: Date | null;
  /** Ship-by deadline set by the marketplace. */
  shipByAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: "buyer" | "seller" | "marketplace" | "system" | null;
  cancelReason: string | null;
  buyerId: string | null;
  buyerUsername: string | null;
  /** False where the marketplace hides the address in this status (TikTok Shop UNPAID and ON_HOLD). */
  recipientAvailable: boolean;
  recipient: NormalizedRecipient | null;
  buyerNote: string | null;
  shippingProvider: string | null;
  shippingService: string | null;
  shippingServiceType: ShippingServiceType | null;
  trackingNumber: string | null;
  /** Order-level seller warehouse (TikTok Shop warehouse_id); lines may carry their own. */
  externalWarehouseId: string | null;
  currency: string;
  subtotal: number;
  discountTotal: number;
  shippingFeeBuyer: number;
  total: number;
  items: NormalizedOrderItem[];
  /** How the order ships; empty when the marketplace does not say. */
  packages: NormalizedPackage[];
}

export interface OrderPage {
  orders: NormalizedOrder[];
  /** Opaque, pass back to get the next page; null when the time range is exhausted. */
  nextCursor: string | null;
}

export interface CancelReason {
  /** Marketplace reason code sent to the cancel API. */
  code: string;
  label: string;
  /** The reason cancels per item (out of stock) and needs the items. */
  needsItems: boolean;
}

export type WebhookEventKind =
  | "authorization.granted"
  | "authorization.revoked"
  | "authorization.expiring"
  | "order.status_changed"
  | "order.tracking_updated"
  | "shipment.document_ready"
  | "listing.changed"
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
    /** Several orders at once (TikTok Shop package updates: combined or split packages). */
    externalOrderIds?: string[];
    externalPackageId?: string;
    externalItemId?: string;
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
  /** Largest stock quantity the marketplace accepts per warehouse; larger values are sent as this. */
  maxStockQuantity: number | null;
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

  catalog: {
    /**
     * One page of listings. `updatedSince` limits the page to items changed since then (incremental
     * pull); without it every item is returned (full pull, which also reveals deletions).
     */
    listListings(
      shop: ShopCredentials,
      input: { cursor?: string | null; updatedSince?: Date | null },
    ): Promise<ListingPage>;
    /** Current listings of specific items (after a webhook or a status change). */
    getListings(shop: ShopCredentials, externalItemIds: string[]): Promise<ListingPage>;
    /** Activates or deactivates whole items; per-item results, partial success is normal. */
    setListingStatus(shop: ShopCredentials, externalItemIds: string[], active: boolean): Promise<ListingStatusResult[]>;
  };

  orders: {
    /**
     * One page of orders created (`by: "create_time"`) or updated (`by: "update_time"`) in [from, to).
     * The connector splits ranges longer than the marketplace allows; the cursor carries its position.
     */
    listOrders(
      shop: ShopCredentials,
      input: { by: "create_time" | "update_time"; from: Date; to: Date; cursor?: string | null },
    ): Promise<OrderPage>;
    /** Current state of specific orders (after a webhook or a seller action). Unknown ids are left out. */
    getOrders(shop: ShopCredentials, externalOrderIds: string[]): Promise<NormalizedOrder[]>;
    /** Reasons a seller may give to cancel an order in this marketplace status (Indonesian market). */
    cancelReasons(externalStatus: string): CancelReason[];
    /** Seller cancellation. `items` (listing item and variant) for reasons that need them. */
    cancelOrder(
      shop: ShopCredentials,
      input: {
        externalOrderId: string;
        externalStatus: string;
        reason: string;
        items?: { externalItemId: string; externalVariantId: string; quantity: number }[];
      },
    ): Promise<void>;
  };

  fulfillment: {
    /**
     * Arranges the shipment of the orders' packages that are ready (FR-SHP-06): pickup, at the pickup
     * address of the package's warehouse and the slot the marketplace recommends (else the earliest),
     * or drop-off at a courier point. Results per order and package; partial success is normal.
     * Packages arranged earlier (in Seller Center) count as arranged.
     */
    arrange(
      shop: ShopCredentials,
      input: { externalOrderIds: string[]; method: HandoverMethod },
    ): Promise<ArrangeResult[]>;
    /**
     * Shipping labels of arranged packages as PDF, one result per package: ready with the file,
     * pending while the courier assigns the tracking number or the marketplace renders the label, or
     * failed. Labels carry buyer data: callers store them privately and never log them.
     */
    labels(shop: ShopCredentials, refs: PackageRef[]): Promise<LabelResult[]>;
    /**
     * Where the orders' parcels are (FR-SHP-07): per order, its parcels with their events, or why the
     * marketplace refused to say. Packages are tracked one by one when given (Shopee split orders);
     * without them the connector finds them. A refusal for one order does not cost the others their
     * tracking. A temporary failure (busy, rate limit, network) ends the run: the orders read so far are
     * returned and the rest are left out, or the error is thrown when none was read. Authorization
     * failures always throw.
     */
    tracking(
      shop: ShopCredentials,
      orders: { externalOrderId: string; externalPackageIds: string[] }[],
    ): Promise<TrackingResult[]>;
  };

  inventory: {
    /**
     * Sets absolute seller stock. The connector groups updates per marketplace item as the API needs;
     * results come back per listing, and partial success is normal. Authorization failures throw.
     */
    updateStock(shop: ShopCredentials, updates: StockUpdate[]): Promise<StockUpdateResult[]>;
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
