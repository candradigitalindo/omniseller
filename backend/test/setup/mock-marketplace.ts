import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PDFDocument } from "pdf-lib";
import {
  MockProductState,
  type MockShopeeChannel,
  SHOPEE_DEFAULT_CHANNELS,
  shopeeProductCall,
  solidPng,
  tiktokProductCall,
} from "./mock-products";
import { MockReturnState, shopeeReturnCall, tiktokReturnCall } from "./mock-returns";

/**
 * A fake Shopee Open Platform and TikTok Shop Partner API for integration tests (backend doc 13.2).
 * It enforces what the real platforms document, so tests prove our side of the protocol:
 *
 * Shopee: HMAC-SHA256(partner_key, partner_id + path + timestamp [+ access_token + shop_id]) in `sign`,
 * a 5-minute timestamp window, single-use codes, refresh tokens usable once per shop, 4-hour tokens.
 * TikTok Shop: HMAC-SHA256(app_secret, secret + path + sorted params + body + secret), the token in
 * x-tts-access-token (never in the signature), shop_cipher for shop calls, rotating refresh tokens.
 */

export const SHOPEE = { partnerId: 1000016, partnerKey: "shopee-partner-key-for-tests" };
export const TIKTOK = {
  appKey: "tts-app-key",
  appSecret: "tts-app-secret-for-tests",
  serviceId: "7000000000000000001",
};

/** A Shopee item; `models` empty means an item without variants. */
export interface MockShopeeItem {
  item_id: number;
  item_name: string;
  item_sku?: string;
  item_status: "NORMAL" | "UNLIST" | "BANNED" | "REVIEWING" | "SELLER_DELETE" | "SHOPEE_DELETE";
  update_time: number;
  weight?: string;
  images?: string[];
  price?: number;
  stock?: number;
  /**
   * Seller stock per location_id; "" is stock without a location. Defaults to { IDZ: stock }. update_stock
   * must keep this structure, as Shopee requires.
   */
  stockByLocation?: Record<string, number>;
  /** Option names per tier; `images` gives the first tier's option images (URLs or null). */
  tiers?: { name: string; options: string[]; images?: (string | null)[] }[];
  models?: {
    model_id: number;
    model_sku?: string;
    tier_index: number[];
    price: number;
    stock: number;
    stockByLocation?: Record<string, number>;
  }[];
  /** unlist_item refuses this item, like an item under promotion */
  lockedForUnlist?: boolean;
  /** Stock reserved for a promotion: update_stock refuses less than this per model. */
  reservedStock?: number;
  // what get_item_base_info adds for a copy (FR-PRD-13)
  category_id?: number;
  description?: string;
  attributes?: {
    attribute_id: number;
    original_attribute_name: string;
    attribute_value_list: { value_id: number; original_value_name: string; value_unit?: string }[];
  }[];
  brand?: { brand_id: number; original_brand_name: string };
  dimension?: { package_length: number; package_width: number; package_height: number };
  logistic_info?: { logistic_id: number; enabled: boolean; is_free?: boolean; size_id?: number }[];
  condition?: "NEW" | "USED";
}

/** A Shopee order as get_order_detail returns it; tests change fields to move it along. */
export interface MockShopeeOrder {
  order_sn: string;
  order_status: string;
  create_time: number;
  update_time: number;
  pay_time?: number;
  ship_by_date?: number;
  /** When the courier picked the parcel up (shipped). */
  pickup_done_time?: number;
  cod?: boolean;
  total_amount?: number;
  currency?: string;
  buyer_user_id?: number;
  buyer_username?: string;
  message_to_seller?: string;
  shipping_carrier?: string;
  fulfillment_flag?: string;
  recipient_address?: {
    name?: string;
    phone?: string;
    city?: string;
    state?: string;
    zipcode?: string;
    full_address?: string;
  };
  cancel_by?: string;
  cancel_reason?: string;
  /** The buyer's reason while the order is IN_CANCEL. */
  buyer_cancel_reason?: string;
  /** Warehouse of every line, as product_location_id (defaults to IDZ). */
  location?: string;
  /** What v2.logistics.get_tracking_info answers for the order. */
  tracking?: {
    logistics_status: string;
    tracking_info: { update_time: number; description: string; logistics_status: string; return_code?: string }[];
  };
  /** A split order: get_tracking_info needs a package number, and each package has its own journey. */
  splitTracking?: Record<
    string,
    {
      logistics_status: string;
      tracking_info: { update_time: number; description: string; logistics_status: string }[];
    }
  >;
  item_list: {
    item_id: number;
    item_name: string;
    item_sku?: string;
    model_id: number;
    model_name?: string;
    model_sku?: string;
    model_quantity_purchased: number;
    model_original_price: number;
    model_discounted_price: number;
    product_location_id?: string;
    cancelled_qty?: number;
  }[];
}

export interface MockShopeeShop {
  shopId: string;
  name: string;
  region: string;
  items?: MockShopeeItem[];
  orders?: MockShopeeOrder[];
  fulfillmentFlag?: string;
  /** "not_whitelisted" answers warehouse.error_not_in_whitelist, like a shop without multi-warehouse. */
  warehouses: "not_whitelisted" | { warehouse_id: number; warehouse_name: string; location_id: string }[];
  /** Authorization end, epoch seconds. */
  expireTime?: number;
  /** v2.logistics.get_channel_list; defaults to SPX Standard and J&T Express enabled. */
  channels?: MockShopeeChannel[];
}

export interface MockTiktokProduct {
  id: string;
  title: string;
  status: "ACTIVATE" | "SELLER_DEACTIVATED" | "PLATFORM_DEACTIVATED" | "PENDING" | "DELETED" | "FREEZE";
  tokopedia?: string;
  update_time: number;
  images?: string[];
  skus: {
    id: string;
    seller_sku?: string;
    price: number;
    attrs: Record<string, string>;
    inventory: Record<string, number>;
    /** Image of the SKU's first sales attribute value. */
    image?: string;
    /** GTIN (identifier_code). */
    identifier?: string;
  }[];
  // what Get Product adds for a copy (FR-PRD-13)
  description?: string;
  categoryChain?: { id: string; parent_id: string; local_name: string; is_leaf: boolean }[];
  brand?: { id: string; name: string };
  attributes?: { id: string; name: string; values: { id?: string; name: string }[] }[];
  packageWeightKg?: string;
  dimensions?: { length: string; width: string; height: string; unit: string };
}

/** A TikTok Shop order as Get Order Detail returns it: one line item per unit. */
export interface MockTiktokOrder {
  id: string;
  status: string;
  create_time: number;
  update_time: number;
  paid_time?: number;
  rts_sla_time?: number;
  is_cod?: boolean;
  commerce_platform?: string;
  fulfillment_type?: string;
  warehouse_id?: string;
  user_id?: string;
  buyer_message?: string;
  delivery_option_name?: string;
  shipping_provider?: string;
  tracking_number?: string;
  cancel_reason?: string;
  cancellation_initiator?: string;
  is_buyer_request_cancel?: boolean;
  /** TIKTOK (platform shipping, default) or SELLER (own courier). */
  shipping_type?: "TIKTOK" | "SELLER";
  /** What Get Tracking (202309) answers for the order. */
  tracking?: { description: string; update_time_millis: number; action_code: number }[];
  recipient_address?: { name?: string; phone_number?: string; full_address?: string; postal_code?: string };
  payment?: { currency?: string; sub_total?: string; shipping_fee?: string; total_amount?: string };
  line_items: {
    id: string;
    sku_id: string;
    product_id: string;
    seller_sku?: string;
    product_name: string;
    sku_name?: string;
    sale_price: string;
    original_price: string;
    display_status?: string;
  }[];
}

export interface MockTiktokShop {
  id: string;
  name: string;
  region: string;
  cipher: string;
  products?: MockTiktokProduct[];
  orders?: MockTiktokOrder[];
  warehouses: { id: string; name: string; type: "SALES_WAREHOUSE" | "RETURN_WAREHOUSE"; is_default: boolean }[];
  fbt?: { fbt_warehouse_id: string; name: string; subscribed: boolean }[];
}

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Query string as sent, to read repeated parameters. */
  rawQuery: string;
  body: string;
  headers: IncomingMessage["headers"];
  /** A multipart/form-data body (image uploads); `body` then holds the raw text, not signed. */
  form?: FormData;
}

type Reply = { status: number; body: unknown; file?: Uint8Array; contentType?: string };

const now = () => Math.floor(Date.now() / 1000);

type ShopeeStocked = { stock?: number; stockByLocation?: Record<string, number> };
const shopeeLocations = (x: ShopeeStocked): Record<string, number> => x.stockByLocation ?? { IDZ: x.stock ?? 0 };
const shopeeSellerStock = (x: ShopeeStocked) =>
  Object.entries(shopeeLocations(x)).map(([location_id, stock]) => (location_id ? { location_id, stock } : { stock }));
const token = (prefix: string) => `${prefix}${randomBytes(12).toString("hex")}`;
const hmac = (key: string, msg: string) => createHmac("sha256", key).update(msg, "utf8").digest("hex");

interface ShopeePackageState {
  method: "pickup" | "dropoff";
  tracking: string;
  /** get_mass_tracking_number calls left that answer without a number */
  trackingDelay: number;
  /** shipping_document_type created; the document is READY at once */
  document?: string;
}

/** One package per order, `OFG<order_sn>`, its status following the order like Shopee's. */
function shopeePackagesOf(o: MockShopeeOrder) {
  const status: Record<string, string> = {
    UNPAID: "LOGISTICS_NOT_START",
    READY_TO_SHIP: "LOGISTICS_READY",
    RETRY_SHIP: "LOGISTICS_PICKUP_RETRY",
    PROCESSED: "LOGISTICS_REQUEST_CREATED",
    SHIPPED: "LOGISTICS_PICKUP_DONE",
    TO_CONFIRM_RECEIVE: "LOGISTICS_DELIVERY_DONE",
    COMPLETED: "LOGISTICS_DELIVERY_DONE",
    CANCELLED: "LOGISTICS_INVALID",
  };
  return [
    {
      package_number: `OFG${o.order_sn}`,
      logistics_status: status[o.order_status] ?? "LOGISTICS_NOT_START",
      logistics_channel_id: 8003,
      shipping_carrier: o.shipping_carrier ?? "SPX Standard",
      item_list: o.item_list.map((i) => ({
        item_id: i.item_id,
        model_id: i.model_id,
        model_quantity: i.model_quantity_purchased,
        promotion_group_id: 0,
        product_location_id: o.location ?? "IDZ",
      })),
    },
  ];
}

/** The shop's pickup address (3001) with two slots tomorrow, the later one recommended; drop-off needs nothing. */
const SHOPEE_PICKUP = (() => {
  const tomorrow = Math.floor(Date.now() / 86_400_000) * 86400 + 86400;
  return {
    address_list: [
      { address_id: 3002, address_flag: ["return_address"], time_slot_list: [] as { pickup_time_id: string }[] },
      {
        address_id: 3001,
        city: "Jakarta Barat",
        address: "Jl. Gudang 1",
        address_flag: ["default_address", "pickup_address"],
        time_slot_list: [
          {
            date: tomorrow + 2 * 3600,
            time_text: "09:00 - 12:00",
            pickup_time_id: String(tomorrow + 2 * 3600),
            flags: [],
          },
          {
            date: tomorrow + 6 * 3600,
            time_text: "13:00 - 17:00",
            pickup_time_id: String(tomorrow + 6 * 3600),
            flags: ["recommended"],
          },
        ],
      },
    ],
  };
})();
// the pickup address first, for lookups
SHOPEE_PICKUP.address_list.reverse();

function shopeeShippingParameter() {
  return {
    info_needed: { pickup: ["address_id", "pickup_time_id"], dropoff: [] },
    pickup: SHOPEE_PICKUP,
    dropoff: { branch_list: null },
  };
}

/** A label PDF of the given size in millimetres, one page per text. */
async function labelPdf(texts: string[], widthMm: number, heightMm: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const text of texts) {
    doc.addPage([(widthMm * 72) / 25.4, (heightMm * 72) / 25.4]).drawText(text, { x: 20, y: 200, size: 12 });
  }
  return doc.save();
}

export class MockMarketplace {
  url = "";
  readonly calls: Call[] = [];
  /** Every access and refresh token handed out, to prove none is stored in plain text. */
  readonly issued: string[] = [];
  private server: Server | undefined;
  private readonly queued = new Map<string, Reply[]>();

  // ---- Shopee state ----
  readonly shopeeShops = new Map<string, MockShopeeShop>();
  private readonly shopeeCodes = new Map<string, { shopIds: string[]; shopId?: string; mainAccountId?: string }>();
  private readonly shopeeAccess = new Map<string, { shopIds: string[]; expiresAt: number }>();
  /** refresh token -> shops that may still use it once */
  private readonly shopeeRefresh = new Map<string, Set<string>>();

  // ---- TikTok Shop state ----
  private readonly tiktokSellers = new Map<string, { openId: string; name: string; shops: MockTiktokShop[] }>();
  private readonly tiktokCodes = new Map<string, string>();
  private readonly tiktokAccess = new Map<string, { sellerId: string; expiresAt: number }>();
  private readonly tiktokRefresh = new Map<string, string>();
  /** shop cipher -> event_type -> address */
  readonly tiktokWebhooks = new Map<string, Map<string, string>>();

  // ---- shipping state (backend doc 13.2) ----
  /** Shopee package_number -> arrangement, tracking number, airway bill. */
  readonly shopeePackages = new Map<string, ShopeePackageState>();
  /** get_mass_tracking_number answers without a number this many times after arranging (courier delay). */
  shopeeTrackingDelay = 0;
  /** Packages mass_ship_order refuses (fail_list), with the reason. */
  readonly shopeeRefuse = new Map<string, string>();
  /** TikTok Shop package id -> arrangement and tracking number. */
  readonly tiktokPackages = new Map<string, { method: string; tracking: string }>();
  /** Tracking reads, `<marketplace>:<order>:<package>`. */
  readonly trackingCalls: string[] = [];

  // ---- product creation (FR-PRD-13) ----
  readonly products = new MockProductState();
  // ---- returns, refunds, and cancellation requests (FR-RET-01, 02) ----
  readonly returns = new MockReturnState();
  /** Image downloads (`/img/...`), to prove each image is fetched once per upload. */
  readonly imageDownloads: string[] = [];

  /** Port 0 picks a free port (tests); a fixed port lets separately started processes find it. */
  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** The next call to `METHOD path` gets this answer instead of the normal one. */
  failNext(method: string, path: string, status: number, body: unknown): void {
    const key = `${method} ${path}`;
    this.queued.set(key, [...(this.queued.get(key) ?? []), { status, body }]);
  }

  callsTo(method: string, path: string): Call[] {
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  // ---- Shopee setup ----

  addShopeeShop(shop: MockShopeeShop): void {
    this.shopeeShops.set(shop.shopId, shop);
  }

  /** What Shopee appends to redirect_uri after the seller authorizes. */
  shopeeCode(input: { shopId: string } | { mainAccountId: string; shopIds: string[] }): string {
    const code = randomBytes(16).toString("hex");
    this.shopeeCodes.set(code, "shopId" in input ? { shopIds: [input.shopId], shopId: input.shopId } : { ...input });
    return code;
  }

  /** Makes every Shopee access token invalid, as after 4 hours. */
  expireShopeeAccessTokens(): void {
    for (const t of this.shopeeAccess.values()) t.expiresAt = now() - 1;
  }

  revokeShopeeRefreshTokens(): void {
    this.shopeeRefresh.clear();
  }

  signShopeePush(callbackUrl: string, body: string): string {
    return hmac(SHOPEE.partnerKey, `${callbackUrl}|${body}`);
  }

  // ---- TikTok Shop setup ----

  addTiktokSeller(input: { openId: string; name: string; shops: MockTiktokShop[] }): string {
    const id = `seller-${input.openId}`;
    this.tiktokSellers.set(id, input);
    return id;
  }

  tiktokCode(sellerId: string): string {
    const code = `TTP_${randomBytes(12).toString("hex")}`;
    this.tiktokCodes.set(code, sellerId);
    return code;
  }

  signTiktokWebhook(body: string): string {
    return hmac(TIKTOK.appSecret, `${TIKTOK.appKey}${body}`);
  }

  // ---- HTTP ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const body = raw.toString("utf8");
    const url = new URL(req.url ?? "/", "http://mock");
    const type = String(req.headers["content-type"] ?? "");
    const call: Call = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      rawQuery: url.search,
      body,
      headers: req.headers,
      ...(type.startsWith("multipart/form-data")
        ? { form: await new Response(raw, { headers: { "content-type": type } }).formData() }
        : {}),
    };
    this.calls.push(call);
    const key = `${call.method} ${call.path}`;
    const forced = this.queued.get(key)?.shift();
    const reply = forced ?? (await this.route(call));
    if (reply.file) {
      res.writeHead(reply.status, { "content-type": reply.contentType ?? "application/pdf" });
      res.end(Buffer.from(reply.file));
      return;
    }
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  }

  private route(call: Call): Reply | Promise<Reply> {
    if (call.path.startsWith("/api/v2/token/")) return this.tiktokToken(call);
    if (call.path.startsWith("/api/v2/")) return this.shopee(call);
    // TikTok Shop's label links: a plain download without signature, like its file host
    const doc = /^\/tts-docs\/([A-Za-z0-9]+)\.pdf$/.exec(call.path);
    if (doc && call.method === "GET") return this.tiktokDocument(doc[1]!);
    // product images on the marketplaces' file hosts: a source product's images and uploaded ones
    if (call.method === "GET" && /^\/(img|shopee-img|tts-img)\//.test(call.path)) return this.image(call.path);
    return this.tiktok(call);
  }

  /**
   * `/img/<name>.png` a 600 x 600 PNG, `.webp` a WebP header (Shopee refuses it), `missing-*` 404,
   * `huge-*` more than 10 MB; uploaded images (`/shopee-img/`, `/tts-img/`) as PNG.
   */
  private image(path: string): Reply {
    this.imageDownloads.push(path);
    const name = path.split("/").pop() ?? "";
    if (name.startsWith("missing-")) return { status: 404, body: { message: "not found" } };
    if (name.endsWith(".webp")) {
      const webp = Buffer.concat([
        Buffer.from("RIFF"),
        Buffer.from([0x24, 0, 0, 0]),
        Buffer.from("WEBPVP8 "),
        Buffer.alloc(24),
      ]);
      return { status: 200, body: null, file: webp, contentType: "image/webp" };
    }
    if (name.startsWith("huge-")) {
      const big = new Uint8Array(10 * 1024 * 1024 + 10);
      big.set(solidPng(4, 4).subarray(0, 8));
      return { status: 200, body: null, file: big, contentType: "image/png" };
    }
    return { status: 200, body: null, file: solidPng(600, 600), contentType: "image/png" };
  }

  // ---- Shopee endpoints ----

  private shopeeError(error: string, message: string, status = 403): Reply {
    return { status, body: { error, message, request_id: token("rq") } };
  }

  private shopee(call: Call): Reply | Promise<Reply> {
    const q = call.query;
    const ts = Number(q.timestamp);
    if (Number(q.partner_id) !== SHOPEE.partnerId) return this.shopeeError("error_param", "Invalid partner_id.");
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > 300)
      return this.shopeeError("error_param", "Timestamp is expired.");
    const shopLevel = q.access_token !== undefined;
    const base = `${SHOPEE.partnerId}${call.path}${ts}${shopLevel ? `${q.access_token}${q.shop_id}` : ""}`;
    if (q.sign !== hmac(SHOPEE.partnerKey, base)) return this.shopeeError("error_sign", "Wrong sign.");

    if (call.path === "/api/v2/auth/token/get") return this.shopeeTokenGet(JSON.parse(call.body));
    if (call.path === "/api/v2/auth/access_token/get") return this.shopeeRefreshToken(JSON.parse(call.body));

    const shopId = q.shop_id ?? "";
    const access = this.shopeeAccess.get(q.access_token ?? "");
    if (!access?.shopIds.includes(shopId) || access.expiresAt <= now()) {
      return this.shopeeError("invalid_acceess_token", "Invalid access_token, please have a check.");
    }
    const shop = this.shopeeShops.get(shopId);
    if (!shop) return this.shopeeError("error_auth", "Invalid partner_id or shopid.");
    const ok = (extra: object) => ({
      status: 200,
      body: { error: "", message: "", request_id: token("rq"), ...extra },
    });
    if (call.path === "/api/v2/logistics/get_channel_list") {
      return ok({ response: { logistics_channel_list: shop.channels ?? SHOPEE_DEFAULT_CHANNELS } });
    }
    if (call.path.startsWith("/api/v2/logistics/") && call.path !== "/api/v2/logistics/get_address_list") {
      return this.shopeeLogistics(call, shop, ok);
    }
    if (
      call.path.startsWith("/api/v2/media_space/") ||
      [
        "/api/v2/product/get_category",
        "/api/v2/product/category_recommend",
        "/api/v2/product/get_attribute_tree",
        "/api/v2/product/get_item_limit",
        "/api/v2/product/get_brand_list",
        "/api/v2/product/add_item",
        "/api/v2/product/init_tier_variation",
      ].includes(call.path)
    ) {
      return shopeeProductCall(
        this.products,
        call,
        shop,
        ok,
        (error, message, status = 400) => this.shopeeError(error, message, status),
        (id) => `${this.url}/shopee-img/${id}`,
      ).then((r) => r ?? this.shopeeError("error_param", "Permission denied. The request path is incorrect.", 404));
    }

    if (call.path.startsWith("/api/v2/returns/") || call.path === "/api/v2/order/handle_buyer_cancellation") {
      return shopeeReturnCall(
        this.returns,
        call,
        shop,
        ok,
        (error, message, status = 400) => this.shopeeError(error, message, status),
        (id) => `${this.url}/shopee-proof/${id}.jpg`,
      ).then((r) => r ?? this.shopeeError("error_param", "Permission denied. The request path is incorrect.", 404));
    }

    switch (call.path) {
      case "/api/v2/shop/get_shop_info":
        return ok({
          shop_name: shop.name,
          region: shop.region,
          status: "NORMAL",
          is_cb: false,
          is_sip: false,
          merchant_id: null,
          shop_fulfillment_flag: shop.fulfillmentFlag ?? "Others",
          auth_time: now() - 10,
          expire_time: shop.expireTime ?? now() + 365 * 86400,
        });
      case "/api/v2/shop/get_profile":
        return ok({ response: { shop_logo: `https://cf.shopee.co.id/file/${shopId}`, shop_name: shop.name } });
      case "/api/v2/shop/get_warehouse_detail":
        if (shop.warehouses === "not_whitelisted") {
          return this.shopeeError(
            "warehouse.error_not_in_whitelist",
            "Your shop is not in multi-warehouse whitelist.",
            200,
          );
        }
        return ok({ response: shop.warehouses.map((w) => ({ ...w, warehouse_type: 1, region: shop.region })) });
      case "/api/v2/product/get_item_list": {
        const statuses = new URLSearchParams(call.rawQuery).getAll("item_status");
        const from = q.update_time_from ? Number(q.update_time_from) : 0;
        const all = (shop.items ?? []).filter((i) => statuses.includes(i.item_status) && i.update_time >= from);
        const offset = Number(q.offset ?? 0);
        const size = Number(q.page_size ?? 100);
        const page = all.slice(offset, offset + size);
        return ok({
          response: {
            item: page.map((i) => ({ item_id: i.item_id, item_status: i.item_status, update_time: i.update_time })),
            total_count: all.length,
            has_next_page: offset + size < all.length,
            next_offset: offset + size,
          },
        });
      }
      case "/api/v2/product/get_item_base_info": {
        const ids = (q.item_id_list ?? "").split(",").map(Number);
        if (ids.length > 50) return this.shopeeError("error_param", "item_id_list should be [1,50]", 400);
        const items = (shop.items ?? []).filter((i) => ids.includes(i.item_id));
        return ok({
          response: {
            item_list: items.map((i) => ({
              item_id: i.item_id,
              item_name: i.item_name,
              item_sku: i.item_sku ?? "",
              item_status: i.item_status,
              update_time: i.update_time,
              has_model: (i.models ?? []).length > 0,
              weight: i.weight ?? "0.2",
              image: { image_url_list: i.images ?? [] },
              category_id: i.category_id ?? 100017,
              description: i.description ?? "",
              description_type: "normal",
              attribute_list: i.attributes ?? [],
              brand: i.brand ?? { brand_id: 0, original_brand_name: "NoBrand" },
              condition: i.condition ?? "NEW",
              logistic_info: i.logistic_info ?? [],
              pre_order: { is_pre_order: false, days_to_ship: 2 },
              ...(i.dimension ? { dimension: i.dimension } : {}),
              ...((i.models ?? []).length === 0
                ? {
                    price_info: [{ currency: "IDR", current_price: i.price ?? 0, original_price: i.price ?? 0 }],
                    stock_info_v2: {
                      summary_info: { total_available_stock: i.stock ?? 0 },
                      seller_stock: shopeeSellerStock(i),
                    },
                  }
                : {}),
            })),
          },
        });
      }
      case "/api/v2/product/get_model_list": {
        const item = (shop.items ?? []).find((i) => i.item_id === Number(q.item_id));
        if (!item) return this.shopeeError("error_item_not_found", "item not found", 404);
        return ok({
          response: {
            tier_variation: (item.tiers ?? []).map((t) => ({
              name: t.name,
              option_list: t.options.map((o, k) => ({
                option: o,
                ...(t.images?.[k] ? { image: { image_id: "x", image_url: this.optionImage(t.images[k]!) } } : {}),
              })),
            })),
            model: (item.models ?? []).map((m) => ({
              model_id: m.model_id,
              model_sku: m.model_sku ?? "",
              tier_index: m.tier_index,
              model_status: "MODEL_NORMAL",
              price_info: [{ currency: "IDR", current_price: m.price, original_price: m.price }],
              stock_info_v2: {
                summary_info: { total_available_stock: m.stock },
                seller_stock: shopeeSellerStock(m),
              },
            })),
          },
        });
      }
      case "/api/v2/product/unlist_item": {
        const body = JSON.parse(call.body) as { item_list: { item_id: number; unlist: boolean }[] };
        const success_list: object[] = [];
        const failure_list: object[] = [];
        for (const e of body.item_list) {
          const item = (shop.items ?? []).find((i) => i.item_id === e.item_id);
          if (!item || item.lockedForUnlist) {
            failure_list.push({ item_id: e.item_id, failed_reason: "Can't unlist item when item is under promotion" });
            continue;
          }
          item.item_status = e.unlist ? "UNLIST" : "NORMAL";
          item.update_time = now();
          success_list.push({ item_id: e.item_id, unlist: e.unlist });
        }
        return ok({ response: { success_list, failure_list } });
      }
      case "/api/v2/product/update_stock": {
        const body = JSON.parse(call.body) as {
          item_id: number;
          stock_list: { model_id: number; seller_stock: { location_id?: string; stock: number }[] }[];
        };
        if (!Array.isArray(body.stock_list) || body.stock_list.length < 1 || body.stock_list.length > 50) {
          return this.shopeeError("error_param", "Parameter is not match the constraints, stock_list.", 400);
        }
        const item = (shop.items ?? []).find((i) => i.item_id === body.item_id);
        if (!item || item.item_status === "SELLER_DELETE" || item.item_status === "SHOPEE_DELETE") {
          return this.shopeeError("error_item_not_found", "Item_id is not found.", 200);
        }
        if (item.item_status === "BANNED") {
          return this.shopeeError(
            "error_item_uneditable",
            "Can't edit this item. item status can not support editing.",
            200,
          );
        }
        const success_list: object[] = [];
        const failure_list: object[] = [];
        for (const e of body.stock_list) {
          const target: ShopeeStocked | undefined =
            e.model_id === 0
              ? (item.models ?? []).length === 0
                ? item
                : undefined
              : (item.models ?? []).find((m) => m.model_id === e.model_id);
          if (!target) {
            failure_list.push({ model_id: e.model_id, failed_reason: "Wrong model_id." });
            continue;
          }
          const current = { ...shopeeLocations(target) };
          const located = Object.keys(current).some((k) => k !== "");
          const total = e.seller_stock.reduce((n, x) => n + x.stock, 0);
          const failed = e.seller_stock.some((x) => (located ? !x.location_id : !!x.location_id))
            ? "Can not update item with different stock structure. Can only update seller stock with location id when existing seller stock have location id. Can only update seller stock without location id when existing seller stock without location id."
            : e.seller_stock.some((x) => x.location_id && !(x.location_id in current))
              ? "The location_id input is not matched the shop's location_id(more/wrong). Please double check."
              : total < (item.reservedStock ?? 0)
                ? "Can not update item with stock less than reserved stock"
                : null;
          if (failed) {
            failure_list.push({ model_id: e.model_id, failed_reason: failed });
            continue;
          }
          for (const x of e.seller_stock) current[x.location_id ?? ""] = x.stock;
          target.stockByLocation = current;
          target.stock = Object.values(current).reduce((n, v) => n + v, 0);
          for (const x of e.seller_stock) {
            success_list.push({
              model_id: e.model_id,
              ...(x.location_id ? { location_id: x.location_id } : {}),
              stock: x.stock,
            });
          }
        }
        if (failure_list.length > 0 && success_list.length === 0) {
          return {
            status: 200,
            body: {
              error: "error_busi_update_stock_failed",
              message: "Update stock failed, please check failure_list for detailed reason",
              request_id: token("rq"),
              response: { success_list, failure_list },
            },
          };
        }
        return ok({ response: { success_list, failure_list } });
      }
      case "/api/v2/order/get_order_list": {
        const field = q.time_range_field;
        if (field !== "create_time" && field !== "update_time") {
          return this.shopeeError("error_param", "time_range_field should be create_time or update_time", 400);
        }
        const from = Number(q.time_from);
        const to = Number(q.time_to);
        if (!(to > from) || to - from > 15 * 86_400) {
          return this.shopeeError("error_param", "The time range should not be longer than 15 days.", 400);
        }
        const size = Number(q.page_size);
        if (!(size >= 1 && size <= 100)) return this.shopeeError("error_param", "page_size should be [1,100]", 400);
        const all = (shop.orders ?? [])
          .filter((o) => o[field] >= from && o[field] <= to)
          .sort((a, b) => a[field] - b[field]);
        const offset = Number(q.cursor || 0);
        const page = all.slice(offset, offset + size);
        const more = offset + size < all.length;
        return ok({
          response: {
            order_list: page.map((o) => ({ order_sn: o.order_sn, order_status: o.order_status })),
            more,
            next_cursor: more ? String(offset + size) : "",
          },
        });
      }
      case "/api/v2/order/get_order_detail": {
        const sns = (q.order_sn_list ?? "").split(",").filter(Boolean);
        if (sns.length < 1 || sns.length > 50)
          return this.shopeeError("error_param", "order_sn_list should be [1,50]", 400);
        const withPackages = (q.response_optional_fields ?? "").split(",").includes("package_list");
        return ok({
          response: {
            order_list: (shop.orders ?? [])
              .filter((o) => sns.includes(o.order_sn))
              .map((o) => (withPackages ? { ...o, package_list: shopeePackagesOf(o) } : o)),
          },
        });
      }
      case "/api/v2/order/cancel_order": {
        const body = JSON.parse(call.body) as { order_sn: string; cancel_reason: string; item_list?: object[] };
        const o = (shop.orders ?? []).find((x) => x.order_sn === body.order_sn);
        if (!o) return this.shopeeError("error_not_found", "Wrong parameters, detail: order not found.", 200);
        if (!["UNPAID", "PENDING", "READY_TO_SHIP", "PROCESSED", "RETRY_SHIP"].includes(o.order_status)) {
          return this.shopeeError("order.error_limit", `Can not cancel this order: status ${o.order_status}`, 200);
        }
        if (
          !["OUT_OF_STOCK", "CUSTOMER_REQUEST", "UNDELIVERABLE_AREA", "COD_NOT_SUPPORTED"].includes(body.cancel_reason)
        ) {
          return this.shopeeError("error_param", "Wrong parameters, detail: cancel_reason invalid.", 400);
        }
        if (body.cancel_reason === "OUT_OF_STOCK" && !body.item_list?.length) {
          return this.shopeeError(
            "error_param",
            "Wrong parameters, detail: item_list is required for OUT_OF_STOCK.",
            400,
          );
        }
        o.order_status = "CANCELLED";
        o.cancel_by = "seller";
        o.cancel_reason = body.cancel_reason;
        o.update_time = now();
        return ok({ response: { update_time: o.update_time } });
      }
      case "/api/v2/logistics/get_address_list":
        return ok({
          response: {
            show_pickup_address: true,
            address_list: [
              { address_id: 1, region: shop.region, city: "Jakarta Barat", address_type: ["PICK_UP_ADDRESS"] },
            ],
          },
        });
      default:
        return this.shopeeError(
          "error_param",
          "Permission denied. This API is currently offline or the request path is incorrect.",
          404,
        );
    }
  }

  /**
   * Shopee shipment APIs (Order Management 8): get_mass_shipping_parameter and mass_ship_order (at most
   * 50 packages of one channel and warehouse, pickup at a listed address and slot, or drop-off),
   * get_shipping_parameter with ship_order or update_shipping_order (failed pickups), the tracking
   * number (late by `shopeeTrackingDelay` calls), and the airway bill: parameter, create, result,
   * download (a PDF).
   */
  private async shopeeLogistics(call: Call, shop: MockShopeeShop, ok: (extra: object) => Reply): Promise<Reply> {
    const body = (call.body ? JSON.parse(call.body) : {}) as Record<string, any>;
    const orderOf = (packageNumber: string) => (shop.orders ?? []).find((o) => `OFG${o.order_sn}` === packageNumber);
    const statusOf = (o: MockShopeeOrder) => shopeePackagesOf(o)[0]!.logistics_status;
    const packages = (list: unknown): string[] =>
      Array.isArray(list) ? list.map((p: { package_number?: string }) => p.package_number ?? "") : [];
    const element = (o: { order_sn?: string; package_number?: string }, extra: object) => ({
      order_sn: o.order_sn,
      package_number: o.package_number,
      ...extra,
    });
    const batch = (results: { fail_error?: string }[]) => ({
      status: 200,
      body: {
        error: results.length > 0 && results.every((r) => r.fail_error) ? "common.batch_api_all_failed" : "",
        message: "",
        request_id: token("rq"),
        response: { result_list: results },
      },
    });
    const arrange = (o: MockShopeeOrder, n: string, how: Record<string, any>): string | null => {
      if (how.pickup) {
        const slots = SHOPEE_PICKUP.address_list[0]!.time_slot_list.map((t) => t.pickup_time_id);
        if (how.pickup.address_id !== 3001) return "The address is invalid. Please check the address.";
        if (!slots.includes(how.pickup.pickup_time_id)) return "No available time slot";
      } else if (!how.dropoff) {
        return "Wrong parameters, detail: pickup or dropoff is required.";
      }
      o.order_status = "PROCESSED";
      o.update_time = now() + 1;
      this.shopeePackages.set(n, {
        method: how.pickup ? "pickup" : "dropoff",
        tracking: `SPXID${randomBytes(5).toString("hex").toUpperCase()}`,
        trackingDelay: this.shopeeTrackingDelay,
      });
      return null;
    };

    switch (call.path) {
      case "/api/v2/logistics/get_tracking_info": {
        this.trackingCalls.push(`shopee:${call.query.order_sn}:${call.query.package_number ?? ""}`);
        const o = (shop.orders ?? []).find((x) => x.order_sn === call.query.order_sn);
        if (!o) return this.shopeeError("logistics.invalid_error", "The order is not exist.", 200);
        if (o.splitTracking) {
          const part = o.splitTracking[call.query.package_number ?? ""];
          if (!call.query.package_number) {
            return this.shopeeError(
              "logistics.package_number_not_exist",
              "Please request with package_number for this split order.",
              200,
            );
          }
          if (!part) return this.shopeeError("logistics.package_not_exist", "The package is not exist.", 200);
          return ok({ response: { order_sn: o.order_sn, package_number: call.query.package_number, ...part } });
        }
        return ok({
          response: {
            order_sn: o.order_sn,
            package_number: call.query.package_number ?? "",
            ...(o.tracking ?? { logistics_status: shopeePackagesOf(o)[0]!.logistics_status, tracking_info: [] }),
          },
        });
      }
      case "/api/v2/logistics/get_mass_shipping_parameter": {
        const list = packages(body.package_list);
        if (list.length < 1 || list.length > 50)
          return this.shopeeError("error_param", "package_list should be [1,50]", 400);
        const fail_list: object[] = [];
        const success_list: object[] = [];
        for (const n of list) {
          const o = orderOf(n);
          if (!o || statusOf(o) !== "LOGISTICS_READY") {
            fail_list.push({ package_number: n, fail_reason: "Package is not ready to be shipped." });
          } else success_list.push({ package_number: n });
        }
        return ok({ response: { ...shopeeShippingParameter(), success_list, fail_list } });
      }
      case "/api/v2/logistics/mass_ship_order": {
        const list = packages(body.package_list);
        if (list.length < 1 || list.length > 50)
          return this.shopeeError("error_param", "package_list should be [1,50]", 400);
        const success_list: object[] = [];
        const fail_list: object[] = [];
        for (const n of list) {
          const o = orderOf(n);
          if (!o) {
            fail_list.push({ package_number: n, fail_reason: "Package not found." });
            continue;
          }
          if (body.logistics_channel_id !== 8003 || body.product_location_id !== (o.location ?? "IDZ")) {
            fail_list.push({ package_number: n, fail_reason: "Package is not under the specified warehouse" });
            continue;
          }
          if (statusOf(o) !== "LOGISTICS_READY") {
            fail_list.push({ package_number: n, fail_reason: "Package is not ready to be shipped." });
            continue;
          }
          const refused = this.shopeeRefuse.get(n);
          const problem = refused ?? arrange(o, n, body);
          if (problem) fail_list.push({ package_number: n, fail_reason: problem });
          else success_list.push({ package_number: n });
        }
        // documented at the top level of the answer
        return ok({ success_list, fail_list });
      }
      case "/api/v2/logistics/get_shipping_parameter": {
        const o = orderOf(call.query.package_number ?? "");
        if (!o)
          return this.shopeeError("logistics.package_number_not_exist", "Please request with package_number.", 200);
        return ok({ response: shopeeShippingParameter() });
      }
      case "/api/v2/logistics/ship_order":
      case "/api/v2/logistics/update_shipping_order": {
        const n = String(body.package_number ?? "");
        const o = orderOf(n);
        if (!o)
          return this.shopeeError("logistics.package_number_not_exist", "Please request with package_number.", 200);
        const retry = call.path.endsWith("update_shipping_order");
        if (statusOf(o) !== (retry ? "LOGISTICS_PICKUP_RETRY" : "LOGISTICS_READY")) {
          return this.shopeeError("logistics.error_status", "The order status does not support this operation.", 200);
        }
        if (retry && !body.pickup) return this.shopeeError("error_param", "pickup is required.", 400);
        const problem = arrange(o, n, body);
        return problem ? this.shopeeError("logistics.error_param", problem, 200) : ok({});
      }
      case "/api/v2/logistics/get_mass_tracking_number": {
        const success_list: object[] = [];
        const fail_list: object[] = [];
        for (const n of packages(body.package_list)) {
          const state = this.shopeePackages.get(n);
          if (!state) {
            fail_list.push({ package_number: n, fail_reason: "Package has not arranged shipment." });
          } else if (state.trackingDelay > 0) {
            state.trackingDelay--;
            success_list.push({ package_number: n, tracking_number: "" });
          } else success_list.push({ package_number: n, tracking_number: state.tracking });
        }
        return ok({ response: { success_list, fail_list } });
      }
      case "/api/v2/logistics/get_shipping_document_parameter":
        return batch(
          (body.order_list ?? []).map((o: { order_sn?: string; package_number?: string }) => {
            const state = this.shopeePackages.get(o.package_number ?? "");
            return state && state.trackingDelay === 0
              ? element(o, {
                  suggest_shipping_document_type: "NORMAL_AIR_WAYBILL",
                  selectable_shipping_document_type: ["NORMAL_AIR_WAYBILL", "THERMAL_AIR_WAYBILL"],
                })
              : element(o, {
                  fail_error: "logistics.order_status_error",
                  fail_message: "Order status does not support awb printing.",
                });
          }),
        );
      case "/api/v2/logistics/create_shipping_document":
        return batch(
          (body.order_list ?? []).map(
            (o: {
              order_sn?: string;
              package_number?: string;
              tracking_number?: string;
              shipping_document_type?: string;
            }) => {
              const state = this.shopeePackages.get(o.package_number ?? "");
              if (!state || state.trackingDelay > 0) {
                return element(o, {
                  fail_error: "logistics.order_status_error",
                  fail_message: "Order status does not support awb printing.",
                });
              }
              if (o.tracking_number !== state.tracking) {
                return element(o, {
                  fail_error: "logistics.invalid_tracking_number",
                  fail_message: "Tracking number is invalid.",
                });
              }
              state.document = o.shipping_document_type ?? "NORMAL_AIR_WAYBILL";
              return element(o, {});
            },
          ),
        );
      case "/api/v2/logistics/get_shipping_document_result":
        return batch(
          (body.order_list ?? []).map(
            (o: { order_sn?: string; package_number?: string; shipping_document_type?: string }) => {
              const state = this.shopeePackages.get(o.package_number ?? "");
              return state?.document && state.document === o.shipping_document_type
                ? element(o, { status: "READY" })
                : element(o, {
                    fail_error: "logistics.shipping_document_should_be_created",
                    fail_message: "Please create shipping document first.",
                  });
            },
          ),
        );
      case "/api/v2/logistics/download_shipping_document": {
        const list = (body.order_list ?? []) as { package_number?: string }[];
        const states = list.map((o) => this.shopeePackages.get(o.package_number ?? ""));
        if (states.some((st) => !st?.document || st.document !== body.shipping_document_type)) {
          return this.shopeeError("logistics.shipping_document_not_ready", "The package can not print now.", 200);
        }
        const pdf = await labelPdf(
          states.map((st) => `SPX ${st!.tracking}`),
          100,
          150,
        );
        return { status: 200, body: null, file: pdf };
      }
      default:
        return this.shopeeError("error_param", "Permission denied. The request path is incorrect.", 404);
    }
  }

  private async tiktokDocument(packageId: string): Promise<Reply> {
    const state = this.tiktokPackages.get(packageId);
    if (!state) return { status: 404, body: { message: "not found" } };
    return { status: 200, body: null, file: await labelPdf([`J&T ${state.tracking}`], 105, 148) };
  }

  private issueShopee(shopIds: string[]) {
    const access = token("a");
    const refresh = token("r");
    this.issued.push(access, refresh);
    this.shopeeAccess.set(access, { shopIds, expiresAt: now() + 4 * 3600 });
    this.shopeeRefresh.set(refresh, new Set(shopIds));
    return { access_token: access, refresh_token: refresh, expire_in: 14400 };
  }

  private shopeeTokenGet(body: {
    code?: string;
    partner_id?: number;
    shop_id?: number;
    main_account_id?: number;
  }): Reply {
    if (body.partner_id !== SHOPEE.partnerId) return this.shopeeError("error_param", "partner_id in body", 400);
    const grant = this.shopeeCodes.get(body.code ?? "");
    if (!grant)
      return this.shopeeError("invalid_code", "The code is expired or used or invalid, please check the code.", 400);
    const matches = body.shop_id
      ? grant.shopId === String(body.shop_id)
      : grant.mainAccountId === String(body.main_account_id);
    if (!matches)
      return this.shopeeError(
        "invalid_shop_id",
        "The code or shop_id is wrong, please check the code or the shop_id.",
        400,
      );
    this.shopeeCodes.delete(body.code!);
    const tokens = this.issueShopee(grant.shopIds);
    return {
      status: 200,
      body: {
        error: "",
        message: "",
        request_id: token("rq"),
        ...tokens,
        ...(grant.mainAccountId ? { shop_id_list: grant.shopIds.map(Number), merchant_id_list: [] } : {}),
      },
    };
  }

  private shopeeRefreshToken(body: { refresh_token?: string; partner_id?: number; shop_id?: number }): Reply {
    const shopId = String(body.shop_id);
    const allowed = this.shopeeRefresh.get(body.refresh_token ?? "");
    if (!allowed?.has(shopId)) {
      return this.shopeeError(
        "error_shop_refresh_token",
        "Your refresh token is error ,please check refresh token or shopid.",
        403,
      );
    }
    allowed.delete(shopId);
    return {
      status: 200,
      body: {
        error: "",
        message: "",
        request_id: token("rq"),
        partner_id: SHOPEE.partnerId,
        shop_id: body.shop_id,
        ...this.issueShopee([shopId]),
      },
    };
  }

  // ---- TikTok Shop endpoints ----

  private tiktokReply(code: number, message: string, data: unknown = {}, status = 200): Reply {
    return { status, body: { code, message, request_id: token("rq"), data } };
  }

  private issueTiktok(sellerId: string, user: { openId: string; name: string }) {
    const access = `TTP_${token("a")}`;
    const refresh = `TTP_${token("r")}`;
    const expiresAt = now() + 7 * 86400;
    this.issued.push(access, refresh);
    this.tiktokAccess.set(access, { sellerId, expiresAt });
    this.tiktokRefresh.set(refresh, sellerId);
    return {
      access_token: access,
      access_token_expire_in: expiresAt,
      refresh_token: refresh,
      refresh_token_expire_in: now() + 365 * 86400,
      open_id: user.openId,
      seller_name: user.name,
      seller_base_region: "ID",
      user_type: 0,
      granted_scopes: ["seller.authorization.info", "seller.logistics", "seller.fulfillment.basic"],
    };
  }

  private tiktokToken(call: Call): Reply {
    const q = call.query;
    if (q.app_key !== TIKTOK.appKey || q.app_secret !== TIKTOK.appSecret) {
      return this.tiktokReply(36009004, "Invalid credentials. Invalid app_key query parameter.");
    }
    if (call.path === "/api/v2/token/get") {
      if (q.grant_type !== "authorized_code") return this.tiktokReply(36004004, "Invalid grant_type");
      const sellerId = this.tiktokCodes.get(q.auth_code ?? "");
      if (!sellerId) return this.tiktokReply(36004004, "Invalid auth code.");
      this.tiktokCodes.delete(q.auth_code!);
      return this.tiktokReply(0, "success", this.issueTiktok(sellerId, this.tiktokSellers.get(sellerId)!));
    }
    if (q.grant_type !== "refresh_token") return this.tiktokReply(36004004, "Invalid grant_type");
    const sellerId = this.tiktokRefresh.get(q.refresh_token ?? "");
    if (!sellerId) return this.tiktokReply(36004004, "Invalid refresh token.");
    this.tiktokRefresh.delete(q.refresh_token!);
    return this.tiktokReply(0, "success", this.issueTiktok(sellerId, this.tiktokSellers.get(sellerId)!));
  }

  /** Option images of created items are kept as `img:<image_id>`; they are served like uploads. */
  private optionImage(ref: string): string {
    return ref.startsWith("img:") ? `${this.url}/shopee-img/${ref.slice(4)}` : ref;
  }

  private tiktok(call: Call): Reply | Promise<Reply> {
    const q = call.query;
    const ts = Number(q.timestamp);
    if (q.app_key !== TIKTOK.appKey)
      return this.tiktokReply(36009004, "Invalid credentials. Invalid app_key query parameter.", {}, 401);
    if (!Number.isFinite(ts) || ts < now() - 300 || ts > now() + 30) {
      return this.tiktokReply(36009004, "Invalid timestamp.", {}, 401);
    }
    if (q.access_token !== undefined)
      return this.tiktokReply(36009004, "access_token must be sent in x-tts-access-token", {}, 401);
    const params = Object.keys(q)
      .filter((k) => k !== "sign" && k !== "access_token")
      .sort()
      .map((k) => `${k}${q[k]}`)
      .join("");
    // multipart/form-data bodies are not part of the signature ("Sign your API request")
    const signedBody = call.form ? "" : call.body;
    const expected = hmac(TIKTOK.appSecret, `${TIKTOK.appSecret}${call.path}${params}${signedBody}${TIKTOK.appSecret}`);
    if (q.sign !== expected)
      return this.tiktokReply(106001, "Invalid credentials. The sign query parameter is invalid.", {}, 401);
    const auth = this.tiktokAccess.get(String(call.headers["x-tts-access-token"] ?? ""));
    if (!auth)
      return this.tiktokReply(36009004, "Invalid credentials. The x-tts-access-token header is invalid.", {}, 401);
    if (auth.expiresAt <= now()) return this.tiktokReply(105002, "Expired credentials.", {}, 401);
    const seller = this.tiktokSellers.get(auth.sellerId)!;

    if (call.path === "/authorization/202309/shops") {
      return this.tiktokReply(0, "Success", {
        shops: seller.shops.map((s) => ({
          id: s.id,
          name: s.name,
          region: s.region,
          seller_type: "LOCAL",
          cipher: s.cipher,
          code: `IDLC${s.id.slice(-4)}`,
        })),
      });
    }
    const shop = seller.shops.find((s) => s.cipher === q.shop_cipher);
    if (!shop) return this.tiktokReply(106013, "Missing identifier. The shop_cipher query parameter is required.");
    if (
      /^\/product\/(202309\/(categories|brands|images)|202312\/prerequisites)/.test(call.path) ||
      (call.method === "POST" && call.path === "/product/202309/products")
    ) {
      return tiktokProductCall(
        this.products,
        call,
        shop,
        (code, message, data = {}) => this.tiktokReply(code, message, data),
        (uri) => `${this.url}/tts-img/${encodeURIComponent(uri)}`,
      ).then((r) => r ?? this.tiktokReply(36009009, "Invalid path.", {}, 404));
    }

    if (call.path.startsWith("/return_refund/") && call.path !== "/return_refund/202602/cancellations") {
      const r = tiktokReturnCall(
        this.returns,
        call,
        shop,
        (code, message, data = {}) => this.tiktokReply(code, message, data),
        this.products.tiktokImages,
      );
      if (r) return r;
    }

    switch (`${call.method} ${call.path}`) {
      case "GET /logistics/202309/warehouses":
        return this.tiktokReply(0, "Success", {
          warehouses: shop.warehouses.map((w) => ({
            ...w,
            effect_status: "ENABLED",
            sub_type: "DOMESTIC_WAREHOUSE",
            address: {
              region: "Indonesia",
              region_code: "ID",
              city: "Jakarta",
              contact_person: "Rina",
              phone_number: "0812****",
            },
          })),
        });
      case "POST /product/202502/products/search": {
        const body = JSON.parse(call.body || "{}") as { status?: string; update_time_ge?: number };
        const all = (shop.products ?? []).filter((p) => !body.update_time_ge || p.update_time >= body.update_time_ge);
        const offset = Number(q.page_token ? Buffer.from(q.page_token, "base64url").toString() : 0);
        const size = Number(q.page_size ?? 100);
        const page = all.slice(offset, offset + size);
        return this.tiktokReply(0, "Success", {
          total_count: all.length,
          products: page.map((p) => ({ id: p.id, title: p.title, status: p.status, update_time: p.update_time })),
          next_page_token: offset + size < all.length ? Buffer.from(String(offset + size)).toString("base64url") : "",
        });
      }
      case "POST /product/202309/products/activate":
      case "POST /product/202309/products/deactivate": {
        const body = JSON.parse(call.body) as { product_ids: string[] };
        const activate = call.path.endsWith("/activate");
        const errors: object[] = [];
        for (const id of body.product_ids) {
          const p = (shop.products ?? []).find((x) => x.id === id);
          if (!p) {
            errors.push({
              code: 12052990,
              message: "Batch business error.",
              detail: {
                product_id: id,
                extra_errors: [{ code: 12052048, message: "You can't edit other sellers' products" }],
              },
            });
            continue;
          }
          p.status = activate ? "ACTIVATE" : "SELLER_DEACTIVATED";
          if (p.tokopedia) p.tokopedia = p.status;
          p.update_time = now();
        }
        return this.tiktokReply(0, "Success", { errors });
      }
      case "POST /order/202309/orders/search": {
        const body = JSON.parse(call.body || "{}") as Record<string, number | undefined>;
        const field =
          body.create_time_ge !== undefined || body.create_time_lt !== undefined ? "create_time" : "update_time";
        const ge = body[`${field}_ge`] ?? 0;
        const lt = body[`${field}_lt`] ?? now() + 1;
        const all = (shop.orders ?? [])
          .filter((o) => o[field] >= ge && o[field] < lt)
          .sort((a, b) => a[field] - b[field]);
        const offset = Number(q.page_token ? Buffer.from(q.page_token, "base64url").toString() : 0);
        const size = Number(q.page_size ?? 20);
        if (!(size >= 1 && size <= 100)) return this.tiktokReply(36009001, "page_size must be within [1, 100]");
        const page = all.slice(offset, offset + size);
        return this.tiktokReply(0, "Success", {
          total_count: all.length,
          orders: page,
          next_page_token: offset + size < all.length ? Buffer.from(String(offset + size)).toString("base64url") : "",
        });
      }
      case "GET /order/202507/orders": {
        const ids = (q.ids ?? "").split(",").filter(Boolean);
        if (ids.length < 1 || ids.length > 50) return this.tiktokReply(36009001, "ids must contain 1 to 50 order ids");
        return this.tiktokReply(0, "Success", {
          orders: (shop.orders ?? []).filter((o) => ids.includes(o.id)).map((o) => this.tiktokWithPackages(o)),
        });
      }
      case "POST /return_refund/202602/cancellations": {
        const body = JSON.parse(call.body) as { order_id: string; cancel_reason: string };
        const o = (shop.orders ?? []).find((x) => x.id === body.order_id);
        if (!o) return this.tiktokReply(12052032, "The order does not exist");
        const unpaid = [
          "seller_cancel_unpaid_reason_out_of_stock",
          "seller_cancel_unpaid_reason_wrong_price",
          "seller_cancel_unpaid_reason_buyer_hasnt_paid_within_time_allowed",
        ];
        const paid = ["seller_cancel_reason_out_of_stock", "seller_cancel_reason_wrong_price"];
        const allowed =
          o.status === "UNPAID" ? unpaid : o.status === "ON_HOLD" || o.status === "AWAITING_SHIPMENT" ? paid : [];
        if (!allowed.includes(body.cancel_reason)) return this.tiktokReply(25001021, "Reason not match order status");
        o.status = "CANCELLED";
        o.cancellation_initiator = "SELLER";
        o.cancel_reason = body.cancel_reason;
        o.update_time = now();
        return this.tiktokReply(0, "Success", {
          cancel_id: "4035319218955782461",
          cancel_status: "CANCELLATION_REQUEST_SUCCESS",
        });
      }
      case "GET /fbt/202409/merchants/onboarded_regions":
        return this.tiktokReply(0, "Success", shop.fbt ? { onboarded_regions: [{ region_code: "ID" }] } : {});
      case "GET /fbt/202408/warehouses":
        return this.tiktokReply(0, "Success", {
          warehouses: (shop.fbt ?? []).map((w) => ({ ...w, warehouse_ids: [], addresses: [] })),
        });
      case "GET /event/202309/webhooks": {
        const hooks = this.tiktokWebhooks.get(shop.cipher) ?? new Map();
        return this.tiktokReply(0, "Success", {
          webhooks: [...hooks.entries()].map(([event_type, address]) => ({ event_type, address })),
          total_count: hooks.size,
        });
      }
      case "PUT /event/202309/webhooks": {
        const body = JSON.parse(call.body) as { address: string; event_type: string };
        const hooks = this.tiktokWebhooks.get(shop.cipher) ?? new Map<string, string>();
        hooks.set(body.event_type, body.address);
        this.tiktokWebhooks.set(shop.cipher, hooks);
        return this.tiktokReply(0, "Success");
      }
      default: {
        const pkg =
          /^\/fulfillment\/202309\/packages\/([A-Za-z0-9]+)\/(handover_time_slots|ship|shipping_documents)$/.exec(
            call.path,
          );
        if (pkg) return this.tiktokFulfillment(shop, call, pkg[1]!, pkg[2]!);
        const tracked = /^\/fulfillment\/202309\/orders\/(\d+)\/tracking$/.exec(call.path);
        if (call.method === "GET" && tracked) {
          this.trackingCalls.push(`tiktokshop:${tracked[1]}:`);
          const o = (shop.orders ?? []).find((x) => x.id === tracked[1]);
          if (!o) return this.tiktokReply(21011001, "order is not exist");
          return this.tiktokReply(0, "Success", { tracking: o.tracking ?? [] });
        }
        const inv = /^\/product\/202309\/products\/(\d+)\/inventory\/update$/.exec(call.path);
        if (call.method === "POST" && inv) return this.tiktokInventory(shop, inv[1]!, call.body);
        const m = /^\/product\/202309\/products\/(\d+)$/.exec(call.path);
        if (call.method === "GET" && m) {
          const p = (shop.products ?? []).find((x) => x.id === m[1]);
          if (!p) return this.tiktokReply(12052700, "The product does not exist.");
          return this.tiktokReply(0, "Success", {
            id: p.id,
            title: p.title,
            status: p.status,
            update_time: p.update_time,
            integrated_platform_statuses: p.tokopedia ? [{ platform: "TOKOPEDIA", status: p.tokopedia }] : [],
            main_images: (p.images ?? []).map((u) => ({ uri: `tos-${u.length}`, urls: [u] })),
            package_weight: { value: p.packageWeightKg ?? "0.3", unit: "KILOGRAM" },
            ...(p.dimensions ? { package_dimensions: p.dimensions } : {}),
            description: p.description ?? "",
            category_chains: p.categoryChain ?? [
              { id: "601152", parent_id: "0", local_name: "Pakaian Pria", is_leaf: false },
              { id: "601226", parent_id: "601152", local_name: "Kaos", is_leaf: true },
            ],
            ...(p.brand ? { brand: p.brand } : {}),
            product_attributes: p.attributes ?? [],
            skus: p.skus.map((k) => ({
              id: k.id,
              seller_sku: k.seller_sku ?? "",
              price: { currency: "IDR", tax_exclusive_price: String(k.price) },
              inventory: Object.entries(k.inventory).map(([warehouse_id, quantity]) => ({ warehouse_id, quantity })),
              sales_attributes: Object.entries(k.attrs).map(([name, value_name], i) => ({
                name,
                value_name,
                ...(i === 0 && k.image ? { sku_img: { uri: "tos-sku", urls: [k.image] } } : {}),
              })),
              ...(k.identifier ? { identifier_code: { code: k.identifier, type: "EAN" } } : {}),
              status_info: { status: "NORMAL" },
            })),
          });
        }
        return this.tiktokReply(36009009, "Invalid path.", {}, 404);
      }
    }
  }

  /** Get Order Detail with the package of each line, like TikTok Shop after the order is paid. */
  private tiktokWithPackages(o: MockTiktokOrder) {
    if (o.status === "UNPAID") return { ...o, shipping_type: o.shipping_type ?? "TIKTOK" };
    const id = `PKG${o.id}`;
    const state = this.tiktokPackages.get(id);
    const status =
      o.status === "AWAITING_COLLECTION"
        ? "PROCESSING"
        : o.status === "IN_TRANSIT"
          ? "FULFILLING"
          : o.status === "DELIVERED" || o.status === "COMPLETED"
            ? "COMPLETED"
            : o.status === "CANCELLED"
              ? "CANCELLED"
              : "TO_FULFILL";
    return {
      ...o,
      shipping_type: o.shipping_type ?? "TIKTOK",
      packages: [{ id }],
      tracking_number: state?.tracking ?? o.tracking_number,
      line_items: o.line_items.map((l) => ({
        ...l,
        package_id: id,
        package_status: status,
        ...(state ? { tracking_number: state.tracking, shipping_provider_name: "J&T Express" } : {}),
      })),
    };
  }

  /**
   * Fulfillment 202309 for SEA "schedule shipping": handover slots, Ship Package (PICKUP in an open
   * slot, or DROP_OFF; SELLER shipping needs the seller's tracking number), and the label link.
   */
  private tiktokFulfillment(shop: MockTiktokShop, call: Call, packageId: string, action: string): Reply {
    const o = (shop.orders ?? []).find((x) => `PKG${x.id}` === packageId);
    if (!o || o.status === "UNPAID") {
      return this.tiktokReply(
        21011001,
        "Package not found. If the error persists, please contact the platform for assistance.",
      );
    }
    const tomorrow = Math.floor(now() / 86400) * 86400 + 86400;
    const slots = [
      { start_time: tomorrow + 2 * 3600, end_time: tomorrow + 5 * 3600, avaliable: false },
      { start_time: tomorrow + 6 * 3600, end_time: tomorrow + 10 * 3600, avaliable: true },
    ];
    if (action === "handover_time_slots" && call.method === "GET") {
      return this.tiktokReply(0, "Success", {
        can_pickup: true,
        can_drop_off: true,
        can_van_collection: false,
        pickup_slots: slots,
      });
    }
    if (action === "ship" && call.method === "POST") {
      const body = JSON.parse(call.body || "{}") as {
        handover_method?: string;
        pickup_slot?: { start_time?: number; end_time?: number };
        self_shipment?: { tracking_number?: string };
      };
      if (o.status !== "AWAITING_SHIPMENT") return this.tiktokReply(21011040, "Package has already been shipped.");
      if ((o.shipping_type ?? "TIKTOK") === "SELLER" && !body.self_shipment?.tracking_number) {
        return this.tiktokReply(21011022, "Invalid tracking number or provider ID. Please double check and try again.");
      }
      if (body.handover_method === "PICKUP" && body.pickup_slot) {
        const open = slots.find((x) => x.avaliable && x.start_time === body.pickup_slot!.start_time);
        if (!open)
          return this.tiktokReply(
            21011053,
            "Fail to ship package because the shipment time is outside of the pick-up time slot.",
          );
      } else if (body.handover_method !== "PICKUP" && body.handover_method !== "DROP_OFF") {
        return this.tiktokReply(11001002, "invalid param.");
      }
      this.tiktokPackages.set(packageId, {
        method: body.handover_method,
        tracking: `JX${randomBytes(5).toString("hex").toUpperCase()}`,
      });
      o.status = "AWAITING_COLLECTION";
      o.update_time = now() + 1;
      return this.tiktokReply(0, "Success", {});
    }
    if (action === "shipping_documents" && call.method === "GET") {
      const state = this.tiktokPackages.get(packageId);
      if (!state || o.status !== "AWAITING_COLLECTION") {
        return this.tiktokReply(21011003, "fulfill_unit action not allowed");
      }
      if (
        call.query.document_type !== "SHIPPING_LABEL" ||
        !["A6", "A5", undefined].includes(call.query.document_size)
      ) {
        return this.tiktokReply(11001002, "invalid param.");
      }
      return this.tiktokReply(0, "Success", {
        doc_url: `${this.url}/tts-docs/${packageId}.pdf?expire=${now() + 86400}&sig=${token("s")}`,
        tracking_number: state.tracking,
      });
    }
    return this.tiktokReply(36009009, "Invalid path.", {}, 404);
  }

  /**
   * Update Inventory 202309: every warehouse of a SKU must be sent (12019028), quantities within
   * [0, 99999] (0 for sold out is accepted), fulfillment warehouses refused per SKU (12052382).
   */
  private tiktokInventory(shop: MockTiktokShop, productId: string, rawBody: string): Reply {
    const p = (shop.products ?? []).find((x) => x.id === productId);
    if (!p) return this.tiktokReply(12052032, "The product does not exist");
    if (!["ACTIVATE", "SELLER_DEACTIVATED", "PENDING", "DRAFT", "FAILED"].includes(p.status)) {
      return this.tiktokReply(
        12052901,
        "The product in its current status is not available for this operation. Change the product status and try again.",
      );
    }
    const body = JSON.parse(rawBody) as {
      skus: { id: string; inventory: { warehouse_id?: string; quantity: number }[] }[];
    };
    const errors: object[] = [];
    for (const s of body.skus) {
      const sku = p.skus.find((k) => k.id === s.id);
      if (!sku) return this.tiktokReply(12052556, "The SKU id not exist.");
      const assigned = Object.keys(sku.inventory).sort();
      const sent = s.inventory.map((i) => i.warehouse_id ?? (assigned.length === 1 ? assigned[0]! : "")).sort();
      if (JSON.stringify(assigned) !== JSON.stringify(sent)) {
        return this.tiktokReply(
          12019028,
          "Multiple warehouses detected. Include all warehouse IDs and the corresponding details and try again.",
        );
      }
      const extra = [
        ...s.inventory
          .filter((i) => i.quantity < 0 || i.quantity > 99_999)
          .map((i) => ({
            warehouse_id: i.warehouse_id,
            code: 12052055,
            message: "The SKU inventory quantity for the warehouse must be within allowed limits.",
          })),
        ...s.inventory
          .filter((i) => (shop.fbt ?? []).some((f) => f.fbt_warehouse_id === i.warehouse_id))
          .map((i) => ({
            warehouse_id: i.warehouse_id,
            code: 12052382,
            message: "Can't edit Dilayani Tokopedia warehouse quantity",
          })),
      ];
      if (extra.length > 0) {
        errors.push({
          code: 12052990,
          message: "Batch update inventory error.",
          detail: { sku_id: s.id, extra_errors: extra },
        });
        continue;
      }
      for (const i of s.inventory) sku.inventory[i.warehouse_id ?? assigned[0]!] = i.quantity;
    }
    p.update_time = now();
    return this.tiktokReply(0, "Success", { errors });
  }
}
