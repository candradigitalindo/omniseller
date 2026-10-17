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

export interface ListingPriceUpdate {
  externalItemId: string;
  externalVariantId: string;
  /** Absolute regular price in whole rupiah; promotion prices are not overwritten. */
  price: number;
}

export interface ListingPriceResult extends ListingPriceUpdate {
  ok: boolean;
  errorCode?: string;
}

// ---- products: copying listings between shops (PRD FR-PRD-13, backend doc 8.25) ----

/** A category of the marketplace's tree as the shop sees it. */
export interface MarketplaceCategory {
  externalId: string;
  /** null for a top-level category. */
  parentExternalId: string | null;
  name: string;
  /** Products are created only in leaf categories. */
  isLeaf: boolean;
  /** The shop may list in it (TikTok Shop `AVAILABLE`; Shopee returns only usable categories). */
  permitted: boolean;
}

/**
 * How values of a product attribute are entered: picked from the list, typed, or either (Shopee combo
 * boxes, TikTok Shop customizable attributes).
 */
export type AttributeInput = "select" | "multi_select" | "text" | "select_or_text" | "multi_select_or_text";

export interface CategoryAttribute {
  externalId: string;
  name: string;
  required: boolean;
  input: AttributeInput;
  /** Values the marketplace offers; empty for free text. */
  values: { externalId: string; name: string }[];
  /** Units for quantitative values (Shopee `g`, `ml`); empty when the value has none. */
  units: string[];
  /** Typed values must be dates (Unix seconds), whole numbers, or decimals; null: any text. */
  valueFormat: "date" | "integer" | "decimal" | null;
  /** At most this many values; null: no stated limit. */
  maxValues: number | null;
  /** Required when another attribute has one of these values (TikTok Shop requirement conditions). */
  requiredWhen: { attributeId: string; valueId: string }[];
}

/** What a leaf category asks of a new product. */
export interface CategoryRules {
  categoryId: string;
  attributes: CategoryAttribute[];
  brandRequired: boolean;
  weightRequired: boolean;
  dimensionsRequired: boolean;
  sizeChart: { supported: boolean; required: boolean };
  /** Certifications the category always requires: not copied, sellers add them in the Seller Center. */
  certifications: string[];
  /** Days to ship for ready stock (Shopee); null when the marketplace decides. */
  daysToShip: number | null;
  limits: ProductLimits;
}

export interface ProductLimits {
  titleMin: number;
  titleMax: number;
  descriptionMin: number;
  descriptionMax: number;
  imagesMin: number;
  imagesMax: number;
  /** Whole rupiah; null when the marketplace states no limit. */
  priceMin: number | null;
  priceMax: number | null;
  variantsMax: number;
  variationsMax: number;
  variationNameMax: number;
  optionNameMax: number;
  skuMax: number;
  /** TikTok Shop seller SKUs may not contain spaces. */
  skuNoSpaces: boolean;
}

export interface MarketplaceBrand {
  externalId: string;
  name: string;
  /** May be chosen for a new product (TikTok Shop refuses unauthorized T1 brands). */
  selectable: boolean;
}

export interface ProductAttributeValue {
  attributeId: string;
  /** Source attribute name, for matching across marketplaces; null when unknown. */
  name: string | null;
  values: { externalId: string | null; name: string | null; unit?: string | null }[];
}

/** A marketplace product with everything a copy needs (FR-PRD-13). */
export interface SourceProduct {
  externalItemId: string;
  title: string;
  /** Plain text; paragraphs separated by line breaks. */
  description: string;
  /** The description as the marketplace keeps it, when that is HTML (TikTok Shop); null otherwise. */
  descriptionHtml: string | null;
  category: { externalId: string; name: string | null; path: string | null };
  brand: { externalId: string | null; name: string | null } | null;
  attributes: ProductAttributeValue[];
  /** Gallery images, main first. */
  images: string[];
  weightG: number | null;
  dimensionsMm: { length: number; width: number; height: number } | null;
  condition: "new" | "used";
  /** Pre-order days to ship; null for ready stock. */
  preOrderDays: number | null;
  sizeChartImageUrl: string | null;
  itemSku: string | null;
  /** Variation names in order ("Warna", "Ukuran"); empty for a product without variants. */
  variationNames: string[];
  variants: {
    externalVariantId: string;
    sku: string | null;
    /** One option per variation name, in the same order. */
    options: string[];
    price: number | null;
    stock: number | null;
    imageUrl: string | null;
    gtin: string | null;
  }[];
  /** Marketplace-specific settings kept for a copy to the same marketplace (Shopee logistics). */
  extras: Record<string, unknown>;
}

/** A product to create; images are already on the target marketplace (`uploadImage`). */
export interface ProductToCreate {
  /** Same key for retries of one product: the marketplace creates it once (TikTok Shop). */
  idempotencyKey: string;
  title: string;
  description: string;
  /** Used as is where the marketplace takes HTML (TikTok Shop); otherwise `description` is used. */
  descriptionHtml: string | null;
  categoryId: string;
  /** No id: the brand is looked up by name, or left out when the marketplace allows it. */
  brand: { externalId: string | null; name: string | null } | null;
  attributes: ProductAttributeValue[];
  /** Uploaded image references, main first. */
  images: string[];
  weightG: number;
  dimensionsMm: { length: number; width: number; height: number } | null;
  condition: "new" | "used";
  preOrderDays: number | null;
  itemSku: string | null;
  sizeChartImage: string | null;
  variationNames: string[];
  variants: {
    /** Caller's key, returned with the variant's new id. */
    key: string;
    sku: string | null;
    options: string[];
    price: number;
    stock: number;
    /** Uploaded image of the variant's first option; null when there is none. */
    image: string | null;
    gtin: string | null;
  }[];
  /** Marketplace warehouse that holds the stock (TikTok Shop warehouse id, Shopee location id). */
  warehouseId: string | null;
  extras: Record<string, unknown>;
}

export interface CreatedProduct {
  externalItemId: string;
  variants: { key: string; externalVariantId: string }[];
  /** The marketplace's warnings (a brand it cleared, for example). */
  warnings: string[];
}

export type ImageUse = "main" | "variant" | "description" | "size_chart";

export interface CreateHooks {
  itemCreated?(externalItemId: string): Promise<void>;
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

/**
 * What a buyer's after-sales request asks for (backend doc 8.26): the money back after sending the
 * items back, the money back without sending anything, another unit, another variant, or the order
 * cancelled before it ships.
 */
export type ReturnKind = "return_refund" | "refund_only" | "replacement" | "exchange" | "cancellation";

/**
 * Where a buyer's request stands at the marketplace (backend doc 8.26):
 * - requested: waiting for the seller's decision, until `respondBy`
 * - negotiating: the seller offered another solution (a partial refund); the buyer decides
 * - accepted: agreed; for a return the buyer is to send the items back
 * - in_transit: the buyer sent the items back
 * - rejected: the seller said no; the buyer may still take it to the marketplace
 * - disputed: the marketplace decides (Shopee dispute, TikTok Shop arbitration)
 * - refunded: the buyer is refunded; final
 * - cancelled: withdrawn by the buyer or closed by the marketplace before a decision; final
 * - closed: finished otherwise (another unit sent, the seller's side upheld, closed by Shopee); final
 */
export type ReturnState =
  | "requested"
  | "negotiating"
  | "accepted"
  | "in_transit"
  | "rejected"
  | "disputed"
  | "refunded"
  | "cancelled"
  | "closed";

/** Units of one listing variant in a request. */
export interface NormalizedReturnItem {
  /** Listing item and variant, as in NormalizedOrderItem ("" variant for items without variants). */
  externalItemId: string;
  externalVariantId: string;
  quantity: number;
  sku: string | null;
  title: string | null;
  /** Refund for these units in whole rupiah, when the marketplace says. */
  refundAmount: number | null;
}

/** A photo or video attached to a request; marketplace URLs, shown to the seller as they are. */
export interface ReturnEvidence {
  type: "image" | "video";
  url: string;
  thumbnailUrl: string | null;
  /** Who attached it. */
  by: "buyer" | "seller" | "marketplace";
}

export interface NormalizedReturn {
  /**
   * Shopee return_sn, TikTok Shop return_id or cancel_id. A Shopee cancellation request has no id of
   * its own: its order_sn.
   */
  externalReturnId: string;
  externalOrderId: string;
  kind: ReturnKind;
  state: ReturnState;
  /** Marketplace status as received, shown next to the internal one. */
  externalStatus: string;
  /** Who started the request. */
  initiator: "buyer" | "seller" | "marketplace" | null;
  /** Marketplace reason code. */
  reasonCode: string | null;
  /** The reason in words (the buyer's own text where the marketplace keeps it). Never logged. */
  reason: string | null;
  /** Photos and videos in the request itself; more may come from `details`. */
  evidence: ReturnEvidence[];
  /** Refund to the buyer in whole rupiah, when the marketplace says. */
  refundAmount: number | null;
  currency: string;
  /** The seller must decide by then, or the marketplace decides for them (TikTok Shop approves). */
  respondBy: Date | null;
  /** The marketplace's name for what it waits for from the seller, when it says; null when nothing. */
  sellerAction: string | null;
  /** The items travel back to the seller. */
  goodsReturn: boolean;
  returnTrackingNumber: string | null;
  returnCarrier: string | null;
  createdAt: Date;
  /** Marketplace update time; a snapshot older than the stored one is ignored. */
  updatedAt: Date;
  items: NormalizedReturnItem[];
}

export interface ReturnPage {
  returns: NormalizedReturn[];
  /** Opaque, pass back to get the next page; null when the time range is exhausted. */
  nextCursor: string | null;
}

/** A reason the seller can give to reject, with the evidence the marketplace asks for. */
export interface ReturnRejectReason {
  code: string;
  label: string;
  /** What to photograph (Shopee evidence modules); empty when photos are free-form or not asked. */
  evidence: { module: number; requirement: string; required: boolean }[];
}

/** One decision the seller can take now. */
export interface ReturnDecision {
  /** Sent back with `respond`. */
  code: string;
  action: "accept" | "reject";
  /** Indonesian label for the seller. */
  label: string;
  /** Reasons to choose from; a rejection needs one when the list is not empty. */
  reasons: ReturnRejectReason[];
  /** The marketplace needs the seller's contact email with this decision (Shopee disputes). */
  needsEmail: boolean;
}

export interface ReturnDetails {
  decisions: ReturnDecision[];
  /** Photos and videos read separately (TikTok Shop records, Shopee buyer videos); null when not read. */
  evidence: ReturnEvidence[] | null;
}

/** A photo uploaded for a rejection. */
export interface UploadedEvidence {
  ref: string;
  contentType: string;
  width: number | null;
  height: number | null;
}

export interface ReturnResponse {
  externalReturnId: string;
  externalOrderId: string;
  kind: ReturnKind;
  /** ReturnDecision.code. */
  decision: string;
  /** ReturnRejectReason.code, for a rejection. */
  reason: string | null;
  comment: string | null;
  /** Photos from `uploadEvidence`, with the evidence module each answers where the reason has them. */
  evidence: (UploadedEvidence & { module: number | null })[];
  email: string | null;
  /** The same key for every retry of one decision (TikTok Shop idempotency_key). */
  idempotencyKey: string;
}

export type WebhookEventKind =
  | "authorization.granted"
  | "authorization.revoked"
  | "authorization.expiring"
  | "order.status_changed"
  | "order.tracking_updated"
  | "shipment.document_ready"
  | "listing.changed"
  | "return.changed"
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
    /** `return.changed`: the request (TikTok Shop return_id). */
    externalReturnId?: string;
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
  /** Optional non-seller principal authorization, only when an application consumer exists. */
  accounts?: MarketplaceAccountAuth;
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
    /** Sets regular SKU prices; explicit per-SKU results. Authentication/transient failures throw. */
    updatePrices?(
      shop: ShopCredentials,
      updates: ListingPriceUpdate[],
      context?: { crossBorder: boolean },
    ): Promise<ListingPriceResult[]>;
  };

  /**
   * Creating products, for copying listings between shops (FR-PRD-13). Reference data (categories,
   * rules, brands) is read in the shop's language; prices are whole rupiah.
   */
  products: {
    /** The product behind an item, with its variants; null when the marketplace no longer has it. */
    get(shop: ShopCredentials, externalItemId: string): Promise<SourceProduct | null>;
    /** The category tree the shop may use. */
    categories(shop: ShopCredentials): Promise<MarketplaceCategory[]>;
    /** Leaf categories the marketplace suggests for a product, best first. */
    recommendCategory(
      shop: ShopCredentials,
      input: {
        title: string;
        description: string;
        /** Where the product sits on the marketplace it comes from (TikTok Shop uses it). */
        source?: { categoryId: string; categoryName: string | null; categoryPath: string | null; brand: string | null };
      },
    ): Promise<string[]>;
    /** Attributes and limits of leaf categories. */
    categoryRules(shop: ShopCredentials, categoryIds: string[]): Promise<CategoryRules[]>;
    /** Brands usable in a category, optionally only those whose name starts with `name`. */
    brands(shop: ShopCredentials, input: { categoryId: string; name?: string }): Promise<MarketplaceBrand[]>;
    /** Uploads an image file; returns the reference products use and, when given, its public URL. */
    uploadImage(
      shop: ShopCredentials,
      image: { bytes: Uint8Array; contentType: string; use: ImageUse },
    ): Promise<{ ref: string; url: string | null }>;
    /** Why the shop cannot list products now, in the marketplace's words; empty when it can. */
    prerequisites(shop: ShopCredentials): Promise<string[]>;
    /**
     * Creates the product with its variants. `resume` continues a product whose item exists but whose
     * variants failed (the error carried `externalItemId`). `hooks.itemCreated` runs as soon as the
     * marketplace has the item, before its variants are added, so the caller can keep its id even if
     * the process stops right after (Shopee has no idempotency key).
     */
    create(
      shop: ShopCredentials,
      product: ProductToCreate,
      resume?: { externalItemId: string },
      hooks?: CreateHooks,
    ): Promise<CreatedProduct>;
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

  /**
   * Buyers' after-sales requests (PRD FR-RET-01, 02; backend doc 8.26): returns and refunds, and requests
   * to cancel an order before it ships. Personal data the marketplaces return with them (buyer email,
   * pickup address) is never read into these types.
   */
  returns: {
    /** One page of return requests updated in [from, to). The connector splits long ranges. */
    listReturns(shop: ShopCredentials, input: { from: Date; to: Date; cursor?: string | null }): Promise<ReturnPage>;
    /** Current state of specific return requests. Unknown ids are left out. */
    getReturns(shop: ShopCredentials, externalReturnIds: string[]): Promise<NormalizedReturn[]>;
    /** The buyers' cancellation requests of these orders (kind `cancellation`), open or answered. */
    cancellations(shop: ShopCredentials, externalOrderIds: string[]): Promise<NormalizedReturn[]>;
    /** What the seller may decide now, and evidence the request listing leaves out. */
    details(
      shop: ShopCredentials,
      request: Pick<NormalizedReturn, "externalReturnId" | "externalOrderId" | "kind" | "externalStatus">,
    ): Promise<ReturnDetails>;
    /** Uploads one photo for a rejection (JPEG or PNG). */
    uploadEvidence(
      shop: ShopCredentials,
      input: { externalReturnId: string; kind: ReturnKind; bytes: Uint8Array; contentType: string },
    ): Promise<UploadedEvidence>;
    /** Sends the seller's decision. */
    respond(shop: ShopCredentials, response: ReturnResponse): Promise<void>;
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

  /** Read-only affiliate operations, only where implemented and permitted for the app and shop. */
  affiliate?: {
    listOpenCampaignProducts(shop: ShopCredentials, input?: OpenCampaignProductQuery): Promise<OpenCampaignProductPage>;
  };
}

export interface OpenCampaignProductQuery {
  pageSize?: number;
  cursor?: string | null;
  sortBy?: "commission_rate" | "-commission_rate";
  search?: { by: "name" | "id"; value: string };
}

/** Commission rates are integer basis points: 1.11 percent is 111, not a rupiah amount. */
export interface OpenCampaignProduct {
  externalItemId: string;
  title: string;
  externalCampaignId: string;
  status: "upcoming" | "ongoing" | "terminating" | "unknown";
  externalStatus: string;
  commissionBasisPoints: number;
  startsAt: Date;
  /** null is the marketplace's explicit unlimited period, not an unknown date. */
  endsAt: Date | null;
  pendingTerminationAt: Date | null;
  protections: { commissionBasisPoints: number; endsAt: Date }[];
  maxCommissionBasisPointsToday: number | null;
}

export interface OpenCampaignProductPage {
  items: OpenCampaignProduct[];
  total: number;
  nextCursor: string | null;
}

/** Creator/partner identities are separate from seller shops and their credentials. */
export type MarketplaceAccountKind = "creator" | "affiliate_partner";
export interface MarketplaceAccountGrant {
  kind: MarketplaceAccountKind;
  externalPrincipalId: string;
  tokens: TokenSet;
}
export interface MarketplaceAccountProfile {
  displayName: string | null;
  region: string;
  info: Record<string, unknown>;
  /** Worker-only opaque asset identifiers, kept separately from public profile metadata. */
  categoryAssets: { cipher: string; categoryId: number; categoryName: string; market: string }[];
}
export interface MarketplaceAccountAuth {
  authorizeUrl(input: { state: string; kind: MarketplaceAccountKind }): string;
  exchangeCode(input: { code: string; kind: MarketplaceAccountKind }): Promise<MarketplaceAccountGrant>;
  refresh(input: {
    refreshToken: string;
    kind: MarketplaceAccountKind;
    externalPrincipalId: string;
  }): Promise<MarketplaceAccountGrant>;
  describe(input: {
    accessToken: string;
    kind: MarketplaceAccountKind;
    scopes: readonly string[];
  }): Promise<MarketplaceAccountProfile>;
}
