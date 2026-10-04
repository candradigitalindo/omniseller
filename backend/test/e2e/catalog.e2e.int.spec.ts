import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOB_REGISTRY, QUEUES } from "../../src/infra/tokens";
import { jobKey } from "../../src/jobs/job-id";
import type { QueueRegistry } from "../../src/jobs/queues";
import type { JobRegistry } from "../../src/jobs/registry";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
import { scanWarehousePolls, WAREHOUSE_POLL_SLOT_MS } from "../../src/scheduler/channel-scans";
import { type Client, signup, startApi, startWebhook, startWorker, WEBHOOK_URL } from "../setup/app";
import { testHandles } from "../setup/handles";
import { MockMarketplace, type MockShopeeItem, type MockTiktokProduct, SHOPEE } from "../setup/mock-marketplace";

/**
 * Catalog end to end (PRD 6.2, FR-INT-04): master products, listing pulls from the fake marketplace,
 * SKU mapping, suggestions, products from listings, status push, webhooks, CSV import and export.
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 800000;

beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  api = await startApi(h.infra, { marketplace: mock });
  hooks = await startWebhook(h.infra, { marketplace: mock });
  worker = await startWorker(h.infra, h.system, { marketplace: mock });
});

afterAll(async () => {
  await worker?.close();
  await hooks?.close();
  await api?.close();
  await mock?.close();
});

async function drain(tenantId: string): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < 10; i++) {
    const round = await worker.runOutbox(tenantId);
    if (round.length === 0) break;
    ran.push(...round);
  }
  return ran;
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
  const ran = await drain(tenantId);
  const done = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body;
  return { shopId, storeId: done.result.stores[0].storeId as string, ran };
}

const kaos = {
  sku: "KAOS-POLOS",
  name: "Kaos Polos Premium",
  brand: "Rina",
  attributeNames: ["Warna", "Ukuran"],
  imageUrls: ["https://cdn.contoh.id/kaos.jpg"],
  variants: [
    {
      sku: "KAOS-HTM-M",
      attributes: { Warna: "Hitam", Ukuran: "M" },
      basePrice: 65000,
      costPrice: 35000,
      weightG: 250,
    },
    {
      sku: "KAOS-HTM-L",
      attributes: { Warna: "Hitam", Ukuran: "L" },
      basePrice: 65000,
      costPrice: 35000,
      weightG: 260,
    },
  ],
};

function shopeeItems(base = 100): MockShopeeItem[] {
  return [
    {
      item_id: base + 1,
      item_name: "Kaos Polos Premium Cotton",
      item_sku: "KAOS",
      item_status: "NORMAL",
      update_time: 1_700_000_000,
      images: ["https://cf.shopee.co.id/file/kaos"],
      tiers: [
        { name: "Warna", options: ["Hitam"] },
        { name: "Ukuran", options: ["M", "XL"] },
      ],
      models: [
        { model_id: 11, model_sku: " kaos-htm-m ", tier_index: [0, 0], price: 66000, stock: 12 },
        { model_id: 12, model_sku: "KAOS-HTM-XL", tier_index: [0, 1], price: 67000, stock: 3 },
      ],
    },
    {
      item_id: base + 2,
      item_name: "Topi Rajut",
      item_sku: "TOPI-01",
      item_status: "NORMAL",
      update_time: 1_700_000_000,
      price: 45000,
      stock: 7,
    },
  ];
}

describe("master products (FR-PRD-01)", () => {
  it("creates products with attribute variants, keeps SKUs unique ignoring case, and updates with If-Match", async () => {
    const { c } = await signup(api);
    const created = await c.post("/v1/products", kaos);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      sku: "KAOS-POLOS",
      attributeNames: ["Warna", "Ukuran"],
      imageUrls: kaos.imageUrls,
    });
    expect(created.body.variants.map((v: { name: string }) => v.name)).toEqual(["Hitam, M", "Hitam, L"]);

    const dupe = await c.post("/v1/products", {
      ...kaos,
      sku: "LAIN",
      variants: [{ ...kaos.variants[0], sku: "kaos-htm-m" }],
    });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe("catalog.sku_taken");
    const dupeProduct = await c.post("/v1/products", {
      ...kaos,
      sku: " kaos-polos ",
      variants: [{ ...kaos.variants[0], sku: "LAIN-1" }],
    });
    expect(dupeProduct.body.code).toBe("catalog.sku_taken");

    const withBarcode = await c.post("/v1/products", {
      sku: "TOPI",
      name: "Topi",
      variants: [{ sku: "TOPI-1", barcode: "8991234567891", basePrice: 20000, weightG: 80 }],
    });
    expect(withBarcode.status).toBe(201);
    const sameBarcode = await c.post("/v1/products", {
      sku: "TOPI-B",
      name: "Topi B",
      variants: [{ sku: "TOPI-B-1", barcode: "8991234567891", basePrice: 20000, weightG: 80 }],
    });
    expect(sameBarcode.status).toBe(409);
    expect(sameBarcode.body).toMatchObject({
      code: "catalog.barcode_taken",
      errors: [{ path: "variants.0.barcode" }],
    });

    const badAttrs = await c.post("/v1/products", {
      ...kaos,
      sku: "X1",
      variants: [{ sku: "X1-A", attributes: { Warna: "Merah" }, basePrice: 1, weightG: 1 }],
    });
    expect(badAttrs.status).toBe(422);
    expect(badAttrs.body.errors[0]).toMatchObject({ path: "variants.0.attributes" });

    const id = created.body.id as string;
    const etag = (await c.get(`/v1/products/${id}`)).headers.etag as string;
    expect((await c.patch(`/v1/products/${id}`, { name: "Kaos Polos Premium 30s" }).set("If-Match", etag)).status).toBe(
      200,
    );
    expect((await c.patch(`/v1/products/${id}`, { name: "basi" }).set("If-Match", etag)).status).toBe(409);

    const added = await c.post(`/v1/products/${id}/variants`, {
      sku: "KAOS-PTH-M",
      attributes: { Warna: "Putih", Ukuran: "M" },
      basePrice: 65000,
      weightG: 250,
    });
    expect(added.status).toBe(201);
    const variantId = added.body.variants[2].id as string;
    const priced = await c.patch(`/v1/products/${id}/variants/${variantId}`, { basePrice: 69000, status: "archived" });
    expect(priced.body.variants[2]).toMatchObject({ basePrice: 69000, status: "archived" });

    expect((await c.get("/v1/products?q=kaos-pth")).body.items.map((p: { id: string }) => p.id)).toEqual([id]);
    const audit = await h.system.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM audit_log WHERE entity_type = 'product' AND entity_id = ${id}`,
    );
    expect(Number(audit.rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });
});

describe("listing pull and mapping (FR-INT-04, FR-PRD-02, 03)", () => {
  it("imports listings when a store connects, maps by SKU, and suggests by name", async () => {
    const { c, me } = await signup(api);
    const product = (await c.post("/v1/products", kaos)).body;
    const { storeId, ran } = await connectShopee(c, me.tenant.id, shopeeItems());
    expect(ran).toContain("listing.pull");

    const all = (await c.get(`/v1/listings?storeId=${storeId}`)).body.items as {
      sku: string;
      variantName: string;
      price: number;
      stock: number;
      status: string;
      store: { channelName: string };
      mapping: { variantId: string; source: string; productName: string } | null;
    }[];
    expect(all).toHaveLength(3);
    const bySku = Object.fromEntries(all.map((l) => [l.sku, l]));
    // Shopee's " kaos-htm-m " is stored trimmed and matches KAOS-HTM-M ignoring case
    expect(bySku["kaos-htm-m"]!.mapping).toMatchObject({ variantId: product.variants[0].id, source: "auto_sku" });
    expect(bySku["KAOS-HTM-XL"]!.mapping).toBeNull();
    expect(bySku["TOPI-01"]).toMatchObject({
      price: 45000,
      stock: 7,
      status: "active",
      variantName: null,
      mapping: null,
    });
    expect(bySku["KAOS-HTM-XL"]).toMatchObject({
      variantName: "Hitam, XL",
      price: 67000,
      store: { channelName: "Shopee" },
    });

    const unmapped = (await c.get(`/v1/listings/unmapped?storeId=${storeId}`)).body.items as {
      sku: string;
      suggestions: { productName: string; reason: string; score: number }[];
    }[];
    expect(unmapped.map((u) => u.sku).sort()).toEqual(["KAOS-HTM-XL", "TOPI-01"]);
    const xl = unmapped.find((u) => u.sku === "KAOS-HTM-XL")!;
    expect(xl.suggestions[0]).toMatchObject({ productName: "Kaos Polos Premium", reason: "name" });
    expect(xl.suggestions[0]!.score).toBeGreaterThan(0.3);

    const log = (await c.get(`/v1/stores/${storeId}/sync-jobs`)).body.items as {
      kind: string;
      result: Record<string, number>;
    }[];
    expect(log.find((j) => j.kind === "listings.pull")?.result).toMatchObject({ items: 2, listings: 3 });

    // A mapped variant's product cannot be deleted.
    expect((await c.delete(`/v1/products/${product.id}`)).status).toBe(409);
  });

  it("auto-maps only live listings of the chosen store, and only to active variants", async () => {
    const { c, me } = await signup(api);
    const items = (base: number): MockShopeeItem[] =>
      ["AM-1", "AM-2", "AM-3"].map((sku, i) => ({
        item_id: base + i,
        item_name: `Barang ${sku}`,
        item_sku: sku,
        item_status: "NORMAL",
        update_time: 1_700_000_000,
        price: 10_000,
        stock: 5,
      }));
    // the stores come first: their listings arrive with nothing to map to
    const a = await connectShopee(c, me.tenant.id, items(300));
    const b = await connectShopee(c, me.tenant.id, items(310));
    const product = (
      await c.post("/v1/products", {
        sku: "AM",
        name: "Produk AM",
        attributeNames: ["Ukuran"],
        variants: ["AM-1", "AM-2", "AM-3"].map((sku, i) => ({
          sku,
          attributes: { Ukuran: String(i + 1) },
          basePrice: 10_000,
          weightG: 100,
        })),
      })
    ).body;
    const am2 = (product.variants as { id: string; sku: string }[]).find((v) => v.sku === "AM-2")!.id;
    expect((await c.patch(`/v1/products/${product.id}/variants/${am2}`, { status: "archived" })).status).toBe(200);
    // the marketplace deleted store A's AM-3
    await h.system.db.execute(
      sql`UPDATE channel_listing SET status = 'deleted' WHERE store_id = ${a.storeId} AND external_sku = 'AM-3'`,
    );
    const mapping = async (storeId: string) =>
      Object.fromEntries(
        (
          await h.system.db.execute<{ external_sku: string; mapping_source: string | null }>(
            sql`SELECT external_sku, mapping_source FROM channel_listing WHERE store_id = ${storeId}`,
          )
        ).rows.map((r) => [r.external_sku, r.mapping_source]),
      );

    expect((await c.post("/v1/listings/auto-map", { storeId: a.storeId })).body).toEqual({ mapped: 1 });
    expect(await mapping(a.storeId)).toEqual({ "AM-1": "auto_sku", "AM-2": null, "AM-3": null });
    expect(await mapping(b.storeId)).toEqual({ "AM-1": null, "AM-2": null, "AM-3": null });
    // without a store: every store of the business
    expect((await c.post("/v1/listings/auto-map", {})).body).toEqual({ mapped: 2 });
    expect(await mapping(b.storeId)).toEqual({ "AM-1": "auto_sku", "AM-2": null, "AM-3": "auto_sku" });
  });

  it("creates master products from listings and maps manually", async () => {
    const { c, me } = await signup(api);
    const existing = (
      await c.post("/v1/products", {
        sku: "KAOS-LAMA",
        name: "Kaos Lama",
        variants: [{ sku: "KAOS-HTM-XL", basePrice: 67000, weightG: 250 }],
      })
    ).body;
    const { storeId } = await connectShopee(c, me.tenant.id, shopeeItems(200));
    // KAOS-HTM-XL was auto-mapped to the existing variant on pull; the rest is unmapped
    const unmapped = (await c.get(`/v1/listings/unmapped?storeId=${storeId}`)).body.items as {
      id: string;
      sku: string;
    }[];
    expect(unmapped.map((u) => u.sku).sort()).toEqual(["TOPI-01", "kaos-htm-m"]);

    const res = await c.post("/v1/listings/create-products", { listingIds: unmapped.map((u) => u.id) });
    expect(res.status).toBe(200);
    expect(res.body.failed).toEqual([]);
    expect(res.body.created.map((x: { sku: string }) => x.sku).sort()).toEqual(["KAOS", "TOPI-01"]);
    const kaosProduct = (
      await c.get(`/v1/products/${res.body.created.find((x: { sku: string }) => x.sku === "KAOS").productId}`)
    ).body;
    expect(kaosProduct).toMatchObject({
      name: "Kaos Polos Premium Cotton",
      attributeNames: ["Warna", "Ukuran"],
      imageUrls: ["https://cf.shopee.co.id/file/kaos"],
    });
    expect(kaosProduct.variants).toEqual([
      expect.objectContaining({
        sku: "kaos-htm-m",
        attributes: { Warna: "Hitam", Ukuran: "M" },
        basePrice: 66000,
        listingCount: 1,
      }),
    ]);
    expect((await c.get(`/v1/listings/unmapped?storeId=${storeId}`)).body.items).toEqual([]);

    const topiListing = unmapped.find((u) => u.sku === "TOPI-01")!;
    const unmap = await c.put(`/v1/listings/${topiListing.id}/mapping`, { variantId: null });
    expect(unmap.body.mapping).toBeNull();
    const remap = await c.put(`/v1/listings/${topiListing.id}/mapping`, { variantId: existing.variants[0].id });
    expect(remap.body.mapping).toMatchObject({ source: "manual", productName: existing.name });
    // An archived variant cannot receive listings.
    const archived = await c.patch(`/v1/products/${existing.id}/variants/${existing.variants[0].id}`, {
      status: "archived",
    });
    expect(archived.status).toBe(200);
    const bad = await c.put(`/v1/listings/${unmapped.find((u) => u.sku === "kaos-htm-m")!.id}/mapping`, {
      variantId: existing.variants[0].id,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[0]).toMatchObject({ path: "variantId" });
  });
});

describe("marketplace changes (FR-PRD-09, 10)", () => {
  it("deactivates items on Shopee, reports refusals, and reads the result back", async () => {
    const { c, me } = await signup(api);
    const items = shopeeItems(300);
    items[1]!.lockedForUnlist = true;
    const { storeId } = await connectShopee(c, me.tenant.id, items);
    const listings = (await c.get(`/v1/listings?storeId=${storeId}`)).body.items as { id: string; sku: string }[];
    const res = await c.post("/v1/listings/status", { listingIds: listings.map((l) => l.id), active: false });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ stores: 1, items: 2 });
    expect(await drain(me.tenant.id)).toContain("listing.status_push");

    const after = (await c.get(`/v1/listings?storeId=${storeId}`)).body.items as { sku: string; status: string }[];
    expect(Object.fromEntries(after.map((l) => [l.sku, l.status]))).toEqual({
      "kaos-htm-m": "inactive",
      "KAOS-HTM-XL": "inactive",
      "TOPI-01": "active",
    });
    const push = (
      (await c.get(`/v1/stores/${storeId}/sync-jobs`)).body.items as { kind: string; result: { failed: unknown[] } }[]
    ).find((j) => j.kind === "listings.status_push")!;
    expect(push.result.failed).toEqual([
      { externalItemId: "302", ok: false, error: "Can't unlist item when item is under promotion" },
    ]);
  });

  it("refreshes an item when Shopee pushes a violation, and closes items deleted on the marketplace", async () => {
    const { c, me } = await signup(api);
    const items = shopeeItems(400);
    const { shopId, storeId } = await connectShopee(c, me.tenant.id, items);
    items[1]!.item_status = "BANNED";
    const raw = JSON.stringify({
      data: { item_id: 402, item_status: "BANNED" },
      shop_id: Number(shopId),
      code: 16,
      timestamp: 1,
    });
    const res = await request(hooks.getHttpServer())
      .post("/webhooks/shopee")
      .set("content-type", "application/json")
      .set("authorization", mock.signShopeePush(`${WEBHOOK_URL}/webhooks/shopee`, raw))
      .send(raw);
    expect(res.status).toBe(200);
    const row = await h.system.db.execute<{ id: string }>(
      sql`SELECT id FROM webhook_inbox WHERE external_shop_id = ${shopId}`,
    );
    await worker.runJob(webhookProcessJob, { inboxId: row.rows[0]!.id }, me.tenant.id);
    const topi = (await c.get(`/v1/listings?storeId=${storeId}&q=TOPI`)).body.items[0];
    expect(topi.status).toBe("banned");

    // incremental sync reads only items changed since the last pull
    items[0]!.item_name = "Kaos Polos Premium Cotton 30s";
    items[0]!.update_time = Math.floor(Date.now() / 1000) + 60;
    const before = mock.callsTo("GET", "/api/v2/product/get_item_list").length;
    expect((await c.post("/v1/listings/sync", { storeId })).status).toBe(202);
    await drain(me.tenant.id);
    const listCall = mock.callsTo("GET", "/api/v2/product/get_item_list").slice(before)[0]!;
    expect(listCall.query.update_time_from).toMatch(/^\d{10}$/);
    expect((await c.get(`/v1/listings?storeId=${storeId}&q=30s`)).body.items).toHaveLength(2);

    // a full sync closes what the marketplace no longer lists
    items.splice(0, 1);
    expect((await c.post("/v1/listings/sync", { storeId, full: true })).status).toBe(202);
    await drain(me.tenant.id);
    const deleted = (await c.get(`/v1/listings?storeId=${storeId}&status=deleted`)).body.items as { sku: string }[];
    expect(deleted.map((l) => l.sku).sort()).toEqual(["KAOS-HTM-XL", "kaos-htm-m"]);
  });

  it("pulls a large catalog page by page across jobs", async () => {
    const { c, me } = await signup(api);
    const many: MockShopeeItem[] = Array.from({ length: 1050 }, (_, i) => ({
      item_id: 10_000 + i,
      item_name: `Produk ${i}`,
      item_sku: `SKU-${i}`,
      item_status: "NORMAL",
      update_time: 1_700_000_000,
      price: 1000 + i,
      stock: 1,
    }));
    const { storeId, ran } = await connectShopee(c, me.tenant.id, many);
    expect(ran.filter((r) => r === "listing.pull").length).toBe(2);
    const counted = await h.system.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM channel_listing WHERE store_id = ${storeId} AND status = 'active'`,
    );
    expect(Number(counted.rows[0]!.n)).toBe(1050);
  }, 60_000);
});

describe("Tokopedia & Shop listings", () => {
  it("reads products with variants and per-platform status, and deactivates on both platforms", async () => {
    const { c, me } = await signup(api);
    const products: MockTiktokProduct[] = [
      {
        id: "1729592969712207008",
        title: "Kaos Polos Premium",
        status: "ACTIVATE",
        tokopedia: "ACTIVATE",
        update_time: 1_700_000_000,
        images: ["https://p16.tiktokcdn.com/kaos.jpg"],
        skus: [
          {
            id: "1729592969712207012",
            seller_sku: "KAOS-HTM-L",
            price: 65000,
            attrs: { Warna: "Hitam", Ukuran: "L" },
            inventory: { "w-jkt": 10 },
          },
        ],
      },
    ];
    const sellerId = mock.addTiktokSeller({
      openId: "7010000000000000099",
      name: "Toko Tokopedia",
      shops: [
        {
          id: "7495000000000000099",
          name: "Toko Tokopedia",
          region: "ID",
          cipher: "ROW_toko",
          warehouses: [],
          products,
        },
      ],
    });
    const started = await c.post("/v1/store-authorizations", { channel: "tiktokshop" });
    await c.post("/v1/store-authorizations/callback", {
      channel: "tiktokshop",
      state: new URL(started.body.authorizeUrl).searchParams.get("state"),
      code: mock.tiktokCode(sellerId),
    });
    await drain(me.tenant.id);
    const storeId = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body.result.stores[0].storeId;
    const [listing] = (await c.get(`/v1/listings?storeId=${storeId}`)).body.items;
    expect(listing).toMatchObject({
      externalItemId: "1729592969712207008",
      sku: "KAOS-HTM-L",
      variantName: "Hitam, L",
      price: 65000,
      stock: 10,
      status: "active",
      statusDetail: { tiktok_shop: "ACTIVATE", tokopedia: "ACTIVATE" },
      store: { channelName: "Tokopedia & Shop" },
    });

    await c.post("/v1/listings/status", { listingIds: [listing.id], active: false });
    await drain(me.tenant.id);
    expect(products[0]!.status).toBe("SELLER_DEACTIVATED");
    expect((await c.get(`/v1/listings/${listing.id}`)).body).toMatchObject({
      status: "inactive",
      statusDetail: { tiktok_shop: "SELLER_DEACTIVATED", tokopedia: "SELLER_DEACTIVATED" },
    });

    // The platform freezes it; TikTok Shop's webhook carries the product id as a 19-digit JSON number.
    products[0]!.status = "PLATFORM_DEACTIVATED";
    products[0]!.tokopedia = "PLATFORM_DEACTIVATED";
    const raw =
      '{"type":5,"tts_notification_id":"7327112393057370001","shop_id":"7495000000000000099","timestamp":1644412885,' +
      '"data":{"product_id":1729592969712207008,"status":"PRODUCT_STATUS_CHANGED","suspended_reason":"","update_time":1644412885}}';
    const res = await request(hooks.getHttpServer())
      .post("/webhooks/tiktokshop")
      .set("content-type", "application/json")
      .set("authorization", mock.signTiktokWebhook(raw))
      .send(raw);
    expect(res.status).toBe(200);
    const row = await h.system.db.execute<{ id: string }>(
      sql`SELECT id FROM webhook_inbox WHERE event_id = '7327112393057370001'`,
    );
    await worker.runJob(webhookProcessJob, { inboxId: row.rows[0]!.id }, me.tenant.id);
    expect(mock.calls.some((x) => x.path === "/product/202309/products/1729592969712207008")).toBe(true);
    expect((await c.get(`/v1/listings/${listing.id}`)).body.status).toBe("banned");
  });
});

describe("CSV import and export (FR-PRD-04)", () => {
  it("reports every row error and changes nothing, previews with dryRun, then imports and exports", async () => {
    const { c } = await signup(api);
    const header = "sku_produk;nama_produk;merek;sku_varian;atribut;harga_jual;hpp;berat_gram;status;gambar";
    const bad = [
      header,
      "KMJ;Kemeja Flanel;Rina;KMJ-M;Ukuran=M;125.000;80000;300;aktif;https://cdn.contoh.id/kmj.jpg",
      'KMJ;Kemeja Flanel;Rina;KMJ-L;"Ukuran=L";125000,50;80000;300;aktif;',
      "KMJ;Kemeja Beda;Rina;;Ukuran=XL;125000;;300;aktif;",
      "TOPI;Topi;;KMJ-M;;45000;;0;rusak;http://tidak-aman",
    ].join("\r\n");
    const rejected = await c.post("/v1/products/import", { content: bad });
    expect(rejected.status).toBe(422);
    const paths = (rejected.body.errors as { path: string }[]).map((e) => e.path).sort();
    expect(paths).toEqual(
      expect.arrayContaining([
        "rows.3.harga_jual",
        "rows.4.sku_varian",
        "rows.5.berat_gram",
        "rows.5.status",
        "rows.5.gambar",
      ]),
    );
    expect((await c.get("/v1/products")).body.items).toEqual([]);

    const good = [
      header,
      "KMJ;Kemeja Flanel;Rina;KMJ-M;Ukuran=M;125.000;80000;300;aktif;https://cdn.contoh.id/kmj.jpg",
      "KMJ;Kemeja Flanel;Rina;KMJ-L;Ukuran=L;Rp 129.000;80000;320;aktif;",
      "TOPI;Topi Rajut;;TOPI-01;;45000;;100;aktif;",
    ].join("\r\n");
    const preview = await c.post("/v1/products/import", { content: good, dryRun: true });
    expect(preview.body).toEqual({
      rows: 3,
      products: { created: 2, updated: 0 },
      variants: { created: 3, updated: 0 },
      dryRun: true,
    });
    expect((await c.get("/v1/products")).body.items).toEqual([]);

    expect((await c.post("/v1/products/import", { content: good })).body.products).toEqual({ created: 2, updated: 0 });
    const kemeja = (await c.get("/v1/products?q=KMJ")).body.items[0];
    expect(kemeja).toMatchObject({
      name: "Kemeja Flanel",
      brand: "Rina",
      attributeNames: ["Ukuran"],
      imageUrls: ["https://cdn.contoh.id/kmj.jpg"],
    });
    expect(kemeja.variants.map((v: { sku: string; basePrice: number }) => [v.sku, v.basePrice])).toEqual([
      ["KMJ-M", 125000],
      ["KMJ-L", 129000],
    ]);

    // re-import updates by SKU (comma-separated works too)
    const update = [
      "sku_produk,nama_produk,sku_varian,atribut,harga_jual,berat_gram",
      "KMJ,Kemeja Flanel Pria,KMJ-L,Ukuran=L,131000,320",
    ].join("\n");
    expect((await c.post("/v1/products/import", { content: update })).body).toMatchObject({
      products: { created: 0, updated: 1 },
      variants: { created: 0, updated: 1 },
    });

    const csv = await c.get("/v1/products/export");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const text = csv.text.replace(/^﻿/, "");
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe(
      "sku_produk;nama_produk;deskripsi;merek;kategori;sku_varian;nama_varian;atribut;barcode;harga_jual;hpp;berat_gram;panjang_mm;lebar_mm;tinggi_mm;status;gambar",
    );
    expect(lines.some((l) => l.startsWith("KMJ;Kemeja Flanel Pria;") && l.includes(";KMJ-L;L;Ukuran=L;;131000;"))).toBe(
      true,
    );
    expect(lines).toHaveLength(4);
  });
});

describe("scheduler", () => {
  it("queues the 6-hourly incremental listing pull with the warehouse poll", async () => {
    const { c, me } = await signup(api);
    const { storeId } = await connectShopee(c, me.tenant.id, []);
    const queues = worker.ctx.get<QueueRegistry>(QUEUES);
    const registry = worker.ctx.get<JobRegistry>(JOB_REGISTRY);
    const now = new Date();
    await scanWarehousePolls(h.system, queues, registry, now);
    const slot = `p${Math.floor(now.getTime() / WAREHOUSE_POLL_SLOT_MS)}`;
    const job = await queues.get("mp.poll").getJob(jobKey("listing.pull", storeId, slot));
    expect(job?.data).toEqual({ storeId, tenantId: me.tenant.id, mode: "incremental" });
    expect(SHOPEE.partnerId).toBeGreaterThan(0);
  });
});
