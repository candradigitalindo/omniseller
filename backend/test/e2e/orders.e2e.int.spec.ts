import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { StockHistoryService } from "../../src/modules/inventory/stock-history.service";
import { orderPullJob } from "../../src/modules/orders/orders.jobs";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
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
  type MockTiktokProduct,
} from "../setup/mock-marketplace";

/**
 * Orders end to end (PRD 6.4, 13.2; backend doc 8.14): intake from webhooks and polling, the 90-day
 * import, reservations at the mapped warehouse, problems, the marketplace status path, seller actions,
 * and the stock that follows, against the fake Shopee and TikTok Shop.
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 700000;
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

async function setStock(c: Client, warehouseId: string, lines: Record<string, number>) {
  const res = await c.post("/v1/inventory/adjustments", {
    lines: Object.entries(lines).map(([variantId, quantity]) => ({ variantId, warehouseId, mode: "set", quantity })),
    reason: "correction",
  });
  expect(res.status).toBe(200);
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

async function connectShopee(c: Client, tenantId: string, items: MockShopeeItem[], orders: MockShopeeOrder[] = []) {
  const shopId = String(++shopSeq);
  mock.addShopeeShop({ shopId, name: `Toko ${shopId}`, region: "ID", warehouses: "not_whitelisted", items, orders });
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

function shopeeOrder(
  itemId: number,
  lines: { model: number; sku: string; qty: number }[],
  extra: Partial<MockShopeeOrder> = {},
): MockShopeeOrder {
  const t = nowSec();
  return {
    order_sn: `2610030${String(snSeq++).padStart(6, "0")}`,
    order_status: "READY_TO_SHIP",
    create_time: t - 60,
    update_time: t - 30,
    pay_time: t - 50,
    ship_by_date: t + 2 * 86_400,
    cod: false,
    total_amount: lines.reduce((n, l) => n + l.qty * 45_000, 0),
    buyer_user_id: 4242,
    buyer_username: "dewi",
    shipping_carrier: "SPX Express",
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

/** A signed Shopee order push (code 3), through the webhook process and its job. */
async function pushShopeeOrder(tenantId: string, shopId: string, o: MockShopeeOrder) {
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

/** Invites a member with a built-in role and an optional store scope, and signs them in. */
async function addMember(owner: Client, tenantId: string, role: string, scope?: { storeIds: string[] }) {
  const roles = (await owner.get("/v1/roles")).body.items as { id: string; name: string }[];
  const email = uniqueEmail(role.toLowerCase());
  const invite = await owner.post("/v1/invitations", { email, roleId: roles.find((r) => r.name === role)!.id });
  expect(invite.status).toBe(201);
  await drain(tenantId);
  const member = client(api);
  const accepted = await member.post("/v1/auth/invitations/accept", {
    token: tokenFrom(worker.email.lastTo(email)!.text),
    name: role,
    password: PASSWORD,
  });
  expect(accepted.status).toBe(201);
  if (scope) expect((await owner.put(`/v1/users/${accepted.body.user.id}/scopes`, scope)).status).toBe(200);
  return member;
}

async function orderBy(c: Client, externalOrderId: string) {
  const list = (await c.get(`/v1/orders?q=${externalOrderId}`)).body.items as { id: string; externalOrderId: string }[];
  const found = list.find((o) => o.externalOrderId === externalOrderId);
  expect(found, `order ${externalOrderId}`).toBeDefined();
  return (await c.get(`/v1/orders/${found!.id}`)).body;
}

async function stockOf(c: Client, sku: string) {
  return (await c.get(`/v1/inventory?q=${sku}`)).body.items[0].warehouses[0] as {
    onHand: number;
    reserved: number;
    available: number;
  };
}

describe("orders from Shopee (FR-ORD-01, 02, 05, 06, 14, FR-STK-03)", () => {
  it("takes an order once however often the webhook comes, reserves it, and pushes the same stock everywhere", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 10, [v["KAOS-L"]!]: 5 });
    const { shopId, storeId } = await connectShopee(c, tenantId, [kaosItem(501)]);

    const tiktokProducts: MockTiktokProduct[] = [
      {
        id: "1729592969712209100",
        title: "Kaos",
        status: "ACTIVATE",
        update_time: 1_700_000_000,
        skus: [
          {
            id: "1729592969712209101",
            seller_sku: "KAOS-M",
            price: 50_000,
            attrs: {},
            inventory: { "7100000000000000001": 3 },
          },
        ],
      },
    ];
    const sellerId = mock.addTiktokSeller({
      openId: "7010000000000000701",
      name: "Toko Shop",
      shops: [
        {
          id: "7495000000000000701",
          name: "Toko Shop",
          region: "ID",
          cipher: "ROW_orders_a",
          warehouses: [{ id: "7100000000000000001", name: "Gudang", type: "SALES_WAREHOUSE", is_default: true }],
          products: tiktokProducts,
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
    const tiktokStoreId = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body.result.stores[0].storeId;
    for (const id of [storeId, tiktokStoreId]) {
      expect((await c.patch(`/v1/stores/${id}`, { syncMode: "live" })).status).toBe(200);
    }
    await drain(tenantId);
    await worker.flushStock(tenantId);

    const o = shopeeOrder(501, [{ model: 5011, sku: "KAOS-M", qty: 2 }]);
    mock.shopeeShops.get(shopId)!.orders!.push(o);
    await pushShopeeOrder(tenantId, shopId, o);
    await pushShopeeOrder(tenantId, shopId, o); // the same notification again

    const all = (await c.get(`/v1/orders?storeId=${storeId}`)).body.items;
    expect(all).toHaveLength(1);
    const order = await orderBy(c, o.order_sn);
    expect(order).toMatchObject({
      status: "new",
      statusLabel: "Baru",
      externalStatus: "READY_TO_SHIP",
      warehouseId,
      total: 90_000,
      buyerName: "Dewi",
      shippingAddress: { name: "Dewi", city: "Jakarta Barat", line1: "Jl. Mawar 1" },
      sla: { state: "ok" },
      problems: [],
    });
    expect(order.items).toMatchObject([{ sku: "KAOS-M", qty: 2, reservedQty: 2, variantId: v["KAOS-M"], warehouseId }]);
    expect(order.events.map((e: { type: string }) => e.type)).toEqual(["created"]);
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 10, reserved: 2, available: 8 });

    // PRD 13.2: the new stock reaches every listing with the same absolute value
    const shopeeBefore = mock.callsTo("POST", "/api/v2/product/update_stock").length;
    await worker.flushStock(tenantId);
    const shopeeSent = mock
      .callsTo("POST", "/api/v2/product/update_stock")
      .slice(shopeeBefore)
      .map((x) => JSON.parse(x.body));
    expect(shopeeSent).toContainEqual({
      item_id: 501,
      stock_list: [{ model_id: 5011, seller_stock: [{ location_id: "IDZ", stock: 8 }] }],
    });
    expect(tiktokProducts[0]!.skus[0]!.inventory).toEqual({ "7100000000000000001": 8 });
  });

  it("flags an unmapped SKU without touching stock, and reserves once the listing is mapped", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    const t = await product(c, "TOPI", ["TOPI-1"]);
    await setStock(c, warehouseId, { [t["TOPI-1"]!]: 4 });
    const items = [kaosItem(601)];
    const { shopId } = await connectShopee(c, tenantId, items);
    // an item the shop added after the last listing pull, with a SKU nobody uses
    items.push({
      item_id: 602,
      item_name: "Topi",
      item_sku: "TOPI-LAMA",
      item_status: "NORMAL",
      update_time: 1,
      price: 30_000,
      stock: 9,
    });
    const o = shopeeOrder(602, [{ model: 0, sku: "TOPI-LAMA", qty: 1 }]);
    mock.shopeeShops.get(shopId)!.orders!.push(o);
    await pushShopeeOrder(tenantId, shopId, o);

    let order = await orderBy(c, o.order_sn);
    expect(order.status).toBe("problem");
    expect(order.problems).toMatchObject([{ code: "unmapped_sku", resolvedAt: null }]);
    expect(order.items[0]).toMatchObject({ variantId: null, reservedQty: 0 });
    expect(await stockOf(c, "TOPI-1")).toMatchObject({ reserved: 0, available: 4 });
    // the unknown item was read right away, so it can be mapped
    const listing = (await c.get("/v1/listings?q=Topi")).body.items[0];
    expect(listing).toMatchObject({ externalItemId: "602", mapping: null });

    await c.put(`/v1/listings/${listing.id}/mapping`, { variantId: t["TOPI-1"] });
    await drain(tenantId);
    order = await orderBy(c, o.order_sn);
    expect(order.status).toBe("new");
    expect(order.problems).toMatchObject([{ code: "unmapped_sku", resolution: "auto" }]);
    expect(order.items[0]).toMatchObject({ variantId: t["TOPI-1"], reservedQty: 1 });
    expect(await stockOf(c, "TOPI-1")).toMatchObject({ reserved: 1, available: 3 });
    expect(v["KAOS-M"]).toBeDefined();
  });

  it("follows the marketplace: progress changes nothing, shipped takes stock out, buyer cancellation releases it", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 10, [v["KAOS-L"]!]: 10 });
    const { shopId } = await connectShopee(c, tenantId, [kaosItem(701)]);
    const shop = mock.shopeeShops.get(shopId)!;

    const sold = shopeeOrder(701, [{ model: 7011, sku: "KAOS-M", qty: 3 }]);
    const cancelled = shopeeOrder(701, [{ model: 7012, sku: "KAOS-L", qty: 2 }]);
    shop.orders!.push(sold, cancelled);
    await pushShopeeOrder(tenantId, shopId, sold);
    await pushShopeeOrder(tenantId, shopId, cancelled);
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 10, reserved: 3 });
    expect(await stockOf(c, "KAOS-L")).toMatchObject({ onHand: 10, reserved: 2 });

    const move = async (o: MockShopeeOrder, status: string, extra: Partial<MockShopeeOrder> = {}) => {
      Object.assign(o, { order_status: status, update_time: o.update_time + 10, ...extra });
      await pushShopeeOrder(tenantId, shopId, o);
    };
    await move(sold, "PROCESSED");
    expect(await orderBy(c, sold.order_sn)).toMatchObject({ status: "new", externalStatus: "PROCESSED" });

    await move(sold, "SHIPPED");
    let order = await orderBy(c, sold.order_sn);
    expect(order).toMatchObject({ status: "shipped", externalStatus: "SHIPPED" });
    expect(order.items[0]).toMatchObject({ reservedQty: 0, shippedQty: 3 });
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 7, reserved: 0, available: 7 });
    const card = (await c.get(`/v1/inventory/movements?variantId=${v["KAOS-M"]}`)).body.items;
    expect(card[0]).toMatchObject({
      type: "order_ship",
      onHandDelta: -3,
      reservedDelta: -3,
      referenceType: "order_item",
      document: { type: "order", id: order.id, number: sold.order_sn },
    });
    // someone who sees only another store sees the movement, not the order behind it
    const other = await connectShopee(c, tenantId, []);
    const viewer = await addMember(c, tenantId, "Viewer", { storeIds: [other.storeId] });
    expect((await viewer.get(`/v1/inventory/movements?variantId=${v["KAOS-M"]}`)).body.items[0]).toMatchObject({
      id: card[0].id,
      document: null,
    });
    // nor for someone who may read stock but not orders (no built-in role is like that yet)
    const history = worker.ctx.get(StockHistoryService);
    const stockOnly = { ...userCtx(tenantId), permissions: new Set(["inventory:read"]) };
    expect(await history.documentsOf(stockOnly, [card[0]])).toEqual(new Map());
    expect((await history.documentsOf(userCtx(tenantId), [card[0]])).get(card[0].id)).toEqual({
      type: "order",
      id: order.id,
      number: sold.order_sn,
    });

    // a late notification with an older snapshot changes nothing
    const late = { ...sold, order_status: "READY_TO_SHIP", update_time: sold.update_time - 5 };
    shop.orders![shop.orders!.indexOf(sold)] = late;
    await pushShopeeOrder(tenantId, shopId, late);
    expect(await orderBy(c, sold.order_sn)).toMatchObject({ status: "shipped", externalStatus: "SHIPPED" });
    shop.orders![shop.orders!.indexOf(late)] = sold;

    await move(sold, "COMPLETED");
    order = await orderBy(c, sold.order_sn);
    expect(order.status).toBe("completed");
    expect(order.events.map((e: { type: string; toStatus: string | null }) => `${e.type}:${e.toStatus ?? ""}`)).toEqual(
      ["created:new", "status_changed:shipped", "status_changed:completed"],
    );

    await move(cancelled, "CANCELLED", { cancel_by: "buyer", cancel_reason: "Ganti alamat" });
    order = await orderBy(c, cancelled.order_sn);
    expect(order).toMatchObject({ status: "cancelled", cancelledBy: "buyer", cancelReason: "Ganti alamat" });
    expect(await stockOf(c, "KAOS-L")).toMatchObject({ onHand: 10, reserved: 0, available: 10 });
  });

  it("accepts and packs in bulk, refuses what cannot move, and cancels at the marketplace (FR-ORD-08, 10, 13)", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 10, [v["KAOS-L"]!]: 10 });
    const { shopId, storeId } = await connectShopee(c, tenantId, [kaosItem(801)]);
    const shop = mock.shopeeShops.get(shopId)!;
    const a = shopeeOrder(801, [{ model: 8011, sku: "KAOS-M", qty: 1 }]);
    const b = shopeeOrder(801, [{ model: 8012, sku: "KAOS-L", qty: 2 }], { buyer_user_id: 5151 });
    const big = shopeeOrder(801, [{ model: 8011, sku: "KAOS-M", qty: 1 }], {
      total_amount: 12_000_000,
      buyer_user_id: 6161,
    });
    shop.orders!.push(a, b, big);
    for (const o of [a, b, big]) await pushShopeeOrder(tenantId, shopId, o);
    const [oa, ob, obig] = [await orderBy(c, a.order_sn), await orderBy(c, b.order_sn), await orderBy(c, big.order_sn)];
    expect(obig).toMatchObject({ status: "problem", problems: [{ code: "high_value" }] });

    // read-only store: orders are processed in the old application
    const readOnly = await c.post("/v1/orders/accept", { orderIds: [oa.id] });
    expect(readOnly.body.items).toEqual([expect.objectContaining({ id: oa.id, ok: false, code: "store.read_only" })]);
    expect((await c.get(`/v1/orders/${oa.id}/cancel-reasons`)).body.items.length).toBeGreaterThan(0);
    expect((await c.post(`/v1/orders/${oa.id}/cancel`, { reason: "CUSTOMER_REQUEST" })).body.code).toBe(
      "order.not_cancellable",
    );

    expect((await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" })).status).toBe(200);
    await drain(tenantId);
    const accepted = await c.post("/v1/orders/accept", { orderIds: [oa.id, ob.id, obig.id] });
    expect(accepted.body.items.map((r: { ok: boolean; code?: string }) => r.code ?? "ok")).toEqual([
      "ok",
      "ok",
      "order.has_problems",
    ]);
    expect((await c.post("/v1/orders/accept", { orderIds: [oa.id, newId()] })).status).toBe(404);
    expect((await c.post("/v1/orders/pack", { orderIds: [oa.id] })).body.items[0]).toMatchObject({ ok: true });
    expect((await c.get(`/v1/orders/${oa.id}`)).body.status).toBe("packed");

    // a problem resolved by the seller is not raised again
    const problemId = obig.problems[0].id as string;
    expect(
      (await c.post(`/v1/orders/${obig.id}/problems/${problemId}/resolve`, { resolution: "sudah dikonfirmasi" }))
        .status,
    ).toBe(204);
    expect((await c.get(`/v1/orders/${obig.id}`)).body).toMatchObject({ status: "new" });

    expect((await c.put(`/v1/orders/${ob.id}/note`, { note: "kirim pagi" })).status).toBe(204);
    const reasons = (await c.get(`/v1/orders/${ob.id}/cancel-reasons`)).body.items;
    expect(reasons.map((r: { code: string }) => r.code)).toEqual([
      "OUT_OF_STOCK",
      "CUSTOMER_REQUEST",
      "COD_NOT_SUPPORTED",
    ]);
    expect((await c.post(`/v1/orders/${ob.id}/cancel`, { reason: "WRONG" })).status).toBe(422);
    expect((await c.post(`/v1/orders/${ob.id}/cancel`, { reason: "OUT_OF_STOCK" })).status).toBe(202);
    await drain(tenantId);
    const cancelCall = JSON.parse(mock.callsTo("POST", "/api/v2/order/cancel_order").at(-1)!.body);
    expect(cancelCall).toEqual({
      order_sn: b.order_sn,
      cancel_reason: "OUT_OF_STOCK",
      item_list: [{ item_id: 801, model_id: 8012 }],
    });
    const done = (await c.get(`/v1/orders/${ob.id}`)).body;
    expect(done).toMatchObject({ status: "cancelled", cancelledBy: "seller", internalNote: "kirim pagi" });
    expect(done.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(["note_changed", "cancel_requested", "status_changed"]),
    );
    expect(await stockOf(c, "KAOS-L")).toMatchObject({ reserved: 0, available: 10 });
  });
});

describe("90-day import and polling (FR-INT-04, 05, FR-MIG-04)", () => {
  it("imports open orders with reservations and history without touching stock, then polls changes", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 20 });
    const day = 86_400;
    const at = (daysAgo: number) => nowSec() - daysAgo * day;
    const history = [
      shopeeOrder(901, [{ model: 9011, sku: "KAOS-M", qty: 1 }], {
        create_time: at(100),
        update_time: at(99),
        order_status: "COMPLETED",
      }),
      shopeeOrder(901, [{ model: 9011, sku: "KAOS-M", qty: 2 }], {
        create_time: at(60),
        update_time: at(55),
        order_status: "COMPLETED",
      }),
      shopeeOrder(901, [{ model: 9011, sku: "KAOS-M", qty: 4 }], {
        create_time: at(20),
        update_time: at(18),
        order_status: "SHIPPED",
      }),
      shopeeOrder(901, [{ model: 9011, sku: "KAOS-M", qty: 3 }], { create_time: at(2), update_time: at(1) }),
    ];
    const { shopId, storeId } = await connectShopee(c, tenantId, [kaosItem(901)], history);
    const imported = (await c.get(`/v1/orders?storeId=${storeId}`)).body.items as {
      externalOrderId: string;
      status: string;
    }[];
    // newest first: ids follow the time the order was placed
    expect(imported.map((o) => o.status)).toEqual(["new", "shipped", "completed"]);
    expect(imported.map((o) => o.externalOrderId)).toEqual(
      [history[3]!, history[2]!, history[1]!].map((o) => o.order_sn),
    );
    // only the open order holds stock; shipped history is already outside the counted stock
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 20, reserved: 3, available: 17 });
    // the import walked 90 days in 15-day windows
    const windows = mock.callsTo("GET", "/api/v2/order/get_order_list").filter((x) => x.query.shop_id === shopId);
    expect(windows.length).toBeGreaterThanOrEqual(6);
    expect(windows.every((w) => Number(w.query.time_to) - Number(w.query.time_from) <= 15 * day)).toBe(true);

    // initial stock waits for the order import (it counts open orders' reservations)
    await withTenantTx(h.worker, userCtx(tenantId), (tx) =>
      tx.execute(sql`UPDATE store SET last_order_sync_at = NULL WHERE id = ${storeId}`),
    );
    expect((await c.post("/v1/inventory/initial-stock", { storeId, dryRun: true })).body.code).toBe(
      "store.orders_importing",
    );

    // the 5-minute poll reads what changed since the import
    const open = history[3]!;
    Object.assign(open, { order_status: "SHIPPED", update_time: nowSec() });
    await worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId);
    await drain(tenantId);
    expect((await orderBy(c, open.order_sn)).status).toBe("shipped");
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 17, reserved: 0, available: 17 });
  });
});

describe("orders from Tokopedia & Shop (FR-WHS-06, FR-WHS-10, FR-MFS-03)", () => {
  it("reserves at the warehouse the marketplace chose, keeps FBT orders out of stock, and flags unknown warehouses", async () => {
    const { c, tenantId, warehouseId } = await business();
    const surabaya = newId();
    await withTenantTx(h.api, userCtx(tenantId), (tx) =>
      tx.execute(
        sql`INSERT INTO warehouse (id, tenant_id, code, name, address) VALUES (${surabaya}, ${tenantId}, 'SBY', 'Gudang Surabaya', '{}')`,
      ),
    );
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 10 });
    await setStock(c, surabaya, { [v["KAOS-M"]!]: 6 });
    const t = nowSec();
    const line = (n: number, sku = "1729592969712208101") => ({
      id: `57700000000000${n}`,
      sku_id: sku,
      product_id: "1729592969712208100",
      seller_sku: "KAOS-M",
      product_name: "Kaos",
      sku_name: "M",
      sale_price: "45000",
      original_price: "50000",
    });
    const orders: MockTiktokOrder[] = [];
    const order = (id: string, extra: Partial<MockTiktokOrder>): MockTiktokOrder => ({
      id,
      status: "AWAITING_SHIPMENT",
      create_time: t - 60,
      update_time: t - 30,
      paid_time: t - 50,
      rts_sla_time: t + 3600,
      commerce_platform: "TOKOPEDIA",
      fulfillment_type: "FULFILLMENT_BY_SELLER",
      warehouse_id: "7200000000000000002",
      user_id: "7021436810468230001",
      recipient_address: { name: "Budi", phone_number: "(+62)812****", full_address: "Jl. Melati 2, Surabaya" },
      payment: { currency: "IDR", sub_total: "90000", shipping_fee: "10000", total_amount: "100000" },
      line_items: [line(1), line(2)],
      ...extra,
    });
    const products: MockTiktokProduct[] = [
      {
        id: "1729592969712208100",
        title: "Kaos",
        status: "ACTIVATE",
        update_time: 1_700_000_000,
        skus: [
          {
            id: "1729592969712208101",
            seller_sku: "KAOS-M",
            price: 50_000,
            attrs: {},
            inventory: { "7200000000000000001": 1, "7200000000000000002": 1 },
          },
        ],
      },
    ];
    const sellerId = mock.addTiktokSeller({
      openId: "7010000000000000702",
      name: "Toko Tokopedia",
      shops: [
        {
          id: "7495000000000000702",
          name: "Toko Tokopedia",
          region: "ID",
          cipher: "ROW_orders_b",
          warehouses: [
            { id: "7200000000000000001", name: "Warehouse Jakarta", type: "SALES_WAREHOUSE", is_default: true },
            { id: "7200000000000000002", name: "Warehouse Surabaya", type: "SALES_WAREHOUSE", is_default: false },
          ],
          fbt: [{ fbt_warehouse_id: "8200000000000000001", name: "FBT", subscribed: true }],
          products,
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
    const cws = (await c.get(`/v1/stores/${storeId}/channel-warehouses`)).body.items as {
      id: string;
      externalWarehouseId: string;
    }[];
    const cw = (ext: string) => cws.find((w) => w.externalWarehouseId === ext)!.id;
    await c.put(`/v1/stores/${storeId}/channel-warehouses/${cw("7200000000000000001")}`, { warehouseId });
    await c.put(`/v1/stores/${storeId}/channel-warehouses/${cw("7200000000000000002")}`, { warehouseId: surabaya });
    expect((await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" })).status).toBe(200);
    await drain(tenantId);

    orders.push(
      order("576486316948490101", {}),
      order("576486316948490102", { fulfillment_type: "FULFILLMENT_BY_TIKTOK", warehouse_id: "8200000000000000001" }),
      order("576486316948490103", { warehouse_id: "7200000000000000099", line_items: [line(3)] }),
    );
    await worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId);
    await drain(tenantId);

    const sby = await orderBy(c, "576486316948490101");
    expect(sby).toMatchObject({ status: "new", platform: "TOKOPEDIA", warehouseId: surabaya, total: 100_000 });
    expect(sby.items).toMatchObject([{ sku: "KAOS-M", qty: 2, reservedQty: 2, warehouseId: surabaya }]);
    const rows = (await c.get("/v1/inventory?q=KAOS-M")).body.items[0].warehouses as {
      warehouseId: string;
      reserved: number;
    }[];
    expect(rows.find((r) => r.warehouseId === surabaya)!.reserved).toBe(2);
    expect(rows.find((r) => r.warehouseId === warehouseId)!.reserved).toBe(0);

    const fbt = await orderBy(c, "576486316948490102");
    expect(fbt).toMatchObject({ status: "marketplace_fulfilled", fulfillmentMode: "marketplace", problems: [] });
    expect(fbt.items[0]).toMatchObject({ reservedQty: 0 });

    const unknown = await orderBy(c, "576486316948490103");
    expect(unknown.status).toBe("problem");
    expect(unknown.problems).toMatchObject([
      { code: "unmapped_warehouse", detail: { externalWarehouseIds: ["7200000000000000099"] } },
    ]);

    // seller cancellation with an Indonesian reason; the stock comes back at Surabaya
    const reasons = (await c.get(`/v1/orders/${sby.id}/cancel-reasons`)).body.items.map(
      (r: { code: string }) => r.code,
    );
    expect(reasons).toEqual(["seller_cancel_reason_out_of_stock", "seller_cancel_reason_wrong_price"]);
    expect((await c.post(`/v1/orders/${sby.id}/cancel`, { reason: "seller_cancel_reason_wrong_price" })).status).toBe(
      202,
    );
    await drain(tenantId);
    expect((await orderBy(c, "576486316948490101")).status).toBe("cancelled");
    const after = (await c.get("/v1/inventory?q=KAOS-M")).body.items[0].warehouses as {
      warehouseId: string;
      reserved: number;
    }[];
    expect(after.find((r) => r.warehouseId === surabaya)!.reserved).toBe(0);

    // list filters, the ship-by sort, and the summary
    const problems = (await c.get(`/v1/orders?storeId=${storeId}&status=problem`)).body.items;
    expect(problems.map((o: { externalOrderId: string }) => o.externalOrderId)).toEqual(["576486316948490103"]);
    const due = (await c.get(`/v1/orders?storeId=${storeId}&due=soon&sort=ship_by&limit=1`)).body;
    expect(due.items[0].sla.state).toBe("warning");
    const summary = (await c.get(`/v1/orders/summary?storeId=${storeId}`)).body;
    expect(summary.statuses).toMatchObject({ problem: 1, marketplace_fulfilled: 1, cancelled: 1 });
    expect(summary.dueSoon).toBe(1);
  });
});
