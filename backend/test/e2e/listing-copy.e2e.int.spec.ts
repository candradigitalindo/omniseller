import type { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemContext } from "../../src/common/context/request-context";
import { PublishBusyError } from "../../src/modules/listing-copy/copy-worker.service";
import { listingDraftPublishJob } from "../../src/modules/listing-copy/listing-copy.jobs";
import { StoreDataDeletionService } from "../../src/modules/retention/store-data-deletion.service";
import { type Client, client, PASSWORD, signup, startApi, startWorker, tokenFrom, uniqueEmail } from "../setup/app";
import { testHandles } from "../setup/handles";
import { MockMarketplace, type MockShopeeItem, type MockTiktokProduct } from "../setup/mock-marketplace";

/**
 * Copying listings between the seller's stores end to end (PRD FR-PRD-13, backend doc 8.25), against the
 * fake Shopee and TikTok Shop, which enforce the documented product creation rules: categories and
 * attributes, brands, multipart image uploads, add_item with init_tier_variation (standardise tiers),
 * Create Product with its idempotency key, and the listings read back and mapped to the same variants.
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 1_000_000;
let tiktokSeq = 0;

beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  api = await startApi(h.infra, { marketplace: mock });
  worker = await startWorker(h.infra, h.system, { marketplace: mock });
});

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await mock?.close();
});

async function drain(tenantId: string): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < 20; i++) {
    const round = await worker.runOutbox(tenantId);
    if (round.length === 0) break;
    ran.push(...round);
  }
  return ran;
}

async function business() {
  const { c, me } = await signup(api);
  const warehouseId = (await c.get("/v1/warehouses")).body.items[0].id as string;
  return { c, me, tenantId: me.tenant.id as string, warehouseId };
}

async function addMember(owner: Client, tenantId: string, role: string) {
  const roles = (await owner.get("/v1/roles")).body.items as { id: string; name: string }[];
  const email = uniqueEmail(role.toLowerCase());
  const invited = await owner.post("/v1/invitations", { email, roleId: roles.find((r) => r.name === role)!.id });
  expect(invited.status).toBe(201);
  await drain(tenantId);
  const member = client(api);
  const accepted = await member.post("/v1/auth/invitations/accept", {
    token: tokenFrom(worker.email.lastTo(email)!.text),
    name: role,
    password: PASSWORD,
  });
  expect(accepted.status).toBe(201);
  return { member, userId: accepted.body.user?.id as string | undefined };
}

async function connectShopee(c: Client, tenantId: string, items: MockShopeeItem[]) {
  const shopId = String(++shopSeq);
  mock.addShopeeShop({ shopId, name: `Toko ${shopId}`, region: "ID", warehouses: "not_whitelisted", items });
  const started = await c.post("/v1/store-authorizations", { channel: "shopee" });
  await c.post("/v1/store-authorizations/callback", {
    channel: "shopee",
    state: new URL(started.body.authorizeUrl).searchParams.get("state"),
    code: mock.shopeeCode({ shopId }),
    shopId,
  });
  await drain(tenantId);
  const done = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body;
  return { shopId, storeId: done.result.stores[0].storeId as string };
}

async function connectTiktok(c: Client, tenantId: string, products: MockTiktokProduct[], warehouseId: string) {
  const n = ++tiktokSeq;
  const shop = {
    id: `74950000010${String(n).padStart(8, "0")}`,
    name: `Toko TTS ${n}`,
    region: "ID",
    cipher: `ROW_copy_${n}`,
    warehouses: [
      {
        id: `73000000010${String(n).padStart(8, "0")}`,
        name: "Gudang Jakarta",
        type: "SALES_WAREHOUSE" as const,
        is_default: true,
      },
    ],
    products,
  };
  const sellerId = mock.addTiktokSeller({
    openId: `70100000010${String(n).padStart(8, "0")}`,
    name: shop.name,
    shops: [shop],
  });
  const started = await c.post("/v1/store-authorizations", { channel: "tiktokshop" });
  await c.post("/v1/store-authorizations/callback", {
    channel: "tiktokshop",
    state: new URL(started.body.authorizeUrl).searchParams.get("state"),
    code: mock.tiktokCode(sellerId),
  });
  await drain(tenantId);
  const storeId = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body.result.stores[0].storeId as string;
  const cws = (await c.get(`/v1/stores/${storeId}/channel-warehouses`)).body.items as { id: string }[];
  for (const cw of cws) {
    expect((await c.put(`/v1/stores/${storeId}/channel-warehouses/${cw.id}`, { warehouseId })).status).toBe(200);
  }
  return { shop, storeId, warehouse: shop.warehouses[0]!.id };
}

async function goLive(c: Client, storeId: string) {
  expect((await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" })).status).toBe(200);
}

/** The master product KAOS with three variants and their stock in the main warehouse. */
async function kaosProduct(c: Client, warehouseId: string, stock: Record<string, number>) {
  const res = await c.post("/v1/products", {
    sku: "KAOS",
    name: "Kaos Polos",
    attributeNames: ["Warna", "Ukuran"],
    variants: [
      { sku: "KAOS-HTM-M", attributes: { Warna: "Hitam", Ukuran: "M" }, basePrice: 55_000, weightG: 250 },
      { sku: "KAOS-HTM-L", attributes: { Warna: "Hitam", Ukuran: "L" }, basePrice: 57_000, weightG: 260 },
      { sku: "KAOS-PTH-M", attributes: { Warna: "Putih", Ukuran: "M" }, basePrice: 55_000, weightG: 250 },
    ],
  });
  expect(res.status).toBe(201);
  const ids = Object.fromEntries((res.body.variants as { id: string; sku: string }[]).map((v) => [v.sku, v.id]));
  const adjusted = await c.post("/v1/inventory/adjustments", {
    lines: Object.entries(stock).map(([sku, quantity]) => ({
      variantId: ids[sku],
      warehouseId,
      mode: "set",
      quantity,
    })),
    reason: "correction",
  });
  expect(adjusted.status).toBe(200);
  return ids as Record<string, string>;
}

const img = (name: string) => `${mock.url}/img/${name}`;

function shopeeKaos(itemId: number, over: Partial<MockShopeeItem> = {}): MockShopeeItem {
  return {
    item_id: itemId,
    item_name: "Kaos Polos Katun Combed 30s Unisex",
    item_sku: "KAOS",
    item_status: "NORMAL",
    update_time: 1_700_000_000,
    category_id: 100017,
    description: "Kaos polos bahan katun combed 30s.\nNyaman dipakai sehari-hari.",
    weight: "0.25",
    dimension: { package_length: 30, package_width: 20, package_height: 3 },
    images: [img("kaos-1.png"), img("kaos-2.png")],
    attributes: [
      {
        attribute_id: 100134,
        original_attribute_name: "Bahan",
        attribute_value_list: [{ value_id: 1234, original_value_name: "Katun" }],
      },
      {
        attribute_id: 100037,
        original_attribute_name: "Negara Asal",
        attribute_value_list: [{ value_id: 1401, original_value_name: "Indonesia" }],
      },
    ],
    brand: { brand_id: 1123, original_brand_name: "Rajutku" },
    logistic_info: [
      { logistic_id: 8005, enabled: true, is_free: false },
      { logistic_id: 80031, enabled: true, size_id: 2 },
    ],
    tiers: [
      { name: "Warna", options: ["Hitam", "Putih"], images: [img("hitam.png"), img("putih.png")] },
      { name: "Ukuran", options: ["M", "L"] },
    ],
    models: [
      { model_id: 9101, model_sku: "KAOS-HTM-M", tier_index: [0, 0], price: 55_000, stock: 4 },
      { model_id: 9102, model_sku: "KAOS-HTM-L", tier_index: [0, 1], price: 57_000, stock: 1 },
      { model_id: 9103, model_sku: "KAOS-PTH-M", tier_index: [1, 0], price: 55_000, stock: 2 },
    ],
    ...over,
  };
}

function shopeeTopi(itemId: number): MockShopeeItem {
  return {
    item_id: itemId,
    item_name: "Topi Rajut Wol Musim Dingin Premium",
    item_sku: "TOPI-01",
    item_status: "NORMAL",
    update_time: 1_700_000_000,
    category_id: 100020,
    description: "Topi rajut wol yang hangat untuk musim hujan.",
    weight: "0.1",
    images: [img("topi.png")],
    price: 45_000,
    stock: 7,
  };
}

async function listingsOf(c: Client, storeId: string) {
  return (await c.get(`/v1/listings?storeId=${storeId}&limit=200`)).body.items as {
    id: string;
    externalItemId: string;
    externalVariantId: string;
    sku: string | null;
    mapping: { variantId: string; source: string } | null;
  }[];
}

async function draftsOf(c: Client, copyId: string) {
  const res = await c.get(`/v1/listing-drafts?copyId=${copyId}&limit=200`);
  expect(res.status).toBe(200);
  return res.body.items as { id: string; title: string; status: string; blockingProblems: number }[];
}

const recommendCalls = () =>
  mock.calls.filter(
    (c) => c.path === "/product/202309/categories/recommend" || c.path === "/api/v2/product/category_recommend",
  );

describe("copying Shopee listings to Tokopedia & Shop (FR-PRD-13)", () => {
  it("drafts with a recommended category, attributes and brand by name, then publishes with uploaded images and OmniSeller stock", async () => {
    const { c, me, tenantId, warehouseId } = await business();
    const variants = await kaosProduct(c, warehouseId, { "KAOS-HTM-M": 7, "KAOS-HTM-L": 0, "KAOS-PTH-M": 3 });
    const src = await connectShopee(c, tenantId, [shopeeKaos(5101), shopeeTopi(5102)]);
    const dst = await connectTiktok(c, tenantId, [], warehouseId);
    await goLive(c, dst.storeId);
    const listings = await listingsOf(c, src.storeId);
    expect(
      listings
        .filter((l) => l.mapping)
        .map((l) => l.sku)
        .sort(),
    ).toEqual(["KAOS-HTM-L", "KAOS-HTM-M", "KAOS-PTH-M"]);

    const requested = await c.post("/v1/listing-copies", {
      sourceStoreId: src.storeId,
      listingIds: listings.map((l) => l.id),
      targetStoreIds: [dst.storeId],
    });
    expect(requested.status).toBe(202);
    expect(requested.body.items).toHaveLength(1);
    const copy = requested.body.items[0];
    expect(copy).toMatchObject({
      scope: "items",
      status: "preparing",
      itemsTotal: 2,
      sourceStore: { id: src.storeId, channelName: "Shopee" },
      targetStore: { id: dst.storeId, channelName: "Tokopedia & Shop" },
    });
    expect(await drain(tenantId)).toContain("listing_copy.prepare");
    expect((await c.get(`/v1/listing-copies/${copy.id}`)).body).toMatchObject({
      status: "ready",
      itemsDrafted: 2,
      itemsSkipped: 0,
      itemsFailed: 0,
      drafts: { draft: 2 },
    });
    // TikTok Shop recommended the categories, told where the products sit on Shopee
    const recommended = mock.callsTo("POST", "/product/202309/categories/recommend").map((x) => JSON.parse(x.body));
    expect(recommended[0]).toMatchObject({
      product_title: "Kaos Polos Katun Combed 30s Unisex",
      category_version: "v2",
      origin_platform_category: { id: "100017", name: "Kaos", full_name: "Pakaian Pria > Kaos" },
      origin_platform_vendor: "Rajutku",
    });

    const drafts = await draftsOf(c, copy.id);
    const kaos = (await c.get(`/v1/listing-drafts/${drafts.find((d) => d.title.startsWith("Kaos"))!.id}`)).body;
    const topi = (await c.get(`/v1/listing-drafts/${drafts.find((d) => d.title.startsWith("Topi"))!.id}`)).body;
    expect(kaos).toMatchObject({
      status: "draft",
      externalCategoryId: "601226",
      categoryPath: "Pakaian Pria > Kaos",
      brand: { brandId: "7082427311584347905", name: "Rajutku" },
      descriptionHtml: null,
      weightG: 250,
      dimensionsMm: { length: 300, width: 200, height: 30 },
      variationNames: ["Warna", "Ukuran"],
      source: { channel: "shopee", categoryId: "100017", categoryPath: "Pakaian Pria > Kaos", brand: "Rajutku" },
    });
    expect(kaos.attributes).toEqual([
      { attributeId: "100392", name: "Bahan", values: [{ valueId: "1000040", name: "Katun", unit: null }] },
      { attributeId: "100393", name: "Negara Asal", values: [{ valueId: "1000100", name: "Indonesia", unit: null }] },
    ]);
    expect(
      kaos.variants.map((v: { sku: string; variantId: string; price: number }) => [v.sku, v.variantId, v.price]),
    ).toEqual([
      ["KAOS-HTM-M", variants["KAOS-HTM-M"], 55_000],
      ["KAOS-HTM-L", variants["KAOS-HTM-L"], 57_000],
      ["KAOS-PTH-M", variants["KAOS-PTH-M"], 55_000],
    ]);
    // Indonesia: "Barang Impor" is required (27 October 2026); the unmapped Topi warns about its stock
    expect(kaos.problems).toEqual([
      expect.objectContaining({ code: "attribute_required", field: "attributes.102254", blocking: true }),
    ]);
    expect(topi.categoryPath).toBe("Aksesoris > Topi");
    expect(topi.problems.map((p: { code: string }) => p.code)).toEqual(["attribute_required", "variant_unmapped"]);

    const early = await c.post("/v1/listing-drafts/publish", { draftIds: [kaos.id] });
    expect(early.status).toBe(202);
    expect(early.body).toMatchObject({
      queued: [],
      refused: [{ draftId: kaos.id, code: "listing_draft.has_problems" }],
    });

    const set = await c.post("/v1/listing-drafts/attributes", {
      draftIds: [kaos.id, topi.id],
      attributeId: "102254",
      values: [{ valueId: "1000059" }],
    });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ updated: [kaos.id, topi.id].sort(), skipped: [] });
    const wrongValue = await c.post("/v1/listing-drafts/attributes", {
      draftIds: [kaos.id],
      attributeId: "102254",
      values: [{ name: "Mungkin" }],
    });
    expect(wrongValue.body.skipped).toEqual([{ draftId: kaos.id, reason: "Atribut ini tidak ada di kategori draf." }]);

    // edits with If-Match: a stale version is refused
    const etag = String((await c.get(`/v1/listing-drafts/${topi.id}`)).headers.etag);
    const edited = await c
      .patch(`/v1/listing-drafts/${topi.id}`, {
        title: "Topi Rajut Wol Hangat Musim Hujan",
        variants: [{ key: "v1", price: 47_000 }],
      })
      .set("If-Match", etag);
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ title: "Topi Rajut Wol Hangat Musim Hujan", variants: [{ price: 47_000 }] });
    expect((await c.patch(`/v1/listing-drafts/${topi.id}`, { title: "basi" }).set("If-Match", etag)).status).toBe(409);
    const tooShort = await c.patch(`/v1/listing-drafts/${topi.id}`, { title: "Topi" });
    expect(tooShort.body.problems[0]).toMatchObject({ code: "title_length", blocking: true });
    await c.patch(`/v1/listing-drafts/${topi.id}`, { title: "Topi Rajut Wol Hangat Musim Hujan" });

    const published = await c.post("/v1/listing-drafts/publish", { draftIds: [kaos.id, topi.id] });
    expect(published.body).toEqual({ queued: [kaos.id, topi.id].sort(), refused: [] });
    const ran = await drain(tenantId);
    expect(ran.filter((j) => j === "listing_draft.publish")).toHaveLength(2);
    expect(ran).toContain("stock.listing_mapped");
    // the worker published what the seller asked for: the log names the seller (backend doc 8.28)
    const draftAudit = (await c.get("/v1/audit-logs?entity_type=listing_draft")).body.items as {
      actorId: string | null;
      changes: { field: string; after: unknown }[];
    }[];
    const publishedEntries = draftAudit.filter((e) =>
      e.changes.some((ch) => ch.field === "status" && ch.after === "published"),
    );
    expect(publishedEntries).toHaveLength(2);
    expect(publishedEntries.every((e) => e.actorId === me.user.id)).toBe(true);

    // images: downloaded from the source's host and uploaded as multipart to TikTok Shop
    const uploads = mock.callsTo("POST", "/product/202309/images/upload");
    expect(uploads.map((u) => u.form?.get("use_case")).sort()).toEqual([
      "ATTRIBUTE_IMAGE",
      "ATTRIBUTE_IMAGE",
      "MAIN_IMAGE",
      "MAIN_IMAGE",
      "MAIN_IMAGE",
    ]);
    const created = mock.callsTo("POST", "/product/202309/products").map((x) => JSON.parse(x.body));
    const kaosBody = created.find((b) => b.title.startsWith("Kaos"))!;
    expect(kaosBody).toMatchObject({
      save_mode: "LISTING",
      idempotency_key: `${kaos.id}-1`,
      category_id: "601226",
      category_version: "v2",
      brand_id: "7082427311584347905",
      description: "<p>Kaos polos bahan katun combed 30s.</p><p>Nyaman dipakai sehari-hari.</p>",
      package_weight: { value: "0.25", unit: "KILOGRAM" },
      package_dimensions: { length: "30", width: "20", height: "3", unit: "CENTIMETER" },
    });
    expect(kaosBody.main_images).toHaveLength(2);
    expect(kaosBody.product_attributes).toEqual(
      expect.arrayContaining([
        { id: "102254", values: [{ id: "1000059" }] },
        { id: "100392", values: [{ id: "1000040" }] },
        { id: "100393", values: [{ id: "1000100" }] },
      ]),
    );
    // stock is what OmniSeller would push to this store: 7, nothing (0), 3
    expect(
      kaosBody.skus.map(
        (s: {
          seller_sku: string;
          inventory: { warehouse_id: string; quantity?: number }[];
          sales_attributes: { sku_img?: unknown }[];
        }) => [
          s.seller_sku,
          s.inventory[0]!.warehouse_id,
          s.inventory[0]!.quantity ?? 0,
          s.sales_attributes[0]!.sku_img !== undefined,
        ],
      ),
    ).toEqual([
      ["KAOS-HTM-M", dst.warehouse, 7, true],
      ["KAOS-HTM-L", dst.warehouse, 0, true],
      ["KAOS-PTH-M", dst.warehouse, 3, true],
    ]);
    const topiBody = created.find((b) => b.title.startsWith("Topi"))!;
    expect(topiBody.skus).toEqual([
      expect.objectContaining({
        seller_sku: "TOPI-01",
        price: { amount: "47000", currency: "IDR" },
        inventory: [{ warehouse_id: dst.warehouse }],
      }),
    ]);
    expect(topiBody.skus[0].sales_attributes).toBeUndefined();

    const after = await draftsOf(c, copy.id);
    expect(after.map((d) => d.status)).toEqual(["published", "published"]);
    // the new listings are mapped to the variants they were copied from
    const targetListings = await listingsOf(c, dst.storeId);
    expect(
      targetListings
        .filter((l) => l.mapping)
        .map((l) => [l.sku, l.mapping!.variantId, l.mapping!.source])
        .sort(),
    ).toEqual([
      ["KAOS-HTM-L", variants["KAOS-HTM-L"], "copied"],
      ["KAOS-HTM-M", variants["KAOS-HTM-M"], "copied"],
      ["KAOS-PTH-M", variants["KAOS-PTH-M"], "copied"],
    ]);
    expect(targetListings.filter((l) => !l.mapping).map((l) => l.sku)).toEqual(["TOPI-01"]);

    // the whole store again: Kaos is listed there already, Topi was published before; the category
    // chosen for Topi is remembered, so TikTok Shop is not asked again
    const asked = recommendCalls().length;
    const again = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] });
    expect(again.body.items[0]).toMatchObject({ scope: "store", itemsTotal: 2 });
    await drain(tenantId);
    expect((await c.get(`/v1/listing-copies/${again.body.items[0].id}`)).body).toMatchObject({
      status: "ready",
      itemsDrafted: 1,
      itemsSkipped: 1,
    });
    expect(recommendCalls().length).toBe(asked);
    const [second] = await draftsOf(c, again.body.items[0].id);
    const secondDetail = (await c.get(`/v1/listing-drafts/${second!.id}`)).body;
    expect(secondDetail).toMatchObject({ externalCategoryId: "601301" });
    expect(secondDetail.problems.map((p: { code: string }) => p.code)).toContain("already_published");
  });
});

describe("copying Tokopedia & Shop to Shopee, and Shopee to Shopee", () => {
  it("maps HTML to text, values by name, the brand, and creates the item with its tiers", async () => {
    const { c, tenantId, warehouseId } = await business();
    const variants = await kaosProduct(c, warehouseId, { "KAOS-HTM-M": 5, "KAOS-HTM-L": 2, "KAOS-PTH-M": 0 });
    const product: MockTiktokProduct = {
      id: "1729700000001000001",
      title: "Kaos Polos Katun Combed 30s Unisex",
      status: "ACTIVATE",
      update_time: 1_700_000_000,
      images: [img("tts-kaos.png")],
      description: "<p>Kaos <b>adem</b> &amp; nyaman.</p><ul><li>Katun</li></ul>",
      brand: { id: "7082427311584347905", name: "Rajutku" },
      attributes: [
        { id: "100392", name: "Bahan", values: [{ id: "1000040", name: "Katun" }] },
        { id: "100393", name: "Negara Asal", values: [{ id: "1000101", name: "Tiongkok" }] },
      ],
      packageWeightKg: "0.3",
      skus: [
        {
          id: "1729800000001000001",
          seller_sku: "KAOS-HTM-M",
          price: 59_000,
          attrs: { Warna: "Hitam", Ukuran: "M" },
          inventory: {},
          image: img("tts-hitam.png"),
        },
        {
          id: "1729800000001000002",
          seller_sku: "KAOS-HTM-L",
          price: 61_000,
          attrs: { Warna: "Hitam", Ukuran: "L" },
          inventory: {},
        },
        {
          id: "1729800000001000003",
          seller_sku: "KAOS-PTH-M",
          price: 59_000,
          attrs: { Warna: "Putih", Ukuran: "M" },
          inventory: {},
          image: img("tts-putih.png"),
        },
      ],
    };
    const src = await connectTiktok(c, tenantId, [product], warehouseId);
    const dst = await connectShopee(c, tenantId, []);
    await goLive(c, dst.storeId);
    const listings = await listingsOf(c, src.storeId);
    expect(listings.filter((l) => l.mapping)).toHaveLength(3);

    const res = await c.post("/v1/listing-copies", {
      sourceStoreId: src.storeId,
      listingIds: [listings[0]!.id],
      targetStoreIds: [dst.storeId],
      priceChangePercent: 10,
    });
    expect(res.status).toBe(202);
    await drain(tenantId);
    const [draft] = await draftsOf(c, res.body.items[0].id);
    const d = (await c.get(`/v1/listing-drafts/${draft!.id}`)).body;
    expect(d).toMatchObject({
      externalCategoryId: "100017",
      categoryPath: "Pakaian Pria > Kaos",
      brand: { brandId: "1123", name: "Rajutku" },
      description: "Kaos adem & nyaman.\n- Katun",
      descriptionHtml: null,
      weightG: 300,
      problems: [],
    });
    expect(d.attributes).toEqual([
      { attributeId: "100134", name: "Bahan", values: [{ valueId: "1234", name: "Katun", unit: null }] },
      { attributeId: "100037", name: "Negara Asal", values: [{ valueId: "1402", name: "Tiongkok", unit: null }] },
    ]);
    // +10%, rounded to hundreds
    expect(d.variants.map((v: { price: number }) => v.price)).toEqual([64_900, 67_100, 64_900]);

    expect((await c.post("/v1/listing-drafts/publish", { draftIds: [d.id] })).body.queued).toEqual([d.id]);
    await drain(tenantId);
    const add = JSON.parse(mock.callsTo("POST", "/api/v2/product/add_item").at(-1)!.body);
    expect(add).toMatchObject({
      item_name: "Kaos Polos Katun Combed 30s Unisex",
      description: "Kaos adem & nyaman.\n- Katun",
      original_price: 64_900,
      weight: 0.3,
      category_id: 100017,
      brand: { brand_id: 1123, original_brand_name: "Rajutku" },
      condition: "NEW",
      // no package size: only the fixed-fee checkout channel needs nothing else
      logistic_info: [{ logistic_id: 8005, enabled: true }],
      attribute_list: [
        { attribute_id: 100134, attribute_value_list: [{ value_id: 1234 }] },
        { attribute_id: 100037, attribute_value_list: [{ value_id: 1402 }] },
      ],
    });
    expect(add.image.image_id_list).toHaveLength(1);
    const tiers = JSON.parse(mock.callsTo("POST", "/api/v2/product/init_tier_variation").at(-1)!.body);
    expect(
      tiers.standardise_tier_variation[0].variation_option_list.map((o: { image_id?: string }) => !!o.image_id),
    ).toEqual([true, true]);
    // stock without a location (shop without multi-warehouse): 5, 2, 0
    expect(tiers.model.map((m: { seller_stock: unknown }) => m.seller_stock)).toEqual([
      [{ stock: 5 }],
      [{ stock: 2 }],
      [{ stock: 0 }],
    ]);
    expect((await c.get(`/v1/listing-drafts/${d.id}`)).body.status).toBe("published");
    const mapped = (await listingsOf(c, dst.storeId)).filter((l) => l.mapping?.source === "copied");
    expect(mapped.map((l) => l.mapping!.variantId).sort()).toEqual(Object.values(variants).sort());
  });

  it("keeps category, attributes, brand, and enabled logistics within Shopee", async () => {
    const { c, tenantId, warehouseId } = await business();
    await kaosProduct(c, warehouseId, { "KAOS-HTM-M": 1, "KAOS-HTM-L": 1, "KAOS-PTH-M": 1 });
    const src = await connectShopee(c, tenantId, [shopeeKaos(5201)]);
    const dst = await connectShopee(c, tenantId, []);
    await goLive(c, dst.storeId);
    const asked = recommendCalls().length;
    const res = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] });
    await drain(tenantId);
    const [draft] = await draftsOf(c, res.body.items[0].id);
    const d = (await c.get(`/v1/listing-drafts/${draft!.id}`)).body;
    expect(d).toMatchObject({ externalCategoryId: "100017", brand: { brandId: "1123" }, problems: [] });
    // no recommendation within the same marketplace
    expect(recommendCalls().length).toBe(asked);
    await c.post("/v1/listing-drafts/publish", { draftIds: [d.id] });
    await drain(tenantId);
    const add = JSON.parse(mock.callsTo("POST", "/api/v2/product/add_item").at(-1)!.body);
    // the source's channels the target has enabled (80031 is off there)
    expect(add.logistic_info).toEqual([{ logistic_id: 8005, enabled: true, is_free: false }]);
    expect(add.attribute_list).toEqual([
      { attribute_id: 100134, attribute_value_list: [{ value_id: 1234 }] },
      { attribute_id: 100037, attribute_value_list: [{ value_id: 1401 }] },
    ]);
  });
});

describe("publishing failures and recovery", () => {
  it("shows the marketplace's refusal, and publishes again after an edit with a new idempotency key", async () => {
    const { c, tenantId, warehouseId } = await business();
    await kaosProduct(c, warehouseId, { "KAOS-HTM-M": 1, "KAOS-HTM-L": 1, "KAOS-PTH-M": 1 });
    const src = await connectShopee(c, tenantId, [shopeeKaos(5301)]);
    const dst = await connectTiktok(c, tenantId, [], warehouseId);
    const res = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] });
    await drain(tenantId);
    const [draft] = await draftsOf(c, res.body.items[0].id);
    // a store still in parallel mode: published with stock 0
    const d = (await c.get(`/v1/listing-drafts/${draft!.id}`)).body;
    expect(d.problems.map((p: { code: string }) => p.code)).toEqual(["attribute_required", "store_read_only"]);
    await c.post("/v1/listing-drafts/attributes", {
      draftIds: [d.id],
      attributeId: "102254",
      values: [{ valueId: "1000058" }],
    });

    mock.products.tiktokCreateFailures.push("The product name contains restricted words.");
    await c.post("/v1/listing-drafts/publish", { draftIds: [d.id] });
    await drain(tenantId);
    const failed = (await c.get(`/v1/listing-drafts/${d.id}`)).body;
    expect(failed).toMatchObject({
      status: "failed",
      error: "Tokopedia & Shop menolak produk ini: The product name contains restricted words.",
    });
    const edited = await c.patch(`/v1/listing-drafts/${d.id}`, { title: "Kaos Polos Katun Combed Unisex Premium" });
    expect(edited.body.status).toBe("draft");
    // the images were uploaded by the failed attempt: they are not uploaded again
    expect(edited.body.images.every((i: { uploaded: boolean }) => i.uploaded)).toBe(true);
    const uploads = mock.callsTo("POST", "/product/202309/images/upload").length;
    await c.post("/v1/listing-drafts/publish", { draftIds: [d.id] });
    await drain(tenantId);
    expect(mock.callsTo("POST", "/product/202309/images/upload").length).toBe(uploads);
    expect((await c.get(`/v1/listing-drafts/${d.id}`)).body).toMatchObject({ status: "published", publishAttempt: 2 });
    const bodies = mock.callsTo("POST", "/product/202309/products").map((x) => JSON.parse(x.body));
    expect(bodies.filter((b) => b.idempotency_key.startsWith(d.id)).map((b) => b.idempotency_key)).toEqual([
      `${d.id}-1`,
      `${d.id}-2`,
    ]);
    const created = bodies.find((b) => b.idempotency_key === `${d.id}-2`)!;
    expect(
      created.skus.every((s: { inventory: { quantity?: number }[] }) => s.inventory[0]!.quantity === undefined),
    ).toBe(true);
  });

  it("continues a Shopee item whose variations failed, without creating the item twice", async () => {
    const { c, tenantId, warehouseId } = await business();
    await kaosProduct(c, warehouseId, { "KAOS-HTM-M": 1, "KAOS-HTM-L": 1, "KAOS-PTH-M": 1 });
    const src = await connectShopee(c, tenantId, [shopeeKaos(5401)]);
    const dst = await connectShopee(c, tenantId, []);
    const res = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] });
    await drain(tenantId);
    const [draft] = await draftsOf(c, res.body.items[0].id);
    const before = mock.callsTo("POST", "/api/v2/product/add_item").length;
    mock.products.shopeeTiersNotReady = 1;
    await c.post("/v1/listing-drafts/publish", { draftIds: [draft!.id] });
    await drain(tenantId);
    const failed = (await c.get(`/v1/listing-drafts/${draft!.id}`)).body;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("Shopee membuat produknya tetapi menolak variasinya");
    await c.post("/v1/listing-drafts/publish", { draftIds: [draft!.id] });
    await drain(tenantId);
    expect((await c.get(`/v1/listing-drafts/${draft!.id}`)).body.status).toBe("published");
    expect(mock.callsTo("POST", "/api/v2/product/add_item").length).toBe(before + 1);
    const mapped = (await listingsOf(c, dst.storeId)).filter((l) => l.mapping?.source === "copied");
    expect(mapped).toHaveLength(3);
  });

  it("publishes more drafts at once than the worker has database connections, one run per draft", async () => {
    const { c, tenantId, warehouseId } = await business();
    // every item's variants map to the same three master variants
    await kaosProduct(c, warehouseId, { "KAOS-HTM-M": 9, "KAOS-HTM-L": 9, "KAOS-PTH-M": 9 });
    const items = Array.from({ length: 12 }, (_, i) =>
      shopeeKaos(5900 + i, { item_name: `Kaos Polos Katun Combed 30s Seri ${i + 1}`, item_sku: `SERI-${i}` }),
    );
    const src = await connectShopee(c, tenantId, items);
    const dst = await connectTiktok(c, tenantId, [], warehouseId);
    const res = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] });
    await drain(tenantId);
    const ids = (await draftsOf(c, res.body.items[0].id)).map((d) => d.id);
    expect(ids).toHaveLength(12);
    await c.post("/v1/listing-drafts/attributes", {
      draftIds: ids,
      attributeId: "102254",
      values: [{ valueId: "1000059" }],
    });
    expect((await c.post("/v1/listing-drafts/publish", { draftIds: ids })).body.queued).toHaveLength(12);
    const before = mock.callsTo("POST", "/product/202309/products").length;
    // as BullMQ runs them: twelve at once (the pool has ten connections), and a second run of the first
    const runs = [...ids, ids[0]!].map((draftId) =>
      worker.runJob(listingDraftPublishJob, { draftId, attempt: 1 }, tenantId).then(
        () => "done",
        (err: unknown) => (err instanceof PublishBusyError ? "busy" : Promise.reject(err)),
      ),
    );
    const outcomes = await Promise.all(runs);
    expect(outcomes.filter((o) => o === "busy").length).toBeLessThanOrEqual(1);
    expect(mock.callsTo("POST", "/product/202309/products").length - before).toBe(12);
    // the queued jobs find them published
    await drain(tenantId);
    expect(mock.callsTo("POST", "/product/202309/products").length - before).toBe(12);
    expect((await draftsOf(c, res.body.items[0].id)).every((d) => d.status === "published")).toBe(true);
    // every new listing is mapped as copied: no other run's SKU matching got there first
    const sources = (await listingsOf(c, dst.storeId)).map((l) => l.mapping?.source);
    expect(sources).toHaveLength(36);
    expect(new Set(sources)).toEqual(new Set(["copied"]));
  }, 120_000);

  it("takes over a publish whose run stopped, and leaves one that is still running alone", async () => {
    const { c, tenantId, warehouseId } = await business();
    const src = await connectShopee(c, tenantId, [shopeeKaos(6001)]);
    const dst = await connectTiktok(c, tenantId, [], warehouseId);
    const res = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] });
    await drain(tenantId);
    const [draft] = await draftsOf(c, res.body.items[0].id);
    await c.post("/v1/listing-drafts/attributes", {
      draftIds: [draft!.id],
      attributeId: "102254",
      values: [{ valueId: "1000059" }],
    });
    await c.post("/v1/listing-drafts/publish", { draftIds: [draft!.id] });
    const claimedAgo = (minutes: number) =>
      h.system.db.execute(
        sql`UPDATE listing_draft SET publishing_started_at = now() - make_interval(mins => ${minutes}) WHERE id = ${draft!.id}`,
      );
    const before = mock.callsTo("POST", "/product/202309/products").length;
    // a run claimed it a minute ago and is still working: the last attempt leaves it alone
    await claimedAgo(1);
    await worker.runJob(listingDraftPublishJob, { draftId: draft!.id, attempt: 1 }, tenantId, 4);
    expect((await c.get(`/v1/listing-drafts/${draft!.id}`)).body.status).toBe("publishing");
    // a run that stopped four minutes ago: its claim has lapsed and the retry publishes
    await claimedAgo(4);
    await worker.runJob(listingDraftPublishJob, { draftId: draft!.id, attempt: 1 }, tenantId, 2);
    expect((await c.get(`/v1/listing-drafts/${draft!.id}`)).body.status).toBe("published");
    expect(mock.callsTo("POST", "/product/202309/products").length - before).toBe(1);
  });

  it("refuses images from other hosts and formats the target does not take, and TikTok Shop's prerequisites", async () => {
    const { c, tenantId, warehouseId } = await business();
    const src = await connectShopee(c, tenantId, [
      shopeeKaos(5501, {
        item_name: "Kaos Polos Katun Combed 30s Hitam Polos",
        images: ["https://evil.example.com/kaos.png", img("kaos-1.webp"), img("kaos-1.png")],
        tiers: undefined,
        models: undefined,
        price: 50_000,
        stock: 1,
        item_sku: "KAOS-SINGLE",
      }),
    ]);
    const dst = await connectShopee(c, tenantId, []);
    const res = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] });
    await drain(tenantId);
    const [draft] = await draftsOf(c, res.body.items[0].id);
    await c.post("/v1/listing-drafts/publish", { draftIds: [draft!.id] });
    await drain(tenantId);
    let d = (await c.get(`/v1/listing-drafts/${draft!.id}`)).body;
    expect(d).toMatchObject({ status: "failed" });
    expect(d.error).toMatch(/^Foto 1: Foto dari evil\.example\.com tidak bisa diambil/);
    expect(mock.imageDownloads.some((p) => p.includes("evil"))).toBe(false);
    // removing it leaves the WebP, which Shopee refuses
    await c.patch(`/v1/listing-drafts/${draft!.id}`, { images: [img("kaos-1.webp"), img("kaos-1.png")] });
    await c.post("/v1/listing-drafts/publish", { draftIds: [draft!.id] });
    await drain(tenantId);
    d = (await c.get(`/v1/listing-drafts/${draft!.id}`)).body;
    expect(d.error).toContain("Format WEBP tidak diterima Shopee");
    await c.patch(`/v1/listing-drafts/${draft!.id}`, { images: [img("kaos-1.png")] });
    await c.post("/v1/listing-drafts/publish", { draftIds: [draft!.id] });
    await drain(tenantId);
    expect((await c.get(`/v1/listing-drafts/${draft!.id}`)).body.status).toBe("published");

    // TikTok Shop says the shop cannot list yet
    const tts = await connectTiktok(c, tenantId, [], warehouseId);
    const copy = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [tts.storeId] });
    await drain(tenantId);
    const [ttsDraft] = await draftsOf(c, copy.body.items[0].id);
    await c.post("/v1/listing-drafts/attributes", {
      draftIds: [ttsDraft!.id],
      attributeId: "102254",
      values: [{ valueId: "1000059" }],
    });
    await c.patch(`/v1/listing-drafts/${ttsDraft!.id}`, { images: [img("kaos-1.png")] });
    mock.products.tiktokPrerequisiteFailures = ["The shop has not completed seller verification."];
    await c.post("/v1/listing-drafts/publish", { draftIds: [ttsDraft!.id] });
    await drain(tenantId);
    mock.products.tiktokPrerequisiteFailures = [];
    expect((await c.get(`/v1/listing-drafts/${ttsDraft!.id}`)).body.error).toBe(
      "Toko belum bisa menambah produk di Tokopedia & Shop: The shop has not completed seller verification.",
    );
  });
});

describe("categories and moving drafts to another category", () => {
  it("lists, searches, and reads category rules, and prepares drafts again in the chosen category", async () => {
    const { c, tenantId, warehouseId } = await business();
    const src = await connectShopee(c, tenantId, [shopeeKaos(5601)]);
    const dst = await connectTiktok(c, tenantId, [], warehouseId);
    // nothing read yet for this store
    expect((await c.get(`/v1/stores/${dst.storeId}/categories`)).body).toMatchObject({
      items: [],
      total: 0,
      refreshedAt: null,
    });
    expect((await c.post(`/v1/stores/${dst.storeId}/categories/refresh`)).body).toMatchObject({ requested: true });
    expect(await drain(tenantId)).toContain("channel_category.refresh");
    const top = (await c.get(`/v1/stores/${dst.storeId}/categories`)).body;
    expect(top.total).toBe(6);
    expect(top.items.map((x: { name: string }) => x.name)).toEqual(["Aksesoris", "Obat", "Pakaian Pria"]);
    expect(
      (await c.get(`/v1/stores/${dst.storeId}/categories?parentId=601152`)).body.items.map(
        (x: { path: string }) => x.path,
      ),
    ).toEqual(["Pakaian Pria > Kaos", "Pakaian Pria > Kemeja"]);
    expect((await c.get(`/v1/stores/${dst.storeId}/categories?q=kem`)).body.items).toEqual([
      {
        categoryId: "601227",
        parentId: "601152",
        name: "Kemeja",
        path: "Pakaian Pria > Kemeja",
        isLeaf: true,
        permitted: true,
      },
    ]);
    expect((await c.post(`/v1/stores/${dst.storeId}/categories/refresh`)).body.requested).toBe(false);
    const pending = (await c.get(`/v1/stores/${dst.storeId}/categories/601227`)).body;
    expect(pending).toMatchObject({ rules: null, rulesPending: true });
    await drain(tenantId);
    const kemeja = (await c.get(`/v1/stores/${dst.storeId}/categories/601227`)).body;
    expect(kemeja.rulesPending).toBe(false);
    expect(kemeja.rules.attributes.find((a: { attributeId: string }) => a.attributeId === "102254")).toMatchObject({
      name: "Barang Impor",
      required: true,
      input: "select",
    });
    expect(kemeja.rules.limits).toMatchObject({ titleMin: 25, titleMax: 255, skuNoSpaces: true });
    expect((await c.get(`/v1/stores/${dst.storeId}/categories/999999`)).status).toBe(404);

    const res = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] });
    await drain(tenantId);
    const [draft] = await draftsOf(c, res.body.items[0].id);
    for (const [categoryId, message] of [
      ["601152", "Pilih kategori paling akhir (tanpa subkategori)."],
      ["700001", "Toko tujuan belum diizinkan berjualan di kategori ini."],
      ["123", "Kategori tidak ditemukan di toko tujuan. Muat ulang daftar kategori."],
    ]) {
      const refused = await c.post("/v1/listing-drafts/category", { draftIds: [draft!.id], categoryId });
      expect(refused.status).toBe(422);
      expect(refused.body.detail).toBe(message);
    }
    const moved = await c.post("/v1/listing-drafts/category", { draftIds: [draft!.id], categoryId: "601227" });
    expect(moved.status).toBe(202);
    expect((await c.get(`/v1/listing-drafts/${draft!.id}`)).body.status).toBe("preparing");
    // not editable while it is prepared again
    expect((await c.patch(`/v1/listing-drafts/${draft!.id}`, { title: "x" })).status).toBe(409);
    expect(await drain(tenantId)).toContain("listing_draft.recheck");
    const d = (await c.get(`/v1/listing-drafts/${draft!.id}`)).body;
    expect(d).toMatchObject({ status: "draft", externalCategoryId: "601227", categoryPath: "Pakaian Pria > Kemeja" });
    expect(d.attributes.map((a: { attributeId: string }) => a.attributeId)).toEqual(["100392", "100393"]);
    // the choice is remembered for the next copy from Shopee's "Kaos"
    const remembered = await h.system.db.execute<{ target: string; uses: number }>(
      sql`SELECT external_target_category_id AS target, uses FROM category_mapping
           WHERE tenant_id = ${tenantId} AND source_channel = 'shopee' AND external_source_category_id = '100017'`,
    );
    expect(remembered.rows).toEqual([{ target: "601227", uses: 1 }]);
  });
});

describe("copies: whole stores, cancelling, idempotency, validation, scope, and deletion", () => {
  it("copies a whole store, skips open drafts, cancels, and replays an Idempotency-Key", async () => {
    const { c, tenantId, warehouseId } = await business();
    const src = await connectShopee(c, tenantId, [
      shopeeKaos(5701),
      shopeeTopi(5702),
      shopeeKaos(5703, { item_name: "Kaos Lengan Panjang Katun Combed 30s" }),
    ]);
    const dst = await connectTiktok(c, tenantId, [], warehouseId);
    const first = await c
      .post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId], skipListed: false })
      .set("Idempotency-Key", "salin-toko-0001");
    expect(first.status).toBe(202);
    const replay = await c
      .post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId], skipListed: false })
      .set("Idempotency-Key", "salin-toko-0001");
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.items.map((x: { id: string }) => x.id)).toEqual(
      first.body.items.map((x: { id: string }) => x.id),
    );
    await drain(tenantId);
    expect((await c.get(`/v1/listing-copies/${first.body.items[0].id}`)).body).toMatchObject({
      status: "ready",
      itemsTotal: 3,
      itemsDrafted: 3,
    });
    // the drafts still wait for review: a new copy skips them
    const second = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] });
    await drain(tenantId);
    expect((await c.get(`/v1/listing-copies/${second.body.items[0].id}`)).body).toMatchObject({
      itemsDrafted: 0,
      itemsSkipped: 3,
    });
    const third = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] });
    const cancelled = await c.post(`/v1/listing-copies/${third.body.items[0].id}/cancel`);
    expect(cancelled.body).toMatchObject({ status: "cancelled" });
    expect((await c.post(`/v1/listing-copies/${third.body.items[0].id}/cancel`)).status).toBe(409);
    await drain(tenantId);
    expect((await c.get(`/v1/listing-copies/${third.body.items[0].id}`)).body).toMatchObject({
      status: "cancelled",
      itemsDrafted: 0,
      itemsSkipped: 0,
    });
    const list = (await c.get(`/v1/listing-copies?targetStoreId=${dst.storeId}`)).body.items;
    expect(list.map((x: { status: string }) => x.status)).toEqual(["cancelled", "ready", "ready"]);
    // a draft that is not being worked on can be deleted
    const [draft] = await draftsOf(c, first.body.items[0].id);
    expect((await c.delete(`/v1/listing-drafts/${draft!.id}`)).status).toBe(204);
    expect((await c.get(`/v1/listing-drafts/${draft!.id}`)).status).toBe(404);
    expect((await c.get(`/v1/listing-drafts?targetStoreId=${dst.storeId}&blocking=true`)).body.items).toHaveLength(2);
  });

  it("validates stores and listings, checks permissions and store scope, and deletes copies with a store's data", async () => {
    const { c, tenantId, warehouseId } = await business();
    const src = await connectShopee(c, tenantId, [shopeeKaos(5801)]);
    const dst = await connectTiktok(c, tenantId, [], warehouseId);
    const other = await connectShopee(c, tenantId, [shopeeTopi(5802)]);
    const manual = await c.post("/v1/stores/manual", { name: "WhatsApp" });
    expect(manual.status).toBe(201);
    const same = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [src.storeId] });
    expect(same.status).toBe(422);
    const toManual = await c.post("/v1/listing-copies", {
      sourceStoreId: src.storeId,
      targetStoreIds: [manual.body.id],
    });
    expect(toManual.body.code).toBe("store.manual");
    const otherListing = (await listingsOf(c, other.storeId))[0]!;
    const mixed = await c.post("/v1/listing-copies", {
      sourceStoreId: src.storeId,
      listingIds: [otherListing.id],
      targetStoreIds: [dst.storeId],
    });
    expect(mixed.status).toBe(422);
    expect(mixed.body.errors[0].path).toBe("listingIds");

    const copy = await c.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] });
    await drain(tenantId);
    const [draft] = await draftsOf(c, copy.body.items[0].id);

    // Gudang may read the catalog, not copy or publish
    const { member: gudang } = await addMember(c, tenantId, "Gudang");
    expect((await gudang.get(`/v1/listing-drafts/${draft!.id}`)).status).toBe(200);
    expect(
      (await gudang.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] })).status,
    ).toBe(403);
    expect((await gudang.post("/v1/listing-drafts/publish", { draftIds: [draft!.id] })).status).toBe(403);
    // an Admin limited to the source store does not see copies into another store
    const { member: admin } = await addMember(c, tenantId, "Admin");
    const users = (await c.get("/v1/users")).body.items as { id: string; name: string }[];
    const adminId = users.find((u) => u.name === "Admin")!.id;
    expect((await c.put(`/v1/users/${adminId}/scopes`, { storeIds: [src.storeId] })).status).toBe(200);
    expect((await admin.get(`/v1/listing-copies/${copy.body.items[0].id}`)).status).toBe(404);
    expect((await admin.get(`/v1/listing-drafts/${draft!.id}`)).status).toBe(404);
    expect((await admin.get("/v1/listing-copies")).body.items).toEqual([]);
    expect(
      (await admin.post("/v1/listing-copies", { sourceStoreId: src.storeId, targetStoreIds: [dst.storeId] })).status,
    ).toBe(404);

    // the source store goes without its data: its copies and drafts go too
    expect((await c.post(`/v1/stores/${src.storeId}/disconnect`, { keepData: false })).status).toBe(200);
    await drain(tenantId);
    const service = worker.ctx.get(StoreDataDeletionService);
    await service.run(systemContext(tenantId), src.storeId);
    const left = await h.system.db.execute<{ copies: string; drafts: string }>(
      sql`SELECT (SELECT count(*) FROM listing_copy WHERE source_store_id = ${src.storeId})::text AS copies,
                 (SELECT count(*) FROM listing_draft WHERE source_store_id = ${src.storeId})::text AS drafts`,
    );
    expect(left.rows[0]).toEqual({ copies: "0", drafts: "0" });
  });
});
