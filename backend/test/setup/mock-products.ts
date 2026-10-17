import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * Product creation on the fake marketplaces (FR-PRD-13, backend doc 13.2): the reference data a copy
 * reads (categories, attributes, limits, brands, logistics), image uploads (multipart), and product
 * creation, with the documented rules enforced so tests prove what OmniSeller sends:
 *
 * Shopee: get_attribute_tree takes at most 20 categories, add_item needs uploaded image ids, every
 * mandatory attribute, an enabled logistics channel, and a brand (0 is No Brand); init_tier_variation
 * only takes standardise_tier_variation (the tier_variation structure is deprecated), at most 2 tiers
 * and 50 models, and runs once per item.
 * TikTok Shop: category_version v2, uploaded image uris, title 25 to 255 characters, every required
 * product attribute, seller SKUs without spaces, inventory in one of the shop's warehouses with a
 * quantity of 1 to 99,999 when given, a package weight in kilograms, and an idempotency key that
 * answers a repeated request with the product it created.
 */

// ---- images ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A valid PNG of one colour, as large as a test needs (TikTok Shop wants 300 x 300 for main images). */
export function solidPng(width: number, height: number, rgb: [number, number, number] = [30, 107, 140]): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

/** File type from the first bytes, as the marketplaces check it. */
export function sniffImage(bytes: Uint8Array): "jpeg" | "png" | "webp" | "bmp" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  const text = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
  if (text.startsWith("RIFF") && text.slice(8) === "WEBP") return "webp";
  return null;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// ---- Shopee reference data ----

export const SHOPEE_CATEGORIES = [
  {
    category_id: 100001,
    parent_category_id: 0,
    original_category_name: "Men Clothes",
    display_category_name: "Pakaian Pria",
    has_children: true,
  },
  {
    category_id: 100017,
    parent_category_id: 100001,
    original_category_name: "T-Shirts",
    display_category_name: "Kaos",
    has_children: false,
  },
  {
    category_id: 100018,
    parent_category_id: 100001,
    original_category_name: "Shirts",
    display_category_name: "Kemeja",
    has_children: false,
  },
  {
    category_id: 100002,
    parent_category_id: 0,
    original_category_name: "Fashion Accessories",
    display_category_name: "Aksesoris Fashion",
    has_children: true,
  },
  {
    category_id: 100020,
    parent_category_id: 100002,
    original_category_name: "Hats & Caps",
    display_category_name: "Topi",
    has_children: false,
  },
];

const SHOPEE_CLOTHES_ATTRIBUTES = [
  {
    attribute_id: 100134,
    mandatory: true,
    name: "Material",
    multi_lang: [{ language: "id", value: "Bahan" }],
    attribute_value_list: [
      { value_id: 1234, name: "Cotton", multi_lang: [{ language: "id", value: "Katun" }] },
      { value_id: 1235, name: "Polyester", multi_lang: [{ language: "id", value: "Poliester" }] },
    ],
    attribute_info: { input_type: 2, input_validation_type: 2, format_type: 1, max_value_count: 1 },
  },
  {
    attribute_id: 100037,
    mandatory: true,
    name: "Country of Origin",
    multi_lang: [{ language: "id", value: "Negara Asal" }],
    attribute_value_list: [
      { value_id: 1401, name: "Indonesia", multi_lang: [{ language: "id", value: "Indonesia" }] },
      { value_id: 1402, name: "China", multi_lang: [{ language: "id", value: "Tiongkok" }] },
    ],
    attribute_info: { input_type: 1, input_validation_type: 2, format_type: 1, max_value_count: 1 },
  },
  {
    attribute_id: 100010,
    mandatory: false,
    name: "Net Weight",
    multi_lang: [{ language: "id", value: "Berat Bersih" }],
    attribute_value_list: [],
    attribute_info: { input_type: 3, input_validation_type: 3, format_type: 2, attribute_unit_list: ["g", "kg"] },
  },
];

export const SHOPEE_ATTRIBUTE_TREES: Record<number, typeof SHOPEE_CLOTHES_ATTRIBUTES> = {
  100017: SHOPEE_CLOTHES_ATTRIBUTES,
  100018: SHOPEE_CLOTHES_ATTRIBUTES,
  100020: [{ ...SHOPEE_CLOTHES_ATTRIBUTES[0]!, mandatory: false }],
};

export const SHOPEE_BRANDS = [
  { brand_id: 1123, original_brand_name: "Rajutku", display_brand_name: "Rajutku" },
  { brand_id: 1124, original_brand_name: "Katunku", display_brand_name: "Katunku" },
];

const SHOPEE_LIMITS = {
  price_limit: { min_limit: 99, max_limit: 150_000_000 },
  item_name_length_limit: { min_limit: 10, max_limit: 255 },
  item_image_count_limit: { min_limit: 1, max_limit: 9 },
  item_description_length_limit: { min_limit: 10, max_limit: 3000 },
  tier_variation_name_length_limit: { min_limit: 1, max_limit: 14 },
  tier_variation_option_length_limit: { min_limit: 1, max_limit: 20 },
  dts_limit: { non_pre_order_days_to_ship: 2 },
  weight_limit: { weight_mandatory: true },
  dimension_limit: { dimension_mandatory: false },
  size_chart_limit: { size_chart_mandatory: false, support_image_size_chart: true },
};

export interface MockShopeeChannel {
  logistics_channel_id: number;
  logistics_channel_name: string;
  enabled: boolean;
  fee_type: string;
  mask_channel_id: number;
}

export const SHOPEE_DEFAULT_CHANNELS: MockShopeeChannel[] = [
  {
    logistics_channel_id: 8003,
    logistics_channel_name: "SPX Standard",
    enabled: true,
    fee_type: "SIZE_INPUT",
    mask_channel_id: 0,
  },
  {
    logistics_channel_id: 8005,
    logistics_channel_name: "J&T Express",
    enabled: true,
    fee_type: "FIXED_DEFAULT_PRICE",
    mask_channel_id: 0,
  },
  {
    logistics_channel_id: 80031,
    logistics_channel_name: "SPX Instant",
    enabled: false,
    fee_type: "SIZE_SELECTION",
    mask_channel_id: 0,
  },
];

// ---- TikTok Shop reference data ----

export const TIKTOK_CATEGORIES = [
  { id: "601152", parent_id: "0", local_name: "Pakaian Pria", is_leaf: false, permission_statuses: ["AVAILABLE"] },
  { id: "601226", parent_id: "601152", local_name: "Kaos", is_leaf: true, permission_statuses: ["AVAILABLE"] },
  { id: "601227", parent_id: "601152", local_name: "Kemeja", is_leaf: true, permission_statuses: ["AVAILABLE"] },
  { id: "601300", parent_id: "0", local_name: "Aksesoris", is_leaf: false, permission_statuses: ["AVAILABLE"] },
  { id: "601301", parent_id: "601300", local_name: "Topi", is_leaf: true, permission_statuses: ["AVAILABLE"] },
  { id: "700001", parent_id: "0", local_name: "Obat", is_leaf: true, permission_statuses: ["INVITE_ONLY"] },
];

/** Indonesia: "Imported Goods" (Barang Impor) is required from 27 October 2026, except digital categories. */
export const TIKTOK_ATTRIBUTES = [
  { id: "100000", name: "Warna", type: "SALES_PROPERTY", is_requried: false, values: [] },
  { id: "100089", name: "Ukuran", type: "SALES_PROPERTY", is_requried: false, values: [] },
  {
    id: "102254",
    name: "Barang Impor",
    type: "PRODUCT_PROPERTY",
    is_requried: true,
    values: [
      { id: "1000058", name: "Ya" },
      { id: "1000059", name: "Tidak" },
    ],
    is_customizable: false,
    is_multiple_selection: false,
  },
  {
    id: "100392",
    name: "Bahan",
    type: "PRODUCT_PROPERTY",
    is_requried: false,
    values: [
      { id: "1000040", name: "Katun" },
      { id: "1000041", name: "Poliester" },
    ],
    is_customizable: true,
    is_multiple_selection: true,
  },
  {
    id: "100393",
    name: "Negara Asal",
    type: "PRODUCT_PROPERTY",
    is_requried: false,
    values: [
      { id: "1000100", name: "Indonesia" },
      { id: "1000101", name: "Tiongkok" },
    ],
    is_customizable: false,
    is_multiple_selection: false,
  },
];

export const TIKTOK_BRANDS = [
  {
    id: "7082427311584347905",
    name: "Rajutku",
    authorized_status: "AUTHORIZED",
    brand_status: "AVAILABLE",
    is_t1_brand: false,
  },
  {
    id: "7082427311584347906",
    name: "Katunku",
    authorized_status: "UNAUTHORIEZD",
    brand_status: "AVAILABLE",
    is_t1_brand: false,
  },
  {
    id: "7082427311584347907",
    name: "Merek Global",
    authorized_status: "UNAUTHORIEZD",
    brand_status: "AVAILABLE",
    is_t1_brand: true,
  },
];

// ---- shared state ----

export interface CreatedShopeeItem {
  item_id: number;
  createdAt: number;
  body: Record<string, any>;
  tiers?: Record<string, any>;
}

/** What the product endpoints remember between calls; tests read it to check what was sent. */
export class MockProductState {
  /** Simulate an Indonesian category policy becoming mandatory after a draft was reviewed. */
  tiktokImportedGoodsRequired = true;
  /** Image ids Shopee's media space handed out. */
  readonly shopeeImages = new Set<string>();
  /** Image uris TikTok Shop handed out, with the use case they were uploaded for. */
  readonly tiktokImages = new Map<string, string>();
  /** shop cipher + idempotency key -> the answer Create Product gave. */
  readonly tiktokIdempotency = new Map<string, unknown>();
  /** Items add_item created, by item id. */
  readonly shopeeCreated = new Map<number, CreatedShopeeItem>();
  /** init_tier_variation answers "not ready" this many times. */
  shopeeTiersNotReady = 0;
  /** Reasons Check Listing Prerequisites reports for every TikTok Shop shop. */
  tiktokPrerequisiteFailures: string[] = [];
  /** Create Product refuses with this message once per entry. */
  readonly tiktokCreateFailures: string[] = [];
  private seq = 0;
  next(): number {
    return ++this.seq;
  }
}

export type ShopeeOk = (extra: object) => { status: number; body: unknown };
export type ShopeeFail = (error: string, message: string, status?: number) => { status: number; body: unknown };

const parse = (body: string) => (body ? (JSON.parse(body) as Record<string, any>) : {});

async function imageFrom(form: FormData | undefined, field: string) {
  const file = form?.get(field);
  if (!file || typeof file === "string") return null;
  return new Uint8Array(await file.arrayBuffer());
}

// ---- Shopee endpoints ----

/** Item fields the mock keeps so get_item_base_info and get_model_list answer like Shopee afterwards. */
export interface ShopeeCreatedItemFields {
  item_id: number;
  item_name: string;
  item_sku?: string;
  item_status: "NORMAL";
  update_time: number;
  weight: string;
  images: string[];
  price?: number;
  stock?: number;
  stockByLocation?: Record<string, number>;
  category_id: number;
  description: string;
  attributes: any[];
  brand: { brand_id: number; original_brand_name: string };
  dimension?: { package_length: number; package_width: number; package_height: number };
  logistic_info: any[];
  condition: "NEW" | "USED";
  tiers?: { name: string; options: string[]; images?: (string | null)[] }[];
  models?: {
    model_id: number;
    model_sku?: string;
    tier_index: number[];
    price: number;
    stock: number;
    stockByLocation?: Record<string, number>;
  }[];
}

export async function shopeeProductCall(
  state: MockProductState,
  call: { path: string; query: Record<string, string>; body: string; form?: FormData },
  shop: { items?: unknown[]; channels?: MockShopeeChannel[] },
  ok: ShopeeOk,
  fail: ShopeeFail,
  imageUrl: (id: string) => string,
): Promise<{ status: number; body: unknown } | null> {
  const q = call.query;
  const now = Math.floor(Date.now() / 1000);
  switch (call.path) {
    case "/api/v2/product/get_category":
      return ok({ response: { category_list: SHOPEE_CATEGORIES } });
    case "/api/v2/product/category_recommend": {
      const name = (q.item_name ?? "").toLowerCase();
      if (!name) return fail("error_param", "item_name is required", 400);
      const ids = name.includes("kaos")
        ? [100017, 100018]
        : name.includes("kemeja")
          ? [100018]
          : name.includes("topi")
            ? [100020]
            : [];
      return ok({ response: { category_id: ids } });
    }
    case "/api/v2/product/get_attribute_tree": {
      const ids = (q.category_id_list ?? "").split(",").filter(Boolean).map(Number);
      if (ids.length < 1 || ids.length > 20) return fail("error_param", "category_id_list should be [1,20]", 400);
      return ok({
        response: { list: ids.map((id) => ({ category_id: id, attribute_tree: SHOPEE_ATTRIBUTE_TREES[id] ?? [] })) },
      });
    }
    case "/api/v2/product/get_item_limit":
      if (!q.category_id) return fail("error_param", "category_id is required", 400);
      return ok({ response: SHOPEE_LIMITS });
    case "/api/v2/product/get_brand_list": {
      if (q.status !== "1" && q.status !== "2") return fail("error_param", "status should be 1 or 2", 400);
      const size = Number(q.page_size);
      if (!(size >= 1 && size <= 100)) return fail("error_param", "page_size should be [1,100]", 400);
      const offset = Number(q.offset ?? 0);
      const page = SHOPEE_BRANDS.slice(offset, offset + size);
      return ok({
        response: {
          brand_list: page,
          has_next_page: offset + size < SHOPEE_BRANDS.length,
          next_offset: offset + size,
          is_mandatory: false,
          input_type: "DROP_DOWN",
        },
      });
    }
    case "/api/v2/media_space/upload_image": {
      const bytes = await imageFrom(call.form, "image");
      if (!bytes || bytes.length === 0) return fail("error_param", "image is required", 400);
      if (bytes.length > MAX_IMAGE_BYTES) return fail("error_param", "image size should be less than 10MB", 400);
      const kind = sniffImage(bytes);
      if (kind !== "jpeg" && kind !== "png") return fail("error_param", "image format should be JPG or PNG", 400);
      const scene = call.form?.get("scene");
      if (scene !== null && scene !== "normal" && scene !== "desc") return fail("error_param", "scene invalid", 400);
      const id = `id-11134207-${randomBytes(8).toString("hex")}`;
      state.shopeeImages.add(id);
      return ok({
        response: {
          image_info: {
            image_id: id,
            image_url_list: [
              { image_url_region: "SG", image_url: `https://cf.shopee.sg/file/${id}` },
              { image_url_region: "ID", image_url: imageUrl(id) },
            ],
          },
        },
      });
    }
    case "/api/v2/product/add_item":
      return shopeeAddItem(state, parse(call.body), shop, ok, fail, imageUrl, now);
    case "/api/v2/product/init_tier_variation":
      return shopeeInitTiers(state, parse(call.body), shop, ok, fail, now);
    default:
      return null;
  }
}

function shopeeAddItem(
  state: MockProductState,
  b: Record<string, any>,
  shop: { items?: unknown[]; channels?: MockShopeeChannel[] },
  ok: ShopeeOk,
  fail: ShopeeFail,
  imageUrl: (id: string) => string,
  now: number,
) {
  const bad = (message: string) => fail("product.error_param", message, 400);
  for (const key of ["original_price", "description", "weight", "item_name", "logistic_info", "category_id", "image"]) {
    if (b[key] === undefined) return bad(`Wrong parameters, detail: ${key} is required.`);
  }
  const name = String(b.item_name);
  const lim = SHOPEE_LIMITS;
  if (name.length < lim.item_name_length_limit.min_limit || name.length > lim.item_name_length_limit.max_limit) {
    return bad("item name length is out of limit");
  }
  const description = String(b.description);
  if (description.length < lim.item_description_length_limit.min_limit) return bad("description is too short");
  if (description.length > lim.item_description_length_limit.max_limit) return bad("description is too long");
  if (!(Number(b.original_price) >= lim.price_limit.min_limit)) return bad("price is out of limit");
  if (!Number.isInteger(Number(b.original_price))) return bad("price of IDR must be an integer");
  if (!(Number(b.weight) > 0)) return bad("weight should be greater than 0");
  const category = SHOPEE_CATEGORIES.find((c) => c.category_id === b.category_id);
  if (!category || category.has_children)
    return fail("product.error_category", "category is invalid or not a leaf", 400);
  const images: string[] = b.image?.image_id_list ?? [];
  if (images.length < 1 || images.length > 9) return bad("image_id_list should be [1,9]");
  if (images.some((id) => !state.shopeeImages.has(id))) return fail("product.error_image", "image id is invalid", 400);
  const tree = SHOPEE_ATTRIBUTE_TREES[category.category_id] ?? [];
  const sent = new Map<number, any>((b.attribute_list ?? []).map((a: any) => [a.attribute_id, a]));
  for (const node of tree) {
    if (node.mandatory && !(sent.get(node.attribute_id)?.attribute_value_list ?? []).length) {
      return fail("product.error_attribute", `mandatory attribute ${node.attribute_id} is missing`, 400);
    }
  }
  for (const [id, a] of sent) {
    const node = tree.find((n) => n.attribute_id === id);
    if (!node) return fail("product.error_attribute", `attribute ${id} does not belong to the category`, 400);
    for (const v of a.attribute_value_list ?? []) {
      const known = node.attribute_value_list.some((x) => x.value_id === v.value_id);
      const typed = v.value_id === 0 && [2, 3, 5].includes(node.attribute_info.input_type) && v.original_value_name;
      if (!known && !typed) return fail("product.error_attribute", `value of attribute ${id} is invalid`, 400);
    }
  }
  const channels = shop.channels ?? SHOPEE_DEFAULT_CHANNELS;
  const logistics: any[] = b.logistic_info ?? [];
  if (logistics.length === 0) return fail("logistics.error_param", "logistic_info is required", 400);
  for (const l of logistics) {
    const ch = channels.find((c) => c.logistics_channel_id === l.logistic_id);
    if (!ch?.enabled)
      return fail("logistics.error_param", `logistic ${l.logistic_id} is not enabled for the shop`, 400);
    if (ch.fee_type === "SIZE_SELECTION" && !l.size_id)
      return fail("logistics.error_param", "size_id is required", 400);
  }
  const brand = b.brand ?? { brand_id: 0, original_brand_name: "NoBrand" };
  if (brand.brand_id !== 0 && !SHOPEE_BRANDS.some((x) => x.brand_id === brand.brand_id)) {
    return fail("product.error_brand", "brand is invalid", 400);
  }
  if (b.tier_variation !== undefined) return bad("tier_variation is not supported in add_item");
  const stock: { location_id?: string; stock: number }[] = b.seller_stock ?? [];
  const itemId = 3_000_000 + state.next();
  const fields: ShopeeCreatedItemFields = {
    item_id: itemId,
    item_name: name,
    ...(b.item_sku ? { item_sku: b.item_sku } : {}),
    item_status: "NORMAL",
    update_time: now,
    weight: String(b.weight),
    images: images.map(imageUrl),
    price: Number(b.original_price),
    stock: stock.reduce((n, s) => n + s.stock, 0),
    stockByLocation: Object.fromEntries(stock.map((s) => [s.location_id ?? "", s.stock])),
    category_id: category.category_id,
    description,
    attributes: [...sent.values()],
    brand,
    ...(b.dimension ? { dimension: b.dimension } : {}),
    logistic_info: logistics,
    condition: b.condition === "USED" ? "USED" : "NEW",
  };
  shop.items = [...(shop.items ?? []), fields];
  state.shopeeCreated.set(itemId, { item_id: itemId, createdAt: Date.now(), body: b });
  return ok({ response: { item_id: itemId, item_name: name, item_status: "NORMAL" } });
}

function shopeeInitTiers(
  state: MockProductState,
  b: Record<string, any>,
  shop: { items?: unknown[] },
  ok: ShopeeOk,
  fail: ShopeeFail,
  now: number,
) {
  const created = state.shopeeCreated.get(Number(b.item_id));
  const item = (shop.items as ShopeeCreatedItemFields[] | undefined)?.find((i) => i.item_id === Number(b.item_id));
  if (!created || !item) return fail("error_item_not_found", "item_id is not found", 400);
  if (state.shopeeTiersNotReady > 0) {
    state.shopeeTiersNotReady--;
    return fail("product.error_busi", "The item is not ready, please try again later.", 400);
  }
  if (b.tier_variation !== undefined) {
    return fail("error_param", "tier_variation is deprecated, please use standardise_tier_variation", 400);
  }
  if (created.tiers) return fail("product.error_busi", "tier variation of this item already exists", 400);
  const tiers: any[] = b.standardise_tier_variation ?? [];
  if (tiers.length < 1 || tiers.length > 2)
    return fail("error_param", "standardise_tier_variation should be [1,2]", 400);
  for (const t of tiers) {
    if (t.variation_id !== 0 && t.variation_id === undefined)
      return fail("error_param", "variation_id is required", 400);
    if (!t.variation_name || t.variation_name.length > SHOPEE_LIMITS.tier_variation_name_length_limit.max_limit) {
      return fail("error_param", "variation_name length is out of limit", 400);
    }
    const options: any[] = t.variation_option_list ?? [];
    if (options.length === 0) return fail("error_param", "variation_option_list is required", 400);
    for (const o of options) {
      if (
        !o.variation_option_name ||
        o.variation_option_name.length > SHOPEE_LIMITS.tier_variation_option_length_limit.max_limit
      ) {
        return fail("error_param", "variation option length is out of limit", 400);
      }
      if (o.image_id && !state.shopeeImages.has(o.image_id))
        return fail("product.error_image", "image id is invalid", 400);
    }
  }
  const models: any[] = b.model ?? [];
  if (models.length < 1 || models.length > 50) return fail("error_param", "model should be [1,50]", 400);
  const seen = new Set<string>();
  for (const m of models) {
    const index: number[] = m.tier_index ?? [];
    if (index.length !== tiers.length || index.some((x, k) => !(x >= 0 && x < tiers[k].variation_option_list.length))) {
      return fail("error_param", "tier_index is invalid", 400);
    }
    if (seen.has(index.join(","))) return fail("error_param", "tier_index is duplicated", 400);
    seen.add(index.join(","));
    if (!(Number(m.original_price) > 0) || !Number.isInteger(Number(m.original_price))) {
      return fail("error_param", "original_price is invalid", 400);
    }
    if (!Array.isArray(m.seller_stock)) return fail("error_param", "seller_stock is required", 400);
  }
  created.tiers = b;
  item.tiers = tiers.map((t, k) => ({
    name: t.variation_name,
    options: t.variation_option_list.map((o: any) => o.variation_option_name),
    ...(k === 0 ? { images: t.variation_option_list.map((o: any) => (o.image_id ? `img:${o.image_id}` : null)) } : {}),
  }));
  item.models = models.map((m) => {
    const byLocation = Object.fromEntries(
      (m.seller_stock as { location_id?: string; stock: number }[]).map((s) => [s.location_id ?? "", s.stock]),
    );
    return {
      model_id: 4_000_000 + state.next(),
      ...(m.model_sku ? { model_sku: m.model_sku } : {}),
      tier_index: m.tier_index,
      price: Number(m.original_price),
      stock: Object.values(byLocation).reduce((n, v) => n + v, 0),
      stockByLocation: byLocation,
    };
  });
  delete item.price;
  item.update_time = now;
  return ok({
    response: {
      item_id: item.item_id,
      tier_variation: item.tiers.map((t) => ({ name: t.name, option_list: t.options.map((option) => ({ option })) })),
      model: item.models.map((m) => ({
        model_id: m.model_id,
        tier_index: m.tier_index,
        model_sku: m.model_sku ?? "",
        price_info: [{ original_price: m.price }],
        seller_stock: [],
      })),
    },
  });
}

// ---- TikTok Shop endpoints ----

export type TiktokReply = (code: number, message: string, data?: unknown) => { status: number; body: unknown };

export interface TiktokCreatedProductFields {
  id: string;
  title: string;
  status: "PENDING";
  update_time: number;
  images: string[];
  description: string;
  categoryChain: { id: string; parent_id: string; local_name: string; is_leaf: boolean }[];
  brand?: { id: string; name: string };
  attributes: { id: string; name: string; values: { id?: string; name: string }[] }[];
  packageWeightKg: string;
  dimensions?: { length: string; width: string; height: string; unit: string };
  skus: {
    id: string;
    seller_sku?: string;
    price: number;
    attrs: Record<string, string>;
    inventory: Record<string, number>;
    image?: string;
    identifier?: string;
  }[];
}

export async function tiktokProductCall(
  state: MockProductState,
  call: { method: string; path: string; query: Record<string, string>; body: string; form?: FormData },
  shop: { cipher: string; products?: unknown[]; warehouses: { id: string; type: string }[] },
  reply: TiktokReply,
  imageUrl: (uri: string) => string,
): Promise<{ status: number; body: unknown } | null> {
  const q = call.query;
  const now = Math.floor(Date.now() / 1000);
  const v2 = () => q.category_version === "v2";
  const key = `${call.method} ${call.path}`;
  if (key === "GET /product/202309/categories") {
    if (!v2()) return reply(12019001, "category_version must be v2 for this region");
    return reply(0, "Success", { categories: TIKTOK_CATEGORIES });
  }
  if (key === "POST /product/202309/categories/recommend") {
    const b = parse(call.body);
    if (b.category_version !== "v2") return reply(12019001, "category_version must be v2 for this region");
    const title = String(b.product_title ?? "").toLowerCase();
    const id = title.includes("kaos")
      ? "601226"
      : title.includes("kemeja")
        ? "601227"
        : title.includes("topi")
          ? "601301"
          : null;
    if (!id) return reply(12019015, "No category can be recommended for this product.");
    const leaf = TIKTOK_CATEGORIES.find((c) => c.id === id)!;
    return reply(0, "Success", {
      leaf_category_id: id,
      categories: [
        { id, name: leaf.local_name, level: 2, is_leaf: true, permission_statuses: leaf.permission_statuses },
      ],
    });
  }
  const leaf = /^\/product\/202309\/categories\/(\d+)\/(attributes|rules)$/.exec(call.path);
  if (call.method === "GET" && leaf) {
    if (!v2()) return reply(12019001, "category_version must be v2 for this region");
    const category = TIKTOK_CATEGORIES.find((c) => c.id === leaf[1]);
    if (!category?.is_leaf) return reply(12019003, "The category is not a leaf category.");
    if (leaf[2] === "attributes")
      return reply(0, "Success", {
        attributes: TIKTOK_ATTRIBUTES.map((attribute) =>
          attribute.id === "102254" ? { ...attribute, is_requried: state.tiktokImportedGoodsRequired } : attribute,
        ),
      });
    return reply(0, "Success", {
      product_certifications: [],
      size_chart: { is_supported: true, is_required: false },
      cod: { is_supported: true },
      package_dimension: { is_required: false },
    });
  }
  if (key === "GET /product/202309/brands") {
    if (!q.category_id) return reply(36009001, "category_id is required");
    const size = Number(q.page_size);
    if (!(size >= 1 && size <= 100)) return reply(36009001, "page_size must be within [1, 100]");
    const prefix = (q.brand_name ?? "").toLowerCase();
    return reply(0, "Success", {
      brands: TIKTOK_BRANDS.filter((b) => b.name.toLowerCase().startsWith(prefix)),
      total_count: TIKTOK_BRANDS.length,
      next_page_token: "",
    });
  }
  if (key === "GET /product/202312/prerequisites") {
    return reply(0, "Success", {
      check_results: [
        { check_item: "WAREHOUSE", is_failed: false, fail_reasons: [] },
        {
          check_item: "SHOP_STATUS",
          is_failed: state.tiktokPrerequisiteFailures.length > 0,
          fail_reasons: state.tiktokPrerequisiteFailures,
        },
      ],
    });
  }
  if (key === "POST /product/202309/images/upload") {
    const bytes = await imageFrom(call.form, "data");
    if (!bytes || bytes.length === 0) return reply(12052301, "Zero-byte files are not allowed.");
    if (bytes.length > MAX_IMAGE_BYTES) return reply(12052302, "The image size cannot exceed 10MB.");
    if (!sniffImage(bytes)) return reply(12052303, "The image format is not supported.");
    const useCase = call.form?.get("use_case") ?? "MAIN_IMAGE";
    if (
      !["MAIN_IMAGE", "ATTRIBUTE_IMAGE", "DESCRIPTION_IMAGE", "SIZE_CHART_IMAGE", "CERTIFICATION_IMAGE"].includes(
        String(useCase),
      )
    ) {
      return reply(36009001, "use_case is invalid");
    }
    const uri = `tos-alisg-i-${randomBytes(6).toString("hex")}/${randomBytes(8).toString("hex")}`;
    state.tiktokImages.set(uri, String(useCase));
    return reply(0, "Success", { uri, url: imageUrl(uri), width: 600, height: 600, use_case: useCase });
  }
  if (key === "POST /product/202309/products") return tiktokCreate(state, parse(call.body), shop, reply, imageUrl, now);
  return null;
}

function tiktokCreate(
  state: MockProductState,
  b: Record<string, any>,
  shop: { cipher: string; products?: unknown[]; warehouses: { id: string; type: string }[] },
  reply: TiktokReply,
  imageUrl: (uri: string) => string,
  now: number,
) {
  const idem = b.idempotency_key ? `${shop.cipher}|${b.idempotency_key}` : null;
  if (idem && state.tiktokIdempotency.has(idem)) return reply(0, "Success", state.tiktokIdempotency.get(idem));
  const forced = state.tiktokCreateFailures.shift();
  if (forced) return reply(12052230, forced);
  if (b.category_version !== "v2") return reply(12019001, "category_version must be v2 for this region");
  const category = TIKTOK_CATEGORIES.find((c) => c.id === b.category_id);
  if (!category?.is_leaf) return reply(12019003, "The category is not a leaf category.");
  if (!category.permission_statuses.includes("AVAILABLE"))
    return reply(12052217, "The shop has no permission for this category.");
  const title = String(b.title ?? "");
  if (title.length < 25 || title.length > 255) return reply(12052051, "The product name must be 25 to 255 characters.");
  const description = String(b.description ?? "");
  if (!description || description.length > 10_000) return reply(12052003, "The description is invalid.");
  const images: { uri: string }[] = b.main_images ?? [];
  if (images.length < 1 || images.length > 9) return reply(12052007, "main_images must contain 1 to 9 images.");
  if (images.some((i) => !state.tiktokImages.has(i.uri))) return reply(12052008, "The image uri is invalid.");
  const unit = b.package_weight?.unit;
  if (unit !== "KILOGRAM" || !(Number(b.package_weight?.value) > 0)) {
    return reply(12052181, "The package weight of the product can not be zero.");
  }
  const sent = new Map<string, any>((b.product_attributes ?? []).map((a: any) => [String(a.id), a]));
  for (const a of TIKTOK_ATTRIBUTES.filter((x) => x.type === "PRODUCT_PROPERTY")) {
    const values: any[] = sent.get(a.id)?.values ?? [];
    if (a.is_requried && values.length === 0) return reply(12052061, `The attribute ${a.name} is required.`);
    for (const v of values) {
      const known = v.id && a.values.some((x) => x.id === v.id);
      if (!known && !(a.is_customizable && v.name))
        return reply(12052062, `The value of attribute ${a.name} is invalid.`);
    }
  }
  for (const id of sent.keys()) {
    if (!TIKTOK_ATTRIBUTES.some((a) => a.id === id && a.type === "PRODUCT_PROPERTY")) {
      return reply(12052062, `The attribute ${id} does not belong to the category.`);
    }
  }
  if (b.brand_id) {
    const brand = TIKTOK_BRANDS.find((x) => x.id === b.brand_id);
    if (!brand) return reply(12052200, "brand is invalid");
    if (brand.authorized_status !== "AUTHORIZED" && brand.is_t1_brand)
      return reply(12052201, "brand is not authorized");
  }
  const skus: any[] = b.skus ?? [];
  if (skus.length < 1 || skus.length > 100) return reply(12052040, "skus must contain 1 to 100 SKUs.");
  const names = (s: any) => (s.sales_attributes ?? []).map((a: any) => a.name).join("|");
  if (skus.length > 1 && skus.some((s) => !(s.sales_attributes ?? []).length)) {
    return reply(12052150, "sales attributes are required for a product with several SKUs");
  }
  if (skus.some((s) => names(s) !== names(skus[0])))
    return reply(12052151, "every SKU must have the same sales attributes");
  if ((skus[0].sales_attributes ?? []).length > 3) return reply(12052152, "at most 3 sales attributes");
  const combos = new Set(skus.map((s) => (s.sales_attributes ?? []).map((a: any) => a.value_name).join("|")));
  if (combos.size !== skus.length) return reply(12052153, "duplicate sales attribute values");
  const sellerWarehouses = new Set(shop.warehouses.filter((w) => w.type === "SALES_WAREHOUSE").map((w) => w.id));
  for (const s of skus) {
    if (s.seller_sku !== undefined && !/^\S{1,50}$/.test(s.seller_sku)) {
      return reply(12052054, "The seller SKU must be 1 to 50 characters without spaces.");
    }
    if (!(Number(s.price?.amount) > 0) || s.price?.currency !== "IDR")
      return reply(12052073, "The product price is invalid");
    const inv: any[] = s.inventory ?? [];
    if (inv.length !== 1 || !sellerWarehouses.has(inv[0].warehouse_id)) {
      return reply(12052094, "No multiple warehouse permission");
    }
    if (inv[0].quantity !== undefined && !(inv[0].quantity >= 1 && inv[0].quantity <= 99_999)) {
      return reply(12052055, "The SKU inventory quantity for the warehouse must be within allowed limits.");
    }
    for (const a of s.sales_attributes ?? []) {
      if (a.sku_img && !state.tiktokImages.has(a.sku_img.uri)) return reply(12052008, "The image uri is invalid.");
    }
  }
  const productId = String(1_729_700_000_000_000_000n + BigInt(state.next()));
  const parent = TIKTOK_CATEGORIES.find((c) => c.id === category.parent_id);
  const fields: TiktokCreatedProductFields = {
    id: productId,
    title,
    status: "PENDING",
    update_time: now,
    images: images.map((i) => imageUrl(i.uri)),
    description,
    categoryChain: [
      ...(parent
        ? [{ id: parent.id, parent_id: parent.parent_id, local_name: parent.local_name, is_leaf: false }]
        : []),
      { id: category.id, parent_id: category.parent_id, local_name: category.local_name, is_leaf: true },
    ],
    ...(b.brand_id ? { brand: { id: b.brand_id, name: TIKTOK_BRANDS.find((x) => x.id === b.brand_id)!.name } } : {}),
    attributes: [...sent.values()].map((a) => ({
      id: String(a.id),
      name: TIKTOK_ATTRIBUTES.find((x) => x.id === String(a.id))!.name,
      values: a.values.map((v: any) => ({
        ...(v.id ? { id: v.id } : {}),
        name:
          v.name ?? TIKTOK_ATTRIBUTES.find((x) => x.id === String(a.id))!.values.find((x) => x.id === v.id)?.name ?? "",
      })),
    })),
    packageWeightKg: String(b.package_weight.value),
    ...(b.package_dimensions ? { dimensions: b.package_dimensions } : {}),
    skus: skus.map((s) => ({
      id: String(1_729_800_000_000_000_000n + BigInt(state.next())),
      ...(s.seller_sku ? { seller_sku: s.seller_sku } : {}),
      price: Number(s.price.amount),
      attrs: Object.fromEntries((s.sales_attributes ?? []).map((a: any) => [a.name, a.value_name])),
      inventory: { [s.inventory[0].warehouse_id]: s.inventory[0].quantity ?? 0 },
      ...((s.sales_attributes ?? []).find((a: any) => a.sku_img)
        ? { image: imageUrl((s.sales_attributes ?? []).find((a: any) => a.sku_img).sku_img.uri) }
        : {}),
      ...(s.identifier_code?.code ? { identifier: s.identifier_code.code } : {}),
    })),
  };
  shop.products = [...(shop.products ?? []), fields];
  const data = {
    product_id: productId,
    skus: fields.skus.map((s) => ({
      id: s.id,
      seller_sku: s.seller_sku ?? "",
      sales_attributes: Object.entries(s.attrs).map(([name, value_name]) => ({ name, value_name })),
    })),
    warnings: [],
  };
  if (idem) state.tiktokIdempotency.set(idem, data);
  return reply(0, "Success", data);
}
