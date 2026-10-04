import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { sql } from "drizzle-orm";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { shipmentTrackingPullJob } from "../../src/modules/fulfillment/fulfillment.jobs";
import { A4_PAGE, THERMAL_PAGE } from "../../src/modules/fulfillment/shipping-plan";
import { orderPullJob } from "../../src/modules/orders/orders.jobs";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
import { scanTracking } from "../../src/scheduler/tracking-scan";
import {
  type Client,
  client,
  PASSWORD,
  signup,
  startApi,
  startWebhook,
  startWorker,
  tokenFrom,
  uniqueEmail,
  WEBHOOK_URL,
} from "../setup/app";
import { testHandles } from "../setup/handles";
import {
  MockMarketplace,
  type MockShopeeItem,
  type MockShopeeOrder,
  type MockTiktokOrder,
} from "../setup/mock-marketplace";

/**
 * Parcel tracking, packing lists, and the custom label template end to end (backend doc 8.22; PRD
 * FR-SHP-03, 07, 16).
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 997000;
let snSeq = 1;
const nowSec = () => Math.floor(Date.now() / 1000);

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
  return { c, me, tenantId: me.tenant.id, warehouseId };
}

async function product(c: Client, sku: string, variantSkus: string[]) {
  const res = await c.post("/v1/products", {
    sku,
    name: `Produk ${sku}`,
    variants: variantSkus.map((v) => ({ sku: v, basePrice: 50_000, costPrice: 20_000, weightG: 200 })),
  });
  expect(res.status).toBe(201);
  return Object.fromEntries((res.body.variants as { id: string; sku: string }[]).map((v) => [v.sku, v.id]));
}

async function stock(c: Client, warehouseId: string, lines: Record<string, number>, bins: Record<string, string> = {}) {
  const res = await c.post("/v1/inventory/adjustments", {
    lines: Object.entries(lines).map(([variantId, quantity]) => ({ variantId, warehouseId, mode: "set", quantity })),
    reason: "correction",
  });
  expect(res.status).toBe(200);
  for (const [variantId, binLocation] of Object.entries(bins)) {
    expect((await c.put(`/v1/inventory/${variantId}/warehouses/${warehouseId}`, { binLocation })).status).toBe(200);
  }
}

const kaosItem = (itemId: number): MockShopeeItem => ({
  item_id: itemId,
  item_name: "Kaos",
  item_sku: "KAOS",
  item_status: "NORMAL",
  update_time: 1_700_000_000,
  tiers: [{ name: "Ukuran", options: ["M", "L"] }],
  models: [
    { model_id: itemId * 10 + 1, model_sku: "KAOS-M", tier_index: [0], price: 50_000, stock: 3 },
    { model_id: itemId * 10 + 2, model_sku: "KAOS-L", tier_index: [1], price: 50_000, stock: 3 },
  ],
});

async function connectShopee(c: Client, tenantId: string, itemId: number) {
  const shopId = String(++shopSeq);
  const orders: MockShopeeOrder[] = [];
  mock.addShopeeShop({
    shopId,
    name: `Toko ${shopId}`,
    region: "ID",
    warehouses: "not_whitelisted",
    items: [kaosItem(itemId)],
    orders,
  });
  const started = await c.post("/v1/store-authorizations", { channel: "shopee" });
  await c.post("/v1/store-authorizations/callback", {
    channel: "shopee",
    state: new URL(started.body.authorizeUrl).searchParams.get("state"),
    code: mock.shopeeCode({ shopId }),
    shopId,
  });
  await drain(tenantId);
  const storeId = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body.result.stores[0].storeId as string;
  expect((await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" })).status).toBe(200);
  await drain(tenantId);
  return { shopId, storeId, orders };
}

function shopeeOrder(
  itemId: number,
  lines: { model: number; sku: string; qty: number }[],
  extra: Partial<MockShopeeOrder> = {},
): MockShopeeOrder {
  const t = nowSec();
  return {
    order_sn: `2610120${String(snSeq++).padStart(6, "0")}`,
    order_status: "READY_TO_SHIP",
    create_time: t - 4000,
    update_time: t - 30,
    pay_time: t - 3900,
    ship_by_date: t + 2 * 86_400,
    total_amount: lines.reduce((n, l) => n + l.qty * 45_000, 0),
    buyer_user_id: 6000 + snSeq,
    buyer_username: "dewi",
    shipping_carrier: "SPX Standard",
    recipient_address: {
      name: "Dewi",
      phone: "6281200000",
      city: "Surabaya",
      state: "Jawa Timur",
      full_address: "Jl. Mawar 1",
    },
    item_list: lines.map((l) => ({
      item_id: itemId,
      item_name: "Kaos",
      model_id: l.model,
      model_sku: l.sku,
      model_name: l.sku,
      model_quantity_purchased: l.qty,
      model_original_price: 50_000,
      model_discounted_price: 45_000,
    })),
    ...extra,
  };
}

async function pushOrder(tenantId: string, shopId: string, o: MockShopeeOrder) {
  const raw = JSON.stringify({
    data: { ordersn: o.order_sn, status: o.order_status, update_time: o.update_time },
    shop_id: Number(shopId),
    code: 3,
    timestamp: nowSec() + snSeq++,
  });
  const res = await request(hooks.getHttpServer())
    .post("/webhooks/shopee")
    .set("content-type", "application/json")
    .set("authorization", mock.signShopeePush(`${WEBHOOK_URL}/webhooks/shopee`, raw))
    .send(raw);
  expect(res.status).toBe(200);
  const rows = await h.system.db.execute<{ id: string }>(
    sql`SELECT id FROM webhook_inbox WHERE processed_at IS NULL AND external_shop_id = ${shopId} ORDER BY id`,
  );
  for (const r of rows.rows) await worker.runJob(webhookProcessJob, { inboxId: r.id }, tenantId);
  await drain(tenantId);
}

async function orderBy(c: Client, externalOrderId: string) {
  const list = (await c.get(`/v1/orders?q=${externalOrderId}`)).body.items as { id: string; externalOrderId: string }[];
  const found = list.find((o) => o.externalOrderId === externalOrderId);
  expect(found, `order ${externalOrderId}`).toBeDefined();
  return (await c.get(`/v1/orders/${found!.id}`)).body;
}

async function addMember(owner: Client, tenantId: string, role: string) {
  const roles = (await owner.get("/v1/roles")).body.items as { id: string; name: string }[];
  const email = uniqueEmail(role.toLowerCase());
  expect((await owner.post("/v1/invitations", { email, roleId: roles.find((r) => r.name === role)!.id })).status).toBe(
    201,
  );
  await drain(tenantId);
  const member = client(api);
  const accepted = await member.post("/v1/auth/invitations/accept", {
    token: tokenFrom(worker.email.lastTo(email)!.text),
    name: role,
    password: PASSWORD,
  });
  expect(accepted.status).toBe(201);
  return member;
}

async function pdfOf(c: Client, url: string) {
  const res = await c
    .get(url)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (d: Buffer) => chunks.push(d));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("application/pdf");
  return PDFDocument.load(res.body as Buffer);
}

/** Names of the fonts a PDF embeds. */
const fontsOf = (doc: PDFDocument): string[] =>
  doc.context.enumerateIndirectObjects().flatMap(([, o]) => {
    const name = o instanceof PDFDict ? o.get(PDFName.of("BaseFont")) : undefined;
    return name ? [name.toString()] : [];
  });

/** The scheduler's tracking scan, with the jobs it would queue collected instead of queued. */
async function scan(): Promise<{ tenantId: string; orderIds: string[] }[]> {
  const added: { tenantId: string; orderIds: string[] }[] = [];
  const queues = {
    get: () => ({ add: async (_n: string, p: { tenantId: string; orderIds: string[] }) => added.push(p) }),
  } as unknown as QueueRegistry;
  await scanTracking(h.system, queues, new JobRegistry(JOB_DEFINITIONS));
  return added;
}
const scannedIds = async (tenantId: string) =>
  (await scan()).filter((j) => j.tenantId === tenantId).flatMap((j) => j.orderIds);

describe("parcel tracking (FR-SHP-07)", () => {
  it("reads Shopee tracking of shipped orders, keeps it on the shipment, and reads again on request", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 20, [v["KAOS-L"]!]: 20 });
    const { shopId, orders } = await connectShopee(c, tenantId, 701);
    const t = nowSec();
    const shipped = shopeeOrder(701, [{ model: 7011, sku: "KAOS-M", qty: 1 }], {
      order_status: "SHIPPED",
      tracking: {
        logistics_status: "LOGISTICS_PICKUP_DONE",
        tracking_info: [
          { update_time: t - 7200, description: "Pesanan dibuat", logistics_status: "ORDER_CREATED" },
          { update_time: t - 3600, description: "Paket diserahkan ke kurir", logistics_status: "PICKED_UP" },
        ],
      },
    });
    const split = shopeeOrder(701, [{ model: 7012, sku: "KAOS-L", qty: 1 }], { order_status: "SHIPPED" });
    split.splitTracking = {
      [`OFG${split.order_sn}`]: {
        logistics_status: "LOGISTICS_DELIVERY_DONE",
        tracking_info: [{ update_time: t - 600, description: "Paket diterima", logistics_status: "DELIVERED" }],
      },
    };
    const fresh = shopeeOrder(701, [{ model: 7011, sku: "KAOS-M", qty: 1 }]);
    const gone = shopeeOrder(701, [{ model: 7011, sku: "KAOS-M", qty: 1 }], { order_status: "SHIPPED" });
    // shipped by Shopee's own warehouse and on its way back: not the seller's parcel to follow
    const byShopee = shopeeOrder(701, [{ model: 7011, sku: "KAOS-M", qty: 1 }], {
      order_status: "TO_RETURN",
      fulfillment_flag: "fulfilled_by_shopee",
    });
    orders.push(shipped, split, fresh, gone, byShopee);
    for (const o of [shipped, split, fresh, gone, byShopee]) await pushOrder(tenantId, shopId, o);
    const [a, b, n, g, fbs] = await Promise.all(
      [shipped, split, fresh, gone, byShopee].map((o) => orderBy(c, o.order_sn)),
    );
    expect([a.status, b.status, n.status, fbs.status]).toEqual(["shipped", "shipped", "new", "return_in_progress"]);
    // the marketplace no longer knows this one
    orders.splice(orders.indexOf(gone), 1);

    // the scan picks shipped orders whose parcel was never read, not new ones
    const due = await scannedIds(tenantId);
    expect(due).toEqual(expect.arrayContaining([a.id, b.id, g.id]));
    expect(due).not.toContain(n.id);
    expect(due).not.toContain(fbs.id);
    expect((await c.post(`/v1/orders/${fbs.id}/tracking/refresh`)).body.code).toBe("tracking.not_shipped");
    await worker.runJob(shipmentTrackingPullJob, { orderIds: due }, tenantId);
    // background work: it took its calls from the store's smaller share (the bucket lives 2 seconds)
    expect(await h.redis.exists(`rl:mp:shopee:${a.store.id}:background`)).toBe(1);

    const tracking = (await c.get(`/v1/orders/${a.id}/tracking`)).body;
    expect(tracking).toMatchObject({
      source: "marketplace",
      stage: "in_transit",
      stageLabel: "Dalam perjalanan",
      error: null,
      refreshable: true,
    });
    expect(
      tracking.events.map((e: { description: string; stageLabel: string }) => [e.description, e.stageLabel]),
    ).toEqual([
      ["Paket diserahkan ke kurir", "Dalam perjalanan"],
      ["Pesanan dibuat", "Menunggu kurir"],
    ]);
    expect(tracking.syncedAt).not.toBeNull();
    // shipped in Seller Center: OmniSeller adopted a shipment to keep the tracking on
    expect((await c.get(`/v1/orders/${a.id}/shipments`)).body.items).toEqual([
      expect.objectContaining({
        status: "in_transit",
        trackingStage: "in_transit",
        trackingStageLabel: "Dalam perjalanan",
      }),
    ]);
    // a split order is read per package
    expect((await c.get(`/v1/orders/${b.id}/tracking`)).body).toMatchObject({ stage: "delivered" });
    expect(mock.trackingCalls).toEqual(
      expect.arrayContaining([`shopee:${split.order_sn}:`, `shopee:${split.order_sn}:OFG${split.order_sn}`]),
    );
    // a failure is kept in the marketplace's words
    expect((await c.get(`/v1/orders/${g.id}/tracking`)).body).toMatchObject({
      stage: null,
      error: "The order is not exist.",
    });

    // read moments ago: the scan and "Perbarui" leave it alone, and a second job for it reads nothing
    expect(await scannedIds(tenantId)).not.toContain(a.id);
    const calls = mock.trackingCalls.length;
    await worker.runJob(shipmentTrackingPullJob, { orderIds: [a.id] }, tenantId);
    expect(mock.trackingCalls).toHaveLength(calls);
    expect((await c.post(`/v1/orders/${a.id}/tracking/refresh`)).body).toEqual({ queued: false });
    // an hour later "Perbarui" reads it again
    await h.system.db.execute(
      sql`UPDATE shipment SET tracking_synced_at = now() - interval '1 hour' WHERE order_id = ${a.id}`,
    );
    shipped.tracking!.logistics_status = "LOGISTICS_DELIVERY_DONE";
    shipped.tracking!.tracking_info.push({
      update_time: t,
      description: "Paket diterima Dewi",
      logistics_status: "DELIVERED",
    });
    const refreshed = await c.post(`/v1/orders/${a.id}/tracking/refresh`);
    expect(refreshed.status).toBe(202);
    expect(refreshed.body).toEqual({ queued: true });
    expect(await drain(tenantId)).toContain("shipment.tracking_pull");
    const after = (await c.get(`/v1/orders/${a.id}/tracking`)).body;
    expect(after).toMatchObject({ stage: "delivered", stageLabel: "Terkirim" });
    expect(after.events[0]).toMatchObject({ description: "Paket diterima Dewi", stage: "delivered" });

    // a new order has nothing to track yet
    expect((await c.post(`/v1/orders/${n.id}/tracking/refresh`)).body.code).toBe("tracking.not_shipped");

    // delivered: the adopted shipment follows the order, and the scan reads the parcel once more for its
    // last events, then leaves it
    shipped.order_status = "TO_CONFIRM_RECEIVE";
    shipped.update_time = nowSec();
    await pushOrder(tenantId, shopId, shipped);
    expect((await orderBy(c, shipped.order_sn)).status).toBe("delivered");
    expect((await c.get(`/v1/orders/${a.id}/shipments`)).body.items[0].status).toBe("delivered");
    expect(await scannedIds(tenantId)).toContain(a.id);
    await worker.runJob(shipmentTrackingPullJob, { orderIds: [a.id] }, tenantId);
    expect(await scannedIds(tenantId)).not.toContain(a.id);
  });

  it("reads TikTok Shop tracking per order and maps action codes", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M"]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 10 });
    const t = nowSec();
    const orders: MockTiktokOrder[] = [];
    const sellerId = mock.addTiktokSeller({
      openId: "7010000000000000971",
      name: "Toko Lacak",
      shops: [
        {
          id: "7495000000000000971",
          name: "Toko Lacak",
          region: "ID",
          cipher: "ROW_track_a",
          warehouses: [{ id: "7300000000000000071", name: "Gudang", type: "SALES_WAREHOUSE", is_default: true }],
          products: [
            {
              id: "1729592969712207171",
              title: "Kaos",
              status: "ACTIVATE",
              update_time: 1_700_000_000,
              skus: [
                {
                  id: "1729592969712207172",
                  seller_sku: "KAOS-M",
                  price: 50_000,
                  attrs: {},
                  inventory: { "7300000000000000071": 1 },
                },
              ],
            },
          ],
          orders,
        },
      ],
    });
    const started = await c.post("/v1/store-authorizations", { channel: "tiktokshop" });
    await c.post("/v1/store-authorizations/callback", {
      channel: "tiktokshop",
      state: new URL(started.body.authorizeUrl).searchParams.get("state"),
      code: mock.tiktokCode(sellerId),
    });
    await drain(tenantId);
    const storeId = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body.result.stores[0].storeId;
    const tiktokOrder = (id: string, fulfillment: string): MockTiktokOrder => ({
      id,
      status: "IN_TRANSIT",
      create_time: t - 90_000,
      update_time: t - 30,
      paid_time: t - 89_000,
      commerce_platform: "TOKOPEDIA",
      fulfillment_type: fulfillment,
      warehouse_id: "7300000000000000071",
      user_id: "7021436810468230071",
      recipient_address: { name: "Budi", phone_number: "(+62)812****", full_address: "Jl. Melati 2" },
      payment: { currency: "IDR", sub_total: "45000", total_amount: "45000" },
      line_items: [
        {
          id: `58800000${id.slice(-8)}`,
          sku_id: "1729592969712207172",
          product_id: "1729592969712207171",
          seller_sku: "KAOS-M",
          product_name: "Kaos",
          sku_name: "M",
          sale_price: "45000",
          original_price: "50000",
        },
      ],
      tracking: [
        { description: "Parcel created", update_time_millis: (t - 80_000) * 1000, action_code: 10101 },
        { description: "Paket dijemput kurir", update_time_millis: (t - 70_000) * 1000, action_code: 30901 },
        { description: "Kurir menuju alamat pembeli", update_time_millis: (t - 600) * 1000, action_code: 40501 },
      ],
    });
    orders.push(
      tiktokOrder("576486316948490971", "FULFILLMENT_BY_SELLER"),
      tiktokOrder("576486316948490972", "FULFILLMENT_BY_TIKTOK"),
    );
    await worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId);
    await drain(tenantId);
    const o = await orderBy(c, "576486316948490971");
    const fbt = await orderBy(c, "576486316948490972");
    expect([o.status, fbt.status, fbt.fulfillmentMode]).toEqual(["shipped", "marketplace_fulfilled", "marketplace"]);
    // read-only (parallel mode) stores are tracked too: tracking only reads. Parcels the marketplace
    // ships itself are not the seller's to follow.
    expect(await scannedIds(tenantId)).toEqual([o.id]);
    expect((await c.get(`/v1/orders/${fbt.id}/tracking`)).body).toMatchObject({ stage: null, refreshable: false });
    expect((await c.post(`/v1/orders/${fbt.id}/tracking/refresh`)).body.code).toBe("tracking.not_shipped");
    await worker.runJob(shipmentTrackingPullJob, { orderIds: [o.id] }, tenantId);
    const tracking = (await c.get(`/v1/orders/${o.id}/tracking`)).body;
    expect(tracking).toMatchObject({ stage: "out_for_delivery", stageLabel: "Sedang diantar" });
    expect(tracking.events.map((e: { code: string }) => e.code)).toEqual(["40501", "30901", "10101"]);
    expect(mock.trackingCalls).toContain("tiktokshop:576486316948490971:");
  });

  it("shows a manual order's stage from its status and never asks a marketplace about it", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "TAS", ["TAS-1"]);
    await stock(c, warehouseId, { [v["TAS-1"]!]: 5 });
    const placed = await c.post("/v1/orders/manual", {
      buyer: { name: "Sari", phone: "081300000001" },
      shippingAddress: { line1: "Jl. Kenanga 3", city: "Bandung" },
      items: [{ variantId: v["TAS-1"], qty: 1 }],
      paymentMethod: "cash",
    });
    await c.post(`/v1/orders/${placed.body.id}/ship`, { shippingProvider: "JNE", trackingNumber: "JNE0001" });
    expect((await c.get(`/v1/orders/${placed.body.id}/tracking`)).body).toMatchObject({
      source: "manual",
      stage: "in_transit",
      trackingNumber: "JNE0001",
      provider: "JNE",
      events: [],
      refreshable: false,
    });
    expect((await c.post(`/v1/orders/${placed.body.id}/tracking/refresh`)).body.code).toBe("tracking.manual");
    expect(await scannedIds(tenantId)).not.toContain(placed.body.id);
  });
});

describe("custom labels and packing lists (FR-SHP-03, 16)", () => {
  it("adds the template under marketplace labels and puts each order's packing list after its label", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await stock(
      c,
      warehouseId,
      { [v["KAOS-M"]!]: 10, [v["KAOS-L"]!]: 10 },
      { [v["KAOS-M"]!]: "A-2-01", [v["KAOS-L"]!]: "A-1-05" },
    );
    const { shopId, orders } = await connectShopee(c, tenantId, 702);
    const o1 = shopeeOrder(702, [{ model: 7021, sku: "KAOS-M", qty: 2 }], { message_to_seller: "Bungkus kado" });
    const o2 = shopeeOrder(702, [{ model: 7022, sku: "KAOS-L", qty: 1 }]);
    orders.push(o1, o2);
    await pushOrder(tenantId, shopId, o1);
    await pushOrder(tenantId, shopId, o2);
    const [a, b] = [await orderBy(c, o1.order_sn), await orderBy(c, o2.order_sn)];
    expect((await c.post("/v1/shipments/arrange", { orderIds: [a.id, b.id], method: "pickup" })).status).toBe(200);
    await drain(tenantId);
    const tag = (await c.post("/v1/tags", { name: "Prioritas" })).body;
    await c.post("/v1/orders/tags", { orderIds: [a.id], add: [tag.id] });
    expect((await c.put("/v1/label-template", { showTags: true })).body).toEqual({
      showSku: true,
      showVariant: true,
      showBin: true,
      showBuyerNote: true,
      showTags: true,
    });
    const manual = await c.post("/v1/orders/manual", {
      buyer: { name: "Sari", phone: "081300000001" },
      shippingAddress: { line1: "Jl. Kenanga 3", city: "Bandung" },
      items: [{ variantId: v["KAOS-M"], qty: 1 }],
      paymentMethod: "cash",
    });

    const requested = await c.post("/v1/documents", {
      kind: "labels",
      orderIds: [a.id, b.id, manual.body.id],
      template: "custom",
      packingList: true,
    });
    expect(requested.status).toBe(202);
    expect(requested.body).toMatchObject({ kind: "labels", format: "thermal", template: "custom", packingList: true });
    await drain(tenantId);
    const ready = (await c.get(`/v1/documents/${requested.body.id}`)).body;
    // three labels (two from Shopee with the template under them, OmniSeller's own for the manual order)
    // and a packing list after each
    expect(ready).toMatchObject({ status: "ready", pageCount: 6, result: { orders: 3, labels: 3, missing: [] } });
    const pdf = await pdfOf(c, ready.downloadUrl);
    expect(pdf.getPageCount()).toBe(6);
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo(THERMAL_PAGE.width, 3);
      expect(page.getHeight()).toBeCloseTo(THERMAL_PAGE.height, 3);
    }
    expect((await orderBy(c, o1.order_sn)).events.map((e: { type: string }) => e.type)).toContain("label_printed");

    // the standard template on A4: four labels per sheet, nothing added; the custom one draws its strip
    // with OmniSeller's font
    const plain = await c.post("/v1/documents", { kind: "labels", orderIds: [a.id, b.id], format: "a4" });
    expect(plain.body).toMatchObject({ template: "standard", packingList: false });
    const strips = await c.post("/v1/documents", { kind: "labels", orderIds: [a.id, b.id], template: "custom" });
    await drain(tenantId);
    const standard = (await c.get(`/v1/documents/${plain.body.id}`)).body;
    expect(standard).toMatchObject({ pageCount: 1, result: { labels: 2 } });
    expect(fontsOf(await pdfOf(c, standard.downloadUrl))).not.toContainEqual(expect.stringContaining("NotoSans"));
    const custom = (await c.get(`/v1/documents/${strips.body.id}`)).body;
    expect(custom).toMatchObject({ pageCount: 2, result: { labels: 2 } });
    expect(fontsOf(await pdfOf(c, custom.downloadUrl))).toContainEqual(expect.stringContaining("NotoSans"));
  });

  it("prints packing lists alone and keeps one template per business", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 10, [v["KAOS-L"]!]: 10 });
    const { shopId, orders } = await connectShopee(c, tenantId, 703);
    const open = shopeeOrder(703, [{ model: 7031, sku: "KAOS-M", qty: 1 }]);
    const done = shopeeOrder(703, [{ model: 7032, sku: "KAOS-L", qty: 1 }], { order_status: "SHIPPED" });
    orders.push(open, done);
    await pushOrder(tenantId, shopId, open);
    await pushOrder(tenantId, shopId, done);
    const [o, d] = [await orderBy(c, open.order_sn), await orderBy(c, done.order_sn)];

    const doc = await c.post("/v1/documents", { kind: "packing_list", orderIds: [o.id, d.id], format: "a4" });
    expect(doc.body).toMatchObject({ kind: "packing_list", format: "a4", template: null, packingList: false });
    await drain(tenantId);
    const ready = (await c.get(`/v1/documents/${doc.body.id}`)).body;
    expect(ready).toMatchObject({
      status: "ready",
      pageCount: 1,
      result: { orders: 1, missing: [{ orderId: d.id, code: "order.not_pickable" }] },
    });
    const page = (await pdfOf(c, ready.downloadUrl)).getPage(0);
    expect(page.getWidth()).toBeCloseTo(A4_PAGE.width, 3);

    // the template: defaults until saved, changed by settings:warehouse only, previewed as PDF
    expect((await c.get("/v1/label-template")).body).toEqual({
      showSku: true,
      showVariant: true,
      showBin: true,
      showBuyerNote: true,
      showTags: false,
    });
    // warehouse staff print with the template but do not change it; CS does neither
    const gudang = await addMember(c, tenantId, "Gudang");
    expect((await gudang.get("/v1/label-template")).status).toBe(200);
    expect((await gudang.put("/v1/label-template", { showBin: false })).status).toBe(403);
    const cs = await addMember(c, tenantId, "CS");
    expect((await cs.get("/v1/label-template")).status).toBe(403);
    expect((await c.put("/v1/label-template", { showBin: false })).body).toMatchObject({
      showBin: false,
      showSku: true,
    });
    expect((await c.put("/v1/label-template", { showSku: false })).body).toMatchObject({
      showBin: false,
      showSku: false,
    });
    const preview = await pdfOf(c, "/v1/label-template/preview?format=a4");
    expect(preview.getPageCount()).toBe(1);
    expect(preview.getPage(0).getWidth()).toBeCloseTo(A4_PAGE.width, 3);
  });
});
