import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { sql } from "drizzle-orm";
import { unzipSync } from "fflate";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { orderNewNoticeJob } from "../../src/modules/orders/orders.jobs";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
import { scanNewOrderNotices } from "../../src/scheduler/order-scans";
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
import { MockMarketplace, type MockShopeeItem, type MockShopeeOrder } from "../setup/mock-marketplace";

/**
 * The rest of MVP-1 end to end: in-app notifications (PRD FR-NTF-01), the home dashboard (FR-RPT-01),
 * the full data export (FR-MIG-09), and the audit entries of sensitive actions (FR-USR-04).
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 980000;
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
  return res.body.items as { movementId: string | null }[];
}

const kaosItem = (itemId: number, extra: Partial<MockShopeeItem> = {}): MockShopeeItem => ({
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
  ...extra,
});

async function connectShopee(
  c: Client,
  tenantId: string,
  items: MockShopeeItem[],
  opts: { live?: boolean; orders?: MockShopeeOrder[] } = {},
) {
  const shopId = String(++shopSeq);
  const orders = opts.orders ?? [];
  mock.addShopeeShop({ shopId, name: `Toko ${shopId}`, region: "ID", warehouses: "not_whitelisted", items, orders });
  const started = await c.post("/v1/store-authorizations", { channel: "shopee" });
  await c.post("/v1/store-authorizations/callback", {
    channel: "shopee",
    state: new URL(started.body.authorizeUrl).searchParams.get("state"),
    code: mock.shopeeCode({ shopId }),
    shopId,
  });
  await drain(tenantId);
  const storeId = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body.result.stores[0].storeId as string;
  if (opts.live ?? true) expect((await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" })).status).toBe(200);
  await drain(tenantId);
  return { shopId, storeId, orders, name: `Toko ${shopId}` };
}

function shopeeOrder(
  itemId: number,
  lines: { model: number; sku: string; qty: number }[],
  extra: Partial<MockShopeeOrder> = {},
): MockShopeeOrder {
  const t = nowSec();
  return {
    order_sn: `2610050${String(snSeq++).padStart(6, "0")}`,
    order_status: "READY_TO_SHIP",
    create_time: t - 120,
    update_time: t - 30,
    pay_time: t - 100,
    ship_by_date: t + 2 * 86_400,
    total_amount: lines.reduce((n, l) => n + l.qty * 45_000, 0),
    buyer_user_id: 7000 + snSeq,
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

/** A signed Shopee push through the webhook process and its job (code 2 deauthorized, 3 order, 12 expiring). */
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

/** A member invited through the email flow with a built-in role, optionally limited to some stores. */
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

type Notice = { kind: string; severity: string; title: string; body: string; data: Record<string, unknown> };
const inbox = async (c: Client): Promise<Notice[]> => (await c.get("/v1/notifications")).body.items;
const kinds = async (c: Client, kind: string) => (await inbox(c)).filter((n) => n.kind === kind);

describe("in-app notifications (FR-NTF-01)", () => {
  it("announces new orders in one digest to the people who accept them, within their store scope", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 20, [v["KAOS-L"]!]: 20 });
    // an order from before OmniSeller comes in with the 90-day import: no notification for it
    const old = shopeeOrder(901, [{ model: 9011, sku: "KAOS-M", qty: 1 }], { create_time: nowSec() - 3 * 86_400 });
    const here = await connectShopee(c, tenantId, [kaosItem(901)], { orders: [old] });
    expect((await c.get(`/v1/stores/${here.storeId}`)).body.lastOrderSyncAt).not.toBeNull();
    const parallel = await connectShopee(c, tenantId, [kaosItem(902)], { live: false });
    const hereAdmin = await addMember(c, tenantId, "Admin", { storeIds: [here.storeId] });
    const thereAdmin = await addMember(c, tenantId, "Admin", { storeIds: [parallel.storeId] });
    const gudang = await addMember(c, tenantId, "Gudang");

    const o1 = shopeeOrder(901, [{ model: 9011, sku: "KAOS-M", qty: 2 }]);
    const o2 = shopeeOrder(901, [{ model: 9012, sku: "KAOS-L", qty: 1 }]);
    const unpaid = shopeeOrder(901, [{ model: 9011, sku: "KAOS-M", qty: 1 }], { order_status: "UNPAID" });
    here.orders.push(o1, o2, unpaid);
    for (const o of [o1, o2, unpaid]) await pushOrder(tenantId, here.shopId, o);
    // parallel mode: the seller still works this store in the old app, so its orders are not announced
    const quiet = shopeeOrder(902, [{ model: 9021, sku: "KAOS-M", qty: 1 }]);
    parallel.orders.push(quiet);
    await pushOrder(tenantId, parallel.shopId, quiet);

    // the scheduler's scan finds the tenant while orders wait
    const added: { name: string; payload: { tenantId: string }; jobId: string }[] = [];
    const queues = {
      get: () => ({
        add: async (name: string, payload: { tenantId: string }, o: { jobId: string }) =>
          added.push({ name, payload, jobId: o.jobId }),
      }),
    } as unknown as QueueRegistry;
    await scanNewOrderNotices(h.system, queues, new JobRegistry(JOB_DEFINITIONS));
    expect(added.filter((a) => a.payload.tenantId === tenantId)).toEqual([
      expect.objectContaining({
        name: "order.new_notice",
        jobId: expect.stringMatching(new RegExp(`^order\\.new_notice\\|${tenantId}\\|n\\d+$`)),
      }),
    ]);

    await worker.runJob(orderNewNoticeJob, { slot: "t1" }, tenantId);
    const [digest, ...rest] = await kinds(c, "order.new");
    expect(rest).toEqual([]);
    expect(digest).toMatchObject({ severity: "info", title: "2 pesanan baru", body: `${here.name} 2.` });
    const [a, b] = [await orderBy(c, o1.order_sn), await orderBy(c, o2.order_sn)];
    expect(digest!.data).toMatchObject({ count: 2, stores: [{ storeId: here.storeId, count: 2 }] });
    expect([...(digest!.data.orderIds as string[])].sort()).toEqual([a.id, b.id].sort());
    expect(await kinds(hereAdmin, "order.new")).toHaveLength(1);
    expect(await kinds(thereAdmin, "order.new")).toEqual([]);
    expect(await kinds(gudang, "order.new")).toEqual([]); // no order:accept

    // nothing waits any more: the next digest is empty
    await worker.runJob(orderNewNoticeJob, { slot: "t2" }, tenantId);
    expect(await kinds(c, "order.new")).toHaveLength(1);
    added.length = 0;
    await scanNewOrderNotices(h.system, queues, new JobRegistry(JOB_DEFINITIONS));
    expect(added.filter((x) => x.payload.tenantId === tenantId)).toEqual([]);

    // the unpaid order is announced once it is paid
    unpaid.order_status = "READY_TO_SHIP";
    unpaid.update_time = nowSec();
    await pushOrder(tenantId, here.shopId, unpaid);
    await worker.runJob(orderNewNoticeJob, { slot: "t3" }, tenantId);
    const latest = (await kinds(c, "order.new"))[0]!;
    expect(latest).toMatchObject({ title: "1 pesanan baru", data: { count: 1 } });
  });

  it("warns about stock that runs low or out, once per level, to the people who restock", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "TOPI", ["TOPI-1"]);
    const viewer = await addMember(c, tenantId, "Viewer");
    await setStock(c, warehouseId, { [v["TOPI-1"]!]: 10 });
    expect((await c.put(`/v1/inventory/${v["TOPI-1"]}/warehouses/${warehouseId}`, { minStock: 5 })).status).toBe(200);
    await drain(tenantId);
    expect(await kinds(c, "stock.critical")).toEqual([]);

    await setStock(c, warehouseId, { [v["TOPI-1"]!]: 4 });
    await drain(tenantId);
    let alerts = await kinds(c, "stock.critical");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "warning", title: "1 produk stok menipis" });
    expect(alerts[0]!.body).toContain("TOPI-1 (sisa 4,");
    expect(alerts[0]!.data.items).toEqual([
      { variantId: v["TOPI-1"], sku: "TOPI-1", warehouseId, level: "low", available: 4, minStock: 5 },
    ]);

    // still low: no second alert; out of stock is worse and is announced
    await setStock(c, warehouseId, { [v["TOPI-1"]!]: 3 });
    await drain(tenantId);
    expect(await kinds(c, "stock.critical")).toHaveLength(1);
    await setStock(c, warehouseId, { [v["TOPI-1"]!]: 0 });
    await drain(tenantId);
    alerts = await kinds(c, "stock.critical");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({ severity: "critical", title: "1 produk stok habis" });
    // back to low from out is better, not worse: nothing new
    await setStock(c, warehouseId, { [v["TOPI-1"]!]: 3 });
    await drain(tenantId);
    expect(await kinds(c, "stock.critical")).toHaveLength(2);

    // restocked: the alert is cleared, so the next drop is announced again
    await setStock(c, warehouseId, { [v["TOPI-1"]!]: 12 });
    await drain(tenantId);
    await setStock(c, warehouseId, { [v["TOPI-1"]!]: 5 });
    await drain(tenantId);
    alerts = await kinds(c, "stock.critical");
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toMatchObject({ title: "1 produk stok menipis" });
    expect(await kinds(viewer, "stock.critical")).toEqual([]); // no inventory:adjust
  });

  it("tells store managers when a store's authorization ends soon and when it must be reconnected", async () => {
    const { c, tenantId } = await business();
    const store = await connectShopee(c, tenantId, [kaosItem(911)]);
    const other = await connectShopee(c, tenantId, [kaosItem(912)]);
    const otherAdmin = await addMember(c, tenantId, "Admin", { storeIds: [other.storeId] });

    const expireBefore = nowSec() + 5 * 86_400;
    await pushShopee(tenantId, store.shopId, 12, {
      shop_expire_soon: [Number(store.shopId)],
      expire_before: expireBefore,
    });
    expect((await c.get(`/v1/stores/${store.storeId}`)).body.status).toBe("token_expiring");
    const [expiring] = await kinds(c, "store.authorization_expiring");
    expect(expiring).toMatchObject({ severity: "warning", title: `Izin ${store.name} segera berakhir` });
    expect(expiring!.data).toMatchObject({ storeId: store.storeId, channel: "shopee" });

    await pushShopee(tenantId, store.shopId, 2, {
      authorize_type: "user cancel shop authorization",
      success: 1,
      extra: `shop id ${store.shopId} (ID) has been cancelled its authorization`,
    });
    expect((await c.get(`/v1/stores/${store.storeId}`)).body.status).toBe("reauth_required");
    const [reauth] = await kinds(c, "store.reauth_required");
    expect(reauth).toMatchObject({ severity: "critical", title: `${store.name} perlu dihubungkan ulang` });
    expect(reauth!.body).toContain("Shopee");
    expect(await kinds(otherAdmin, "store.reauth_required")).toEqual([]);
    expect(await kinds(otherAdmin, "store.authorization_expiring")).toEqual([]);
  });

  it("tells store managers when a marketplace refuses the stock it was sent", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "PROMO", ["PROMO-1"]);
    // under promotion: Shopee refuses stock below the reserved quantity
    const store = await connectShopee(c, tenantId, [
      {
        item_id: 921,
        item_name: "Promo",
        item_sku: "PROMO-1",
        item_status: "NORMAL",
        update_time: 1_700_000_000,
        price: 1,
        stock: 9,
        reservedStock: 5,
      },
    ]);
    await setStock(c, warehouseId, { [v["PROMO-1"]!]: 2 });
    await drain(tenantId);
    const pushed = await worker.flushStock(tenantId);
    expect(pushed.errors).toEqual([]);
    const [refused] = await kinds(c, "sync.stock_push_failed");
    expect(refused).toMatchObject({ severity: "warning", title: "Stok 1 listing ditolak marketplace" });
    expect(refused!.body).toContain(`${store.name}: `);
    expect(refused!.body).toContain("reserved stock");

    // refused again: the people already know, no second notification
    await setStock(c, warehouseId, { [v["PROMO-1"]!]: 3 });
    await drain(tenantId);
    await worker.flushStock(tenantId);
    expect(await kinds(c, "sync.stock_push_failed")).toHaveLength(1);
  });
});

describe("home dashboard (FR-RPT-01)", () => {
  it("shows sales against the period before, orders per status, best sellers, critical stock, stores, and tasks", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 20, [v["KAOS-L"]!]: 3 });
    expect((await c.put(`/v1/inventory/${v["KAOS-L"]}/warehouses/${warehouseId}`, { minStock: 5 })).status).toBe(200);
    const store = await connectShopee(c, tenantId, [kaosItem(931)]);
    const elsewhere = await connectShopee(c, tenantId, [kaosItem(932)]);

    const t = nowSec();
    const today1 = shopeeOrder(931, [{ model: 9311, sku: "KAOS-M", qty: 2 }]);
    const today2 = shopeeOrder(931, [{ model: 9312, sku: "KAOS-L", qty: 1 }]);
    const yesterday = shopeeOrder(931, [{ model: 9311, sku: "KAOS-M", qty: 1 }], {
      create_time: t - 86_400 - 600,
      pay_time: t - 86_400 - 500,
    });
    const unpaid = shopeeOrder(931, [{ model: 9311, sku: "KAOS-M", qty: 1 }], { order_status: "UNPAID" });
    const cancelled = shopeeOrder(931, [{ model: 9311, sku: "KAOS-M", qty: 1 }], { order_status: "CANCELLED" });
    const all = [today1, today2, yesterday, unpaid, cancelled];
    store.orders.push(...all);
    for (const o of all) await pushOrder(tenantId, store.shopId, o);

    const res = await c.get("/v1/dashboard");
    expect(res.status).toBe(200);
    const d = res.body;
    expect(d).toMatchObject({ timezone: "Asia/Jakarta", range: "today" });

    // sales: paid, not cancelled, by order time, in the windows the answer names
    const inWindow = (o: MockShopeeOrder, from: string, to: string) =>
      o.create_time * 1000 >= Date.parse(from) && o.create_time * 1000 < Date.parse(to);
    const sold = [today1, today2, yesterday];
    const current = sold.filter((o) => inWindow(o, d.period.from, d.period.to));
    const previous = sold.filter((o) => inWindow(o, d.period.previousFrom, d.period.previousTo));
    expect(d.sales).toMatchObject({
      orders: current.length,
      revenue: current.reduce((n, o) => n + (o.total_amount ?? 0), 0),
      previousOrders: previous.length,
      previousRevenue: previous.reduce((n, o) => n + (o.total_amount ?? 0), 0),
    });

    expect(d.orders.statuses).toMatchObject({ new: 3, unpaid: 1, cancelled: 1, shipped: 0 });
    expect(Object.keys(d.orders.statuses)).toHaveLength(13);
    expect(d.orders.dueSoon).toBe(0);
    expect(d.urgentOrders).toEqual([]);

    // best sellers of the last 7 days by units, with the OmniSeller SKU
    expect(d.topProducts.slice(0, 2)).toEqual([
      expect.objectContaining({
        variantId: v["KAOS-M"],
        sku: "KAOS-M",
        name: "Produk KAOS",
        units: 3,
        revenue: 135_000,
      }),
      expect.objectContaining({ variantId: v["KAOS-L"], sku: "KAOS-L", units: 1, revenue: 45_000 }),
    ]);
    // gross profit: line totals minus cost price 20.000 per unit, every line has a cost
    const profit = current.reduce(
      (n, o) => n + o.item_list.reduce((m, i) => m + i.model_quantity_purchased * (45_000 - 20_000), 0),
      0,
    );
    expect(d.grossProfit).toMatchObject({ amount: profit });
    if (current.length > 0) expect(d.grossProfit.costCoveragePct).toBe(100);

    // the chart: 30 days, one series per channel, today last
    expect(d.salesChart.dates).toHaveLength(30);
    const shopee = d.salesChart.series.find((s: { channel: string }) => s.channel === "shopee");
    expect(shopee.displayName).toBe("Shopee");
    expect(shopee.orders.reduce((n: number, x: number) => n + x, 0)).toBe(3);

    // KAOS-L: 3 on hand, 1 reserved by today2, minimum 5
    expect(d.criticalStock).toEqual({
      count: 1,
      items: [expect.objectContaining({ sku: "KAOS-L", available: 2, minStock: 5, warehouseId })],
    });
    expect(d.stores.map((s: { id: string; health: string }) => [s.id, s.health]).sort()).toEqual(
      [
        [store.storeId, "healthy"],
        [elsewhere.storeId, "healthy"],
      ].sort(),
    );
    expect(d.tasks.map((x: { kind: string; count: number }) => [x.kind, x.count])).toEqual([
      ["stock_critical", 1],
      ["orders_new", 3],
    ]);

    // one store only; another tenant's store does not exist
    const one = (await c.get(`/v1/dashboard?range=7d&storeId=${elsewhere.storeId}`)).body;
    expect(one.range).toBe("7d");
    expect(one.sales).toMatchObject({ orders: 0, revenue: 0 });
    expect(one.stores.map((s: { id: string }) => s.id)).toEqual([elsewhere.storeId]);
    const stranger = await business();
    expect((await stranger.c.get(`/v1/dashboard?storeId=${store.storeId}`)).status).toBe(404);
    expect((await c.get("/v1/dashboard?range=90d")).status).toBe(422);

    // sections follow permissions: no profit without finance:read, no sales without report:read
    const viewer = (await (await addMember(c, tenantId, "Viewer")).get("/v1/dashboard")).body;
    expect(viewer.sales).toMatchObject({ orders: current.length });
    expect(viewer.grossProfit).toBeNull();
    expect(viewer.criticalStock.count).toBe(1);
    const cs = (await (await addMember(c, tenantId, "CS")).get("/v1/dashboard")).body;
    expect([cs.sales, cs.salesChart, cs.topProducts, cs.grossProfit]).toEqual([null, null, null, null]);
    expect(cs.orders.statuses.new).toBe(3);

    // a user limited to the other store sees nothing of this one
    const scoped = (
      await (await addMember(c, tenantId, "Admin", { storeIds: [elsewhere.storeId] })).get("/v1/dashboard")
    ).body;
    expect(scoped.orders.statuses.new).toBe(0);
    expect(scoped.stores.map((s: { id: string }) => s.id)).toEqual([elsewhere.storeId]);
  });
});

describe("full data export (FR-MIG-09) and the audit of sensitive actions (FR-USR-04)", () => {
  async function zipOf(c: Client, url: string) {
    const res = await c
      .get(url)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (d: Buffer) => chunks.push(d));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="omniseller-ekspor-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    expect(res.headers["cache-control"]).toContain("no-store");
    const files = unzipSync(new Uint8Array(res.body as Buffer));
    const text = (name: string) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(files[name]);
    return { names: Object.keys(files), text };
  }

  const lines = (csv: string) => csv.replace(/^﻿/, "").trimEnd().split("\r\n");

  it("zips every CSV of the business once at a time, for the Owner only, and audits requests and downloads", async () => {
    const { c, me, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    const movements = await setStock(c, warehouseId, { [v["KAOS-M"]!]: 20, [v["KAOS-L"]!]: 20 });
    const store = await connectShopee(c, tenantId, [kaosItem(941)]);
    const sold = shopeeOrder(941, [{ model: 9411, sku: "KAOS-M", qty: 2 }], {
      recipient_address: {
        name: "=Dewi",
        phone: "6281200000",
        city: "Jakarta Barat",
        full_address: "Jl. Mawar 1; No. 2",
      },
    });
    store.orders.push(sold);
    await pushOrder(tenantId, store.shopId, sold);
    const order = await orderBy(c, sold.order_sn);

    // FR-USR-04: a stock adjustment is in the audit log under its table, not the partition
    const adjusted = await c.get(`/v1/audit-logs?entity_type=stock_movement&entity_id=${movements[0]!.movementId}`);
    expect(adjusted.body.items).toEqual([
      expect.objectContaining({ action: "insert", actorType: "user", actorId: me.user.id }),
    ]);

    // the Admin role does not hold data:export
    const admin = await addMember(c, tenantId, "Admin");
    expect((await admin.post("/v1/exports", {})).status).toBe(403);

    const first = await c.post("/v1/exports", {});
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: "queued", requestedBy: me.user.id, downloadUrl: null, files: [] });
    // one at a time: asking again answers with the same export
    expect((await c.post("/v1/exports", {})).body.id).toBe(first.body.id);
    expect((await c.get(`/v1/exports/${first.body.id}/download`)).status).toBe(409);

    expect(await drain(tenantId)).toContain("export.render");
    const ready = (await c.get(`/v1/exports/${first.body.id}`)).body;
    expect(ready).toMatchObject({
      status: "ready",
      expired: false,
      error: null,
      downloadUrl: `/v1/exports/${first.body.id}/download`,
    });
    expect(ready.sizeBytes).toBeGreaterThan(0);
    expect(Date.parse(ready.expiresAt) - Date.parse(ready.finishedAt)).toBeGreaterThan(6.9 * 86_400_000);
    const files = [
      "toko.csv",
      "gudang.csv",
      "produk.csv",
      "listing.csv",
      "stok.csv",
      "mutasi_stok.csv",
      "pesanan.csv",
      "item_pesanan.csv",
      "pengiriman.csv",
    ];
    expect(ready.files.map((f: { name: string }) => f.name)).toEqual(files);
    expect(ready.files.find((f: { name: string }) => f.name === "pesanan.csv").rows).toBe(1);
    expect((await kinds(c, "export.ready"))[0]).toMatchObject({
      title: "Ekspor data siap diunduh",
      data: { exportId: first.body.id },
    });
    expect((await c.get("/v1/exports")).body.items.map((e: { id: string }) => e.id)).toEqual([first.body.id]);

    const zip = await zipOf(c, ready.downloadUrl);
    expect(zip.names).toEqual(["README.txt", ...files]);
    expect(zip.text("README.txt")).toContain("- pesanan.csv (1 baris): ");

    const orders = lines(zip.text("pesanan.csv"));
    expect(orders[0]).toBe(
      "id;toko;marketplace;platform;no_pesanan;status;status_label;status_marketplace;pemenuhan;gudang;dipesan_pada;" +
        "dibayar_pada;kirim_paling_lambat;dikirim_pada;diterima_pada;selesai_pada;dibatalkan_pada;dibatalkan_oleh;" +
        "alasan_batal;cod;dropship;subtotal;diskon;voucher_penjual;ongkir_pembeli;total;mata_uang;nama_pembeli;" +
        "username_pembeli;telepon_pembeli;nama_penerima;telepon_penerima;alamat;kecamatan;kota;provinsi;kode_pos;kurir;" +
        "layanan_kurir;no_resi;catatan_pembeli;catatan_internal;sumber;id_toko;metode_bayar;tag",
    );
    const row = orders[1]!;
    expect(row.startsWith(`${order.id};${store.name};Shopee;`)).toBe(true);
    expect(row).toContain(`;${sold.order_sn};new;Baru;READY_TO_SHIP;seller;`);
    expect(row).toContain(";90000;IDR;");
    // a buyer-controlled name that looks like a formula is written as text; ';' inside a field is quoted
    expect(row).toContain(";'=Dewi;");
    expect(row).toContain(';"Jl. Mawar 1; No. 2";');
    expect(row).toMatch(/;\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00;/);

    const items = lines(zip.text("item_pesanan.csv"));
    expect(items[1]).toMatch(new RegExp(`^${sold.order_sn};${store.name};KAOS-M;Kaos;KAOS-M;2;0;0;0;`));
    expect(lines(zip.text("toko.csv"))[1]).toContain(`;Shopee;${store.name};${store.shopId};ID;active;live;`);
    // variants without a name or attributes are named after their product
    expect(
      lines(zip.text("stok.csv"))
        .slice(1)
        .map((l) => l.split(";").slice(0, 6).join(";"))
        .sort(),
    ).toEqual(["UTAMA;KAOS-L;Produk KAOS;Produk KAOS;20;0", "UTAMA;KAOS-M;Produk KAOS;Produk KAOS;20;2"]);
    const card = lines(zip.text("mutasi_stok.csv")).slice(1);
    expect(card.filter((l) => l.split(";")[5] === "adjustment")).toHaveLength(2);
    expect(card.some((l) => l.split(";")[5] === "order_reserve")).toBe(true);
    expect(lines(zip.text("listing.csv"))).toHaveLength(3);

    // produk.csv imports again as it is
    const reimport = await c.post("/v1/products/import", { content: zip.text("produk.csv"), dryRun: true });
    expect(reimport.status).toBe(200);
    expect(reimport.body).toMatchObject({
      dryRun: true,
      products: { created: 0 },
      variants: { created: 0, updated: 2 },
    });

    // every download is counted and audited, with who
    const after = (await c.get(`/v1/exports/${first.body.id}`)).body;
    expect(after).toMatchObject({ downloadCount: 1 });
    const audit = (await c.get(`/v1/audit-logs?entity_type=data_export&entity_id=${first.body.id}`)).body.items as {
      action: string;
      actorId: string;
    }[];
    expect(audit.map((x) => [x.action, x.actorId]).sort()).toEqual(
      [
        ["insert", me.user.id],
        ["update", me.user.id],
      ].sort(),
    );

    // another tenant cannot download it; once expired nobody can
    const stranger = await business();
    expect((await stranger.c.get(`/v1/exports/${first.body.id}/download`)).status).toBe(404);
    await h.system.db.execute(
      sql`UPDATE data_export SET expires_at = now() - interval '1 minute' WHERE id = ${first.body.id}`,
    );
    const expired = await c.get(`/v1/exports/${first.body.id}/download`);
    expect(expired.status).toBe(404);
    expect(expired.body.code).toBe("export.expired");
    expect((await c.get(`/v1/exports/${first.body.id}`)).body).toMatchObject({ expired: true, downloadUrl: null });

    // a finished export does not block the next one
    const second = await c.post("/v1/exports", {});
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.body.status).toBe("queued");

    // FR-USR-04: asking the marketplace to cancel an order is audited with who asked
    expect((await c.post(`/v1/orders/${order.id}/cancel`, { reason: "OUT_OF_STOCK" })).status).toBe(202);
    const cancels = (await c.get("/v1/audit-logs?entity_type=order_event")).body.items as {
      actorId: string;
      after: { order_id: string; type: string };
    }[];
    expect(cancels).toEqual([
      expect.objectContaining({
        actorId: me.user.id,
        after: expect.objectContaining({ order_id: order.id, type: "cancel_requested" }),
      }),
    ]);
  });

  it("replaces an export that has been stuck for an hour", async () => {
    const { c, tenantId } = await business();
    const first = (await c.post("/v1/exports", {})).body;
    await h.system.db.execute(
      sql`UPDATE data_export SET status_changed_at = now() - interval '2 hours' WHERE id = ${first.id}`,
    );
    const second = (await c.post("/v1/exports", {})).body;
    expect(second.id).not.toBe(first.id);
    expect((await c.get(`/v1/exports/${first.id}`)).body).toMatchObject({ status: "failed" });
    // the stale job finds its export failed and does nothing; the new one renders
    expect((await drain(tenantId)).filter((j) => j === "export.render")).toHaveLength(2);
    expect((await c.get(`/v1/exports/${first.id}`)).body.status).toBe("failed");
    expect((await c.get(`/v1/exports/${second.id}`)).body.status).toBe("ready");
  });
});
