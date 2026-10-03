import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemContext } from "../../src/common/context/request-context";
import { withTenantTx } from "../../src/db/tenant-tx";
import type { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { labelFetchJob } from "../../src/modules/fulfillment/fulfillment.jobs";
import { LabelsPendingError } from "../../src/modules/fulfillment/fulfillment-worker.service";
import { A4_PAGE, THERMAL_PAGE } from "../../src/modules/fulfillment/shipping-plan";
import { OrderSyncService } from "../../src/modules/orders/order-sync.service";
import { orderPullJob, orderSlaAlertJob } from "../../src/modules/orders/orders.jobs";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
import { scanSlaAlerts } from "../../src/scheduler/order-scans";
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
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import {
  MockMarketplace,
  type MockShopeeItem,
  type MockShopeeOrder,
  type MockTiktokOrder,
} from "../setup/mock-marketplace";

/**
 * Shipping end to end (PRD 6.5: FR-SHP-01, 02, 06, 10; backend doc 8.15): arranging pickup or drop-off
 * at the fake Shopee and TikTok Shop, labels stored and merged into one PDF, the pick list, shipments
 * following their orders, and ship-by alerts.
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 960000;
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

/** Runs the tenant's outbox until it is empty; failing jobs are collected when `failures` is given. */
async function drain(tenantId: string, failures?: { job: string; error: unknown }[]): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < 20; i++) {
    const round = await worker.runOutbox(tenantId, failures ? { failures } : {});
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

async function connectShopee(c: Client, tenantId: string, itemId: number, live = true) {
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
  if (live) expect((await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" })).status).toBe(200);
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
    order_sn: `2610040${String(snSeq++).padStart(6, "0")}`,
    order_status: "READY_TO_SHIP",
    create_time: t - 4000,
    update_time: t - 30,
    pay_time: t - 3900,
    ship_by_date: t + 2 * 86_400,
    total_amount: lines.reduce((n, l) => n + l.qty * 45_000, 0),
    buyer_user_id: 5000 + snSeq,
    buyer_username: "dewi",
    shipping_carrier: "SPX Standard",
    recipient_address: { name: "Dewi", phone: "6281200000", city: "Jakarta Barat", full_address: "Jl. Mawar 1" },
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

/** A signed Shopee push through the webhook process and its job (code 3 order status, 4 tracking number). */
async function pushShopee(tenantId: string, shopId: string, code: number, data: Record<string, unknown>) {
  const raw = JSON.stringify({ data, shop_id: Number(shopId), code, timestamp: nowSec() + snSeq++ });
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

const pushOrder = (tenantId: string, shopId: string, o: MockShopeeOrder) =>
  pushShopee(tenantId, shopId, 3, { ordersn: o.order_sn, status: o.order_status, update_time: o.update_time });

/** An Admin invited through the email flow, limited to the given stores. */
async function addAdmin(owner: Client, tenantId: string, scope: { storeIds: string[] }) {
  const roles = (await owner.get("/v1/roles")).body.items as { id: string; name: string }[];
  const email = uniqueEmail("admin");
  const invite = await owner.post("/v1/invitations", { email, roleId: roles.find((r) => r.name === "Admin")!.id });
  expect(invite.status).toBe(201);
  await drain(tenantId);
  const member = client(api);
  const accepted = await member.post("/v1/auth/invitations/accept", {
    token: tokenFrom(worker.email.lastTo(email)!.text),
    name: "Budi",
    password: PASSWORD,
  });
  expect(accepted.status).toBe(201);
  expect((await owner.put(`/v1/users/${accepted.body.user.id}/scopes`, scope)).status).toBe(200);
  return member;
}

async function orderBy(c: Client, externalOrderId: string) {
  const list = (await c.get(`/v1/orders?q=${externalOrderId}`)).body.items as { id: string; externalOrderId: string }[];
  const found = list.find((o) => o.externalOrderId === externalOrderId);
  expect(found, `order ${externalOrderId}`).toBeDefined();
  return (await c.get(`/v1/orders/${found!.id}`)).body;
}

async function shipmentOf(c: Client, orderId: string) {
  const res = await c.get(`/v1/orders/${orderId}/shipments`);
  expect(res.status).toBe(200);
  return res.body.items[0];
}

async function pdfOf(c: Client, downloadUrl: string) {
  const res = await c
    .get(downloadUrl)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (d: Buffer) => chunks.push(d));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("application/pdf");
  expect(res.headers["cache-control"]).toContain("no-store");
  return PDFDocument.load(res.body as Buffer);
}

describe("arranging Shopee shipments and printing labels (FR-SHP-01, 06, FR-ORD-08)", () => {
  it("accepts new orders, books the recommended pickup in mass, stores the labels, and merges them in pick-list order", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await stock(
      c,
      warehouseId,
      { [v["KAOS-M"]!]: 10, [v["KAOS-L"]!]: 10 },
      { [v["KAOS-M"]!]: "A-2-01", [v["KAOS-L"]!]: "A-1-05" },
    );
    const { shopId, orders } = await connectShopee(c, tenantId, 601);
    const o1 = shopeeOrder(601, [{ model: 6011, sku: "KAOS-M", qty: 2 }]);
    const o2 = shopeeOrder(601, [{ model: 6012, sku: "KAOS-L", qty: 1 }]);
    orders.push(o1, o2);
    await pushOrder(tenantId, shopId, o1);
    await pushOrder(tenantId, shopId, o2);
    const [a, b] = [await orderBy(c, o1.order_sn), await orderBy(c, o2.order_sn)];
    expect([a.status, b.status]).toEqual(["new", "new"]);

    // "Proses semua yang baru": accept and arrange in one call
    const arranged = await c.post("/v1/shipments/arrange", { orderIds: [a.id, b.id], method: "pickup" });
    expect(arranged.status).toBe(200);
    expect(arranged.body.items).toEqual([
      { id: a.id, ok: true },
      { id: b.id, ok: true },
    ]);
    expect((await orderBy(c, o1.order_sn)).status).toBe("ready_to_pack");
    expect((await shipmentOf(c, a.id)).status).toBe("pending");

    const ran = await drain(tenantId);
    expect(ran).toEqual(expect.arrayContaining(["shipment.arrange", "label.fetch"]));
    // one mass call for both packages: same channel and warehouse, the address marked for pickup, the recommended slot
    const shipCalls = mock.callsTo("POST", "/api/v2/logistics/mass_ship_order").map((x) => JSON.parse(x.body));
    const mine = shipCalls.filter((x) =>
      x.package_list.some((p: { package_number: string }) => p.package_number === `OFG${o1.order_sn}`),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      logistics_channel_id: 8003,
      product_location_id: "IDZ",
      package_list: expect.arrayContaining([
        { package_number: `OFG${o1.order_sn}` },
        { package_number: `OFG${o2.order_sn}` },
      ]),
      pickup: { address_id: 3001 },
    });
    const slot = Number(mine[0].pickup.pickup_time_id);

    const s1 = await shipmentOf(c, a.id);
    expect(s1).toMatchObject({
      status: "label_ready",
      statusLabel: "Label siap",
      method: "pickup",
      provider: "SPX Standard",
      labelReady: true,
      lastError: null,
      pickupAt: new Date(slot * 1000).toISOString(),
    });
    expect(s1.trackingNumber).toMatch(/^SPXID/);
    expect(s1.packages).toMatchObject([{ externalPackageId: `OFG${o1.order_sn}`, trackingNumber: s1.trackingNumber }]);
    expect(s1.packages[0].items).toEqual([{ orderItemId: a.items[0].id, qty: 2 }]);
    // the airway bill was asked for as thermal, with the tracking number
    const created = mock
      .callsTo("POST", "/api/v2/logistics/create_shipping_document")
      .flatMap(
        (x) =>
          JSON.parse(x.body).order_list as {
            package_number: string;
            tracking_number: string;
            shipping_document_type: string;
          }[],
      )
      .find((x) => x.package_number === `OFG${o1.order_sn}`);
    expect(created).toMatchObject({
      tracking_number: s1.trackingNumber,
      shipping_document_type: "THERMAL_AIR_WAYBILL",
    });

    const detail = await orderBy(c, o1.order_sn);
    expect(detail).toMatchObject({
      status: "ready_to_pack",
      externalStatus: "PROCESSED",
      trackingNumber: s1.trackingNumber,
    });
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(["shipment_requested", "shipment_arranged", "label_ready"]),
    );

    // packing an order whose label is ready makes it ready to ship
    expect((await c.post("/v1/orders/pack", { orderIds: [a.id] })).body.items).toEqual([{ id: a.id, ok: true }]);
    await drain(tenantId);
    expect((await orderBy(c, o1.order_sn)).status).toBe("ready_to_ship");
    expect(await shipmentOf(c, a.id)).toMatchObject({ status: "packed" });

    // one PDF for both, thermal, in pick-list order
    const requested = await c.post("/v1/documents", { kind: "labels", orderIds: [a.id, b.id], format: "thermal" });
    expect(requested.status).toBe(202);
    expect(requested.body).toMatchObject({
      kind: "labels",
      status: "queued",
      format: "thermal",
      orderCount: 2,
      downloadUrl: null,
    });
    await drain(tenantId);
    const doc = (await c.get(`/v1/documents/${requested.body.id}`)).body;
    expect(doc).toMatchObject({ status: "ready", pageCount: 2, result: { orders: 2, labels: 2, missing: [] } });
    const pdf = await pdfOf(c, doc.downloadUrl);
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getPage(0).getSize().width).toBeCloseTo(THERMAL_PAGE.width, 3);
    expect((await orderBy(c, o2.order_sn)).events.map((e: { type: string }) => e.type)).toContain("label_printed");

    // the courier picks the parcel up: the order ships and the shipment is in transit
    o1.order_status = "SHIPPED";
    o1.update_time = nowSec() + 5;
    await pushOrder(tenantId, shopId, o1);
    expect((await orderBy(c, o1.order_sn)).status).toBe("shipped");
    expect(await shipmentOf(c, a.id)).toMatchObject({ status: "in_transit", statusLabel: "Dalam perjalanan" });
  });

  it("refuses what cannot be arranged, records marketplace refusals, and arranges again with the other method", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 20, [v["KAOS-L"]!]: 20 });
    const { shopId, orders } = await connectShopee(c, tenantId, 602);
    const readOnly = await connectShopee(c, tenantId, 603, false);
    const ok = shopeeOrder(602, [{ model: 6021, sku: "KAOS-M", qty: 1 }]);
    const refused = shopeeOrder(602, [{ model: 6022, sku: "KAOS-L", qty: 1 }]);
    const inCancel = shopeeOrder(602, [{ model: 6021, sku: "KAOS-M", qty: 1 }], { order_status: "IN_CANCEL" });
    const unpaid = shopeeOrder(602, [{ model: 6021, sku: "KAOS-M", qty: 1 }], { order_status: "UNPAID" });
    const parallel = shopeeOrder(603, [{ model: 6031, sku: "KAOS-M", qty: 1 }]);
    orders.push(ok, refused, inCancel, unpaid);
    readOnly.orders.push(parallel);
    for (const o of [ok, refused, inCancel, unpaid]) await pushOrder(tenantId, shopId, o);
    await pushOrder(tenantId, readOnly.shopId, parallel);
    const ids = await Promise.all(
      [ok, refused, inCancel, unpaid, parallel].map(async (o) => (await orderBy(c, o.order_sn)).id),
    );
    mock.shopeeRefuse.set(`OFG${refused.order_sn}`, "Alamat pembeli tidak bisa dijangkau kurir.");

    const res = await c.post("/v1/shipments/arrange", { orderIds: ids, method: "pickup" });
    expect(res.body.items.map((r: { ok: boolean; code?: string }) => r.code ?? "ok")).toEqual([
      "ok",
      "ok",
      "order.cancel_requested",
      "order.status_invalid",
      "store.read_only",
    ]);
    await drain(tenantId);
    expect(await shipmentOf(c, ids[0]!)).toMatchObject({ status: "label_ready" });
    const failed = await shipmentOf(c, ids[1]!);
    expect(failed).toMatchObject({
      status: "pending",
      lastError: "Alamat pembeli tidak bisa dijangkau kurir.",
      labelReady: false,
    });
    expect((await orderBy(c, refused.order_sn)).events.map((e: { type: string }) => e.type)).toContain(
      "shipment_failed",
    );

    // arranged already; the refused one may go again, now as drop-off
    const again = await c.post("/v1/shipments/arrange", { orderIds: [ids[0], ids[1]], method: "dropoff" });
    expect(again.body.items).toEqual([
      { id: ids[0], ok: false, code: "shipment.already_arranged", message: "Pengiriman pesanan ini sudah diatur." },
      { id: ids[1], ok: true },
    ]);
    mock.shopeeRefuse.delete(`OFG${refused.order_sn}`);
    await drain(tenantId);
    const last = mock
      .callsTo("POST", "/api/v2/logistics/mass_ship_order")
      .map((x) => JSON.parse(x.body))
      .at(-1);
    expect(last).toMatchObject({ package_list: [{ package_number: `OFG${refused.order_sn}` }], dropoff: {} });
    expect(await shipmentOf(c, ids[1]!)).toMatchObject({ status: "label_ready", method: "dropoff", lastError: null });
  });

  it("waits for the courier's tracking number and fetches the label when Shopee pushes it", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 5 });
    const { shopId, orders } = await connectShopee(c, tenantId, 604);
    const o = shopeeOrder(604, [{ model: 6041, sku: "KAOS-M", qty: 1 }]);
    orders.push(o);
    await pushOrder(tenantId, shopId, o);
    const { id } = await orderBy(c, o.order_sn);

    mock.shopeeTrackingDelay = 1;
    try {
      await c.post("/v1/shipments/arrange", { orderIds: [id], method: "pickup" });
      const failures: { job: string; error: unknown }[] = [];
      await drain(tenantId, failures);
      expect(failures.map((f) => [f.job, f.error instanceof LabelsPendingError])).toEqual([["label.fetch", true]]);
    } finally {
      mock.shopeeTrackingDelay = 0;
    }
    expect(await shipmentOf(c, id)).toMatchObject({
      status: "arranged",
      labelReady: false,
      lastError: "Menunggu nomor resi dari kurir.",
    });
    // no label yet: the document says why instead of printing an empty file
    const doc = await c.post("/v1/documents", { kind: "labels", orderIds: [id] });
    await drain(tenantId);
    expect((await c.get(`/v1/documents/${doc.body.id}`)).body).toMatchObject({
      status: "failed",
      error: "Tidak ada label yang bisa dicetak dari pesanan ini.",
      result: { missing: [{ orderId: id, code: "label.not_ready", message: "Menunggu nomor resi dari kurir." }] },
      downloadUrl: null,
    });

    // packed while the label is still on its way
    expect((await c.post("/v1/orders/pack", { orderIds: [id] })).body.items).toEqual([{ id, ok: true }]);
    await drain(tenantId);
    expect((await orderBy(c, o.order_sn)).status).toBe("packed");

    // push code 4: the tracking number is there; the label arrives and the packed order is ready to ship
    await pushShopee(tenantId, shopId, 4, {
      ordersn: o.order_sn,
      package_number: `OFG${o.order_sn}`,
      tracking_no: "x",
    });
    expect(await shipmentOf(c, id)).toMatchObject({ status: "packed", labelReady: true });
    expect((await orderBy(c, o.order_sn)).status).toBe("ready_to_ship");
  });
});

describe("Tokopedia & Shop drop-off, A4 labels, cancellations (FR-SHP-01, 06)", () => {
  it("ships packages for drop-off, prints four labels to an A4 page, and cancels the shipment with its order", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 10 });
    const t = nowSec();
    const orders: MockTiktokOrder[] = [];
    const order = (id: string, extra: Partial<MockTiktokOrder> = {}): MockTiktokOrder => ({
      id,
      status: "AWAITING_SHIPMENT",
      create_time: t - 4000,
      update_time: t - 30,
      paid_time: t - 3900,
      rts_sla_time: t + 86_400,
      commerce_platform: "TIKTOK_SHOP",
      fulfillment_type: "FULFILLMENT_BY_SELLER",
      warehouse_id: "7300000000000000001",
      user_id: `70214368104682300${id.slice(-2)}`,
      recipient_address: { name: "Budi", phone_number: "(+62)812****", full_address: "Jl. Melati 2" },
      payment: { currency: "IDR", sub_total: "45000", total_amount: "45000" },
      line_items: [
        {
          id: `58800000000000${id.slice(-2)}`,
          sku_id: "1729592969712207101",
          product_id: "1729592969712207100",
          seller_sku: "KAOS-M",
          product_name: "Kaos",
          sku_name: "M",
          sale_price: "45000",
          original_price: "50000",
        },
      ],
      ...extra,
    });
    const sellerId = mock.addTiktokSeller({
      openId: "7010000000000000801",
      name: "Toko Shop",
      shops: [
        {
          id: "7495000000000000801",
          name: "Toko Shop",
          region: "ID",
          cipher: "ROW_ship_a",
          warehouses: [{ id: "7300000000000000001", name: "Gudang", type: "SALES_WAREHOUSE", is_default: true }],
          products: [
            {
              id: "1729592969712207100",
              title: "Kaos",
              status: "ACTIVATE",
              update_time: 1_700_000_000,
              skus: [
                {
                  id: "1729592969712207101",
                  seller_sku: "KAOS-M",
                  price: 50_000,
                  attrs: {},
                  inventory: { "7300000000000000001": 1 },
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
    expect((await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" })).status).toBe(200);
    await drain(tenantId);

    orders.push(
      order("576486316948490801"),
      order("576486316948490802"),
      order("576486316948490803", { shipping_type: "SELLER" }),
    );
    await worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId);
    await drain(tenantId);
    const ids = await Promise.all(orders.map(async (o) => (await orderBy(c, o.id)).id as string));

    const res = await c.post("/v1/shipments/arrange", { orderIds: ids, method: "dropoff" });
    expect(res.body.items.every((r: { ok: boolean }) => r.ok)).toBe(true);
    await drain(tenantId);
    const shipBodies = mock.calls
      .filter((x) => x.method === "POST" && /\/fulfillment\/202309\/packages\/PKG\d+\/ship$/.test(x.path))
      .map((x) => [x.path.split("/")[4], JSON.parse(x.body)]);
    expect(shipBodies).toEqual([
      ["PKG576486316948490801", { handover_method: "DROP_OFF" }],
      ["PKG576486316948490802", { handover_method: "DROP_OFF" }],
    ]);
    expect(await shipmentOf(c, ids[0]!)).toMatchObject({
      status: "label_ready",
      method: "dropoff",
      provider: "J&T Express",
    });
    expect(await shipmentOf(c, ids[2]!)).toMatchObject({
      status: "pending",
      lastError: "Pesanan ini dikirim dengan kurir sendiri. Masukkan nomor resi di Seller Center.",
    });
    expect((await orderBy(c, orders[0]!.id)).externalStatus).toBe("AWAITING_COLLECTION");

    const doc = await c.post("/v1/documents", { kind: "labels", orderIds: ids, format: "a4" });
    await drain(tenantId);
    const ready = (await c.get(`/v1/documents/${doc.body.id}`)).body;
    expect(ready).toMatchObject({ status: "ready", format: "a4", pageCount: 1, result: { orders: 2, labels: 2 } });
    expect(ready.result.missing).toEqual([expect.objectContaining({ orderId: ids[2], code: "shipment.pending" })]);
    const pdf = await pdfOf(c, ready.downloadUrl);
    expect(pdf.getPage(0).getSize().height).toBeCloseTo(A4_PAGE.height, 3);

    // the buyer cancels before the drop-off: the shipment goes with the order
    Object.assign(orders[1]!, { status: "CANCELLED", cancellation_initiator: "BUYER", update_time: nowSec() + 5 });
    await worker.ctx
      .get(OrderSyncService, { strict: false })
      .refresh(systemContext(tenantId), storeId, [orders[1]!.id], { source: "webhook" });
    await drain(tenantId);
    expect((await orderBy(c, orders[1]!.id)).status).toBe("cancelled");
    expect((await c.get(`/v1/orders/${ids[1]}/shipments`)).body.items[0]).toMatchObject({ status: "cancelled" });
  });
});

describe("pick list (FR-SHP-02, FR-WHS-08)", () => {
  it("adds up the units per SKU, sorted by rack, lists unmapped SKUs, and leaves out what is not to pick", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await stock(
      c,
      warehouseId,
      { [v["KAOS-M"]!]: 10, [v["KAOS-L"]!]: 10 },
      { [v["KAOS-M"]!]: "A-10-01", [v["KAOS-L"]!]: "A-2-07" },
    );
    const { shopId, orders } = await connectShopee(c, tenantId, 605);
    const o1 = shopeeOrder(605, [{ model: 6051, sku: "KAOS-M", qty: 2 }]);
    const o2 = shopeeOrder(605, [
      { model: 6051, sku: "KAOS-M", qty: 1 },
      { model: 6052, sku: "KAOS-L", qty: 1 },
    ]);
    // a line of an item OmniSeller has no listing for: picked by its marketplace SKU
    const o3 = shopeeOrder(605, [{ model: 6051, sku: "KAOS-M", qty: 1 }]);
    o3.item_list.push({
      item_id: 9605,
      item_name: "Topi Rajut",
      model_id: 0,
      model_sku: "TOPI-RAJUT",
      model_quantity_purchased: 3,
      model_original_price: 20_000,
      model_discounted_price: 20_000,
    });
    const shipped = shopeeOrder(605, [{ model: 6052, sku: "KAOS-L", qty: 5 }], { order_status: "SHIPPED" });
    orders.push(o1, o2, o3, shipped);
    for (const o of orders) await pushOrder(tenantId, shopId, o);
    const ids = await Promise.all(orders.map(async (o) => (await orderBy(c, o.order_sn)).id as string));

    // the order with an unmapped SKU is a problem order: nothing is picked for it until it is handled
    const first = (await c.post("/v1/pick-lists", { orderIds: ids })).body;
    expect(first.sections[0]).toMatchObject({ warehouseId, orders: 2, units: 4 });
    expect(first.missing.map((m: { orderId: string; code: string }) => [m.orderId, m.code])).toEqual([
      [ids[2], "order.not_pickable"],
      [ids[3], "order.not_pickable"],
    ]);
    const problem = (await orderBy(c, o3.order_sn)).problems.find((p: { code: string }) => p.code === "unmapped_sku");
    expect(
      (await c.post(`/v1/orders/${ids[2]}/problems/${problem.id}/resolve`, { resolution: "kirim manual" })).status,
    ).toBe(204);
    expect((await orderBy(c, o3.order_sn)).status).toBe("new");

    const res = await c.post("/v1/pick-lists", { orderIds: ids });
    expect(res.status).toBe(200);
    expect(res.body.sections).toHaveLength(1);
    expect(res.body.sections[0]).toMatchObject({ warehouseId, orders: 3, units: 8 });
    expect(
      res.body.sections[0].lines.map((l: { sku: string; bin: string | null; qty: number; orders: number }) => [
        l.sku,
        l.bin,
        l.qty,
        l.orders,
      ]),
    ).toEqual([
      ["KAOS-L", "A-2-07", 1, 1],
      ["KAOS-M", "A-10-01", 4, 3],
      ["TOPI-RAJUT", null, 3, 1],
    ]);
    expect(res.body.missing).toEqual([expect.objectContaining({ orderId: ids[3], code: "order.not_pickable" })]);

    const doc = await c.post("/v1/documents", { kind: "pick_list", orderIds: ids });
    await drain(tenantId);
    const ready = (await c.get(`/v1/documents/${doc.body.id}`)).body;
    expect(ready).toMatchObject({ kind: "pick_list", status: "ready", format: null, pageCount: 1 });
    const pdf = await pdfOf(c, ready.downloadUrl);
    expect(pdf.getTitle()).toBe("Daftar ambil");
  });
});

describe("ship-by alerts (FR-SHP-10, FR-NTF-01)", () => {
  it("tells the people who arrange shipments once when an order nears its deadline and once when it is late", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 10 });
    const { shopId, storeId, orders } = await connectShopee(c, tenantId, 606);
    const elsewhere = await connectShopee(c, tenantId, 608);
    // admins limited to one store hear only about that store's orders
    const here = await addAdmin(c, tenantId, { storeIds: [storeId] });
    const there = await addAdmin(c, tenantId, { storeIds: [elsewhere.storeId] });
    const soon = shopeeOrder(606, [{ model: 6061, sku: "KAOS-M", qty: 1 }], { ship_by_date: nowSec() + 2 * 3600 });
    const later = shopeeOrder(606, [{ model: 6061, sku: "KAOS-M", qty: 1 }], { ship_by_date: nowSec() + 30 * 3600 });
    orders.push(soon, later);
    await pushOrder(tenantId, shopId, soon);
    await pushOrder(tenantId, shopId, later);
    const { id } = await orderBy(c, soon.order_sn);

    // the scheduler's scan finds the tenant
    const added: { name: string; payload: { tenantId: string }; jobId: string }[] = [];
    const queues = {
      get: () => ({
        add: async (name: string, payload: { tenantId: string }, o: { jobId: string }) =>
          added.push({ name, payload, jobId: o.jobId }),
      }),
    } as unknown as QueueRegistry;
    await scanSlaAlerts(h.system, queues, new JobRegistry(JOB_DEFINITIONS));
    expect(added.filter((a) => a.payload.tenantId === tenantId)).toEqual([
      expect.objectContaining({
        name: "order.sla_alert",
        jobId: expect.stringMatching(new RegExp(`^order\\.sla_alert\\|${tenantId}\\|a\\d+$`)),
      }),
    ]);

    await worker.runJob(orderSlaAlertJob, { slot: "t1" }, tenantId);
    await worker.runJob(orderSlaAlertJob, { slot: "t2" }, tenantId); // nothing new: no second alert
    let inbox = (await c.get("/v1/notifications")).body.items;
    expect(inbox).toEqual([
      expect.objectContaining({
        kind: "order.sla",
        severity: "warning",
        title: "1 pesanan harus segera dikirim",
        body: "1 jatuh tempo dalam 6 jam.",
        data: { overdue: 0, warning: 1, orderIds: [id] },
        readAt: null,
      }),
    ]);
    expect((await c.get("/v1/notifications/unread-count")).body).toEqual({ unread: 1 });
    expect((await here.get("/v1/notifications")).body.items).toEqual([expect.objectContaining({ kind: "order.sla" })]);
    expect((await there.get("/v1/notifications")).body.items).toEqual([]);

    // the deadline passes
    await withTenantTx(h.worker, userCtx(tenantId), (tx) =>
      tx.execute(sql`UPDATE "order" SET ship_by_at = now() - interval '5 minutes' WHERE id = ${id}`),
    );
    await worker.runJob(orderSlaAlertJob, { slot: "t3" }, tenantId);
    inbox = (await c.get("/v1/notifications?unread=true")).body.items;
    expect(inbox.map((n: { severity: string; body: string }) => [n.severity, n.body])).toEqual([
      ["critical", "1 sudah lewat batas kirim."],
      ["warning", "1 jatuh tempo dalam 6 jam."],
    ]);
    expect((await c.post("/v1/notifications/read", { all: true })).body).toEqual({ marked: 2 });
    expect((await c.get("/v1/notifications/unread-count")).body).toEqual({ unread: 0 });
    // another business sees none of it
    const other = await signup(api);
    expect((await other.c.get("/v1/notifications")).body.items).toEqual([]);
    expect((await other.c.post("/v1/notifications/read", { ids: [inbox[0].id] })).body).toEqual({ marked: 0 });
  });
});

describe("label retries", () => {
  it("runs the label job again with backoff until the label exists", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 5 });
    const { shopId, orders } = await connectShopee(c, tenantId, 607);
    const o = shopeeOrder(607, [{ model: 6071, sku: "KAOS-M", qty: 1 }]);
    orders.push(o);
    await pushOrder(tenantId, shopId, o);
    const { id } = await orderBy(c, o.order_sn);
    mock.shopeeTrackingDelay = 2;
    try {
      await c.post("/v1/shipments/arrange", { orderIds: [id], method: "dropoff" });
      await drain(tenantId, []);
      const shipment = await shipmentOf(c, id);
      // BullMQ runs the job again: once more pending, then the label
      await expect(worker.runJob(labelFetchJob, { shipmentIds: [shipment.id] }, tenantId, 1)).rejects.toBeInstanceOf(
        LabelsPendingError,
      );
      await worker.runJob(labelFetchJob, { shipmentIds: [shipment.id] }, tenantId, 2);
    } finally {
      mock.shopeeTrackingDelay = 0;
    }
    expect(await shipmentOf(c, id)).toMatchObject({ status: "label_ready", lastError: null });
  });
});
