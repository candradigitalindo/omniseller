import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDate } from "../../src/common/time-zone";
import type { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { longDate } from "../../src/modules/notification/templates";
import { digestDailyJob } from "../../src/modules/reporting/reporting.jobs";
import { addDays } from "../../src/modules/reporting/sales-report-plan";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
import { scanDailyDigests } from "../../src/scheduler/digest-scan";
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
 * Reports end to end (backend doc 8.20): the sales report (PRD FR-RPT-02, UI L30), the restock list
 * (FR-STK-07), and the daily operational email with notification preferences (FR-NTF-02).
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 995000;
let snSeq = 1;
const TZ = "Asia/Jakarta";
/** Seconds of a local Jakarta time. */
const wib = (local: string) => Math.floor(Date.parse(`${local}+07:00`) / 1000);
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
    categoryPath: "Fashion > Pria",
    attributeNames: ["Ukuran"],
    variants: variantSkus.map((v, i) => ({
      sku: v,
      attributes: { Ukuran: String(i + 1) },
      basePrice: 50_000,
      costPrice: 20_000,
      weightG: 200,
    })),
  });
  expect(res.status).toBe(201);
  return Object.fromEntries((res.body.variants as { id: string; sku: string }[]).map((v) => [v.sku, v.id]));
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
  return { c: member, email };
}

const item = (itemId: number, skus: string[]): MockShopeeItem => ({
  item_id: itemId,
  item_name: "Produk",
  item_sku: "PRODUK",
  item_status: "NORMAL",
  update_time: 1_700_000_000,
  tiers: [{ name: "Ukuran", options: skus.map((_, i) => String(i + 1)) }],
  models: skus.map((s, i) => ({
    model_id: itemId * 10 + i + 1,
    model_sku: s,
    tier_index: [i],
    price: 50_000,
    stock: 3,
  })),
});

async function connectShopee(c: Client, tenantId: string, items: MockShopeeItem[]) {
  const shopId = String(++shopSeq);
  const orders: MockShopeeOrder[] = [];
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
  expect((await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" })).status).toBe(200);
  await drain(tenantId);
  return { shopId, storeId, orders, name: `Toko ${shopId}` };
}

function order(
  itemId: number,
  lines: { model: number; sku: string; qty: number }[],
  extra: Partial<MockShopeeOrder> & { create_time: number },
): MockShopeeOrder {
  return {
    order_sn: `2610100${String(snSeq++).padStart(6, "0")}`,
    order_status: "READY_TO_SHIP",
    update_time: nowSec() - 5,
    pay_time: extra.create_time + 60,
    ship_by_date: extra.create_time + 3 * 86_400,
    total_amount: lines.reduce((n, l) => n + l.qty * 45_000, 0),
    buyer_user_id: 8000 + snSeq,
    buyer_username: "dewi",
    shipping_carrier: "SPX Standard",
    recipient_address: {
      name: "Dewi",
      phone: "6281200000",
      city: "Jakarta Barat",
      state: "DKI Jakarta",
      full_address: "Jl. Mawar 1",
    },
    item_list: lines.map((l) => ({
      item_id: itemId,
      item_name: "Produk",
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

async function push(tenantId: string, shopId: string, o: MockShopeeOrder) {
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

describe("sales report (FR-RPT-02)", () => {
  it("reports sold orders by order time against the months before, per channel, product, category, region, and hour", async () => {
    const { c, tenantId } = await business();
    await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    const store = await connectShopee(c, tenantId, [item(951, ["KAOS-M", "KAOS-L"])]);
    const placed = [
      // Thursday 10 September 10:00
      order(951, [{ model: 9511, sku: "KAOS-M", qty: 2 }], { create_time: wib("2026-09-10T10:00:00") }),
      // Sunday 20 September 15:00, picked up by the courier the next morning
      order(951, [{ model: 9512, sku: "KAOS-L", qty: 1 }], {
        create_time: wib("2026-09-20T15:00:00"),
        order_status: "SHIPPED",
        pickup_done_time: wib("2026-09-21T09:00:00"),
        recipient_address: {
          name: "Budi",
          phone: "6281300000",
          city: "Bandung",
          state: "Jawa Barat",
          full_address: "Jl. Melati 2",
        },
      }),
      // paid, then cancelled
      order(951, [{ model: 9511, sku: "KAOS-M", qty: 1 }], {
        create_time: wib("2026-09-21T12:00:00"),
        order_status: "CANCELLED",
      }),
      // never paid
      order(951, [{ model: 9511, sku: "KAOS-M", qty: 1 }], {
        create_time: wib("2026-09-22T08:00:00"),
        order_status: "UNPAID",
        pay_time: undefined,
      }),
      // the month before
      order(951, [{ model: 9511, sku: "KAOS-M", qty: 1 }], {
        create_time: wib("2026-08-15T09:00:00"),
        order_status: "COMPLETED",
      }),
    ];
    store.orders.push(...placed);
    for (const o of placed) await push(tenantId, store.shopId, o);

    const res = await c.get("/v1/reports/sales?from=2026-09-01&to=2026-09-30&granularity=week");
    expect(res.status).toBe(200);
    const r = res.body;
    expect(r).toMatchObject({
      timezone: TZ,
      range: { from: "2026-09-01", to: "2026-09-30" },
      previousRange: { from: "2026-08-01", to: "2026-08-31" },
      period: { from: "2026-08-31T17:00:00.000Z", to: "2026-09-30T17:00:00.000Z" },
    });
    expect(r.summary).toMatchObject({
      revenue: 135_000,
      orders: 2,
      units: 3,
      averageOrderValue: 67_500,
      paidOrders: 3,
      cancelledOrders: 1,
      cancellationRate: 33.3,
      shippedOrders: 1,
      shippedRevenue: 45_000,
      previous: { revenue: 45_000, orders: 1, units: 1, cancellationRate: 0 },
      change: { revenue: 200, orders: 100, cancellationRate: 33.3 },
    });
    // weeks from Monday; August laid next to September week by week
    expect(r.series).toEqual([
      { bucket: "2026-08-31", orders: 0, revenue: 0, previousOrders: 0, previousRevenue: 0 },
      { bucket: "2026-09-07", orders: 1, revenue: 90_000, previousOrders: 0, previousRevenue: 0 },
      { bucket: "2026-09-14", orders: 1, revenue: 45_000, previousOrders: 1, previousRevenue: 45_000 },
      { bucket: "2026-09-21", orders: 0, revenue: 0, previousOrders: 0, previousRevenue: 0 },
      { bucket: "2026-09-28", orders: 0, revenue: 0, previousOrders: 0, previousRevenue: 0 },
    ]);
    expect(r.byChannel).toEqual([
      { channel: "shopee", displayName: "Shopee", orders: 2, revenue: 135_000, share: 100 },
    ]);
    expect(r.byStore).toEqual([
      expect.objectContaining({ storeId: store.storeId, name: store.name, orders: 2, revenue: 135_000, share: 100 }),
    ]);
    expect(
      r.byProduct.map((p: { sku: string; units: number; orders: number; revenue: number }) => [
        p.sku,
        p.units,
        p.orders,
        p.revenue,
      ]),
    ).toEqual([
      ["KAOS-M", 2, 1, 90_000],
      ["KAOS-L", 1, 1, 45_000],
    ]);
    expect(r.byCategory).toEqual([{ category: "Fashion > Pria", units: 3, orders: 2, revenue: 135_000 }]);
    expect(r.byRegion).toEqual([
      { province: "DKI Jakarta", orders: 1, revenue: 90_000, share: 66.7 },
      { province: "Jawa Barat", orders: 1, revenue: 45_000, share: 33.3 },
    ]);
    expect(r.byHour).toEqual([
      { weekday: 4, hour: 10, orders: 1, revenue: 90_000 },
      { weekday: 7, hour: 15, orders: 1, revenue: 45_000 },
    ]);

    const monthly = (await c.get("/v1/reports/sales?from=2026-09-01&to=2026-09-30&granularity=month")).body;
    expect(monthly.series).toEqual([
      { bucket: "2026-09-01", orders: 2, revenue: 135_000, previousOrders: 1, previousRevenue: 45_000 },
    ]);
    const alone = (await c.get("/v1/reports/sales?from=2026-09-01&to=2026-09-30&compare=false")).body;
    expect([alone.summary.previous, alone.summary.change, alone.previousRange]).toEqual([null, null, null]);
    expect(alone.series).toHaveLength(30);

    const csv = await c.get("/v1/reports/sales/export?from=2026-09-01&to=2026-09-30&section=products");
    expect(csv.headers["content-disposition"]).toBe(
      'attachment; filename="penjualan-products-2026-09-01-2026-09-30.csv"',
    );
    expect(csv.text).toBe(
      "﻿sku;produk;varian;unit;pesanan;omzet\r\nKAOS-M;Produk KAOS;1;2;1;90000\r\nKAOS-L;Produk KAOS;2;1;1;45000\r\n",
    );
    expect((await c.get("/v1/reports/sales/export?from=2026-09-01&to=2026-09-30&section=hours")).text).toContain(
      "Kamis;10;1;90000",
    );

    // filters, validation, permissions
    const other = await connectShopee(c, tenantId, [item(952, ["KAOS-M"])]);
    expect(
      (await c.get(`/v1/reports/sales?from=2026-09-01&to=2026-09-30&storeId=${other.storeId}`)).body.summary,
    ).toMatchObject({
      orders: 0,
      revenue: 0,
    });
    expect((await c.get("/v1/reports/sales?from=2026-09-30&to=2026-09-01")).status).toBe(422);
    expect((await c.get("/v1/reports/sales?from=2025-01-01&to=2026-09-30")).status).toBe(422);
    expect((await c.get("/v1/reports/sales?from=2026-09-01")).status).toBe(422);
    const cs = await addMember(c, tenantId, "CS");
    expect((await cs.c.get("/v1/reports/sales")).status).toBe(403);
    const viewer = await addMember(c, tenantId, "Viewer");
    expect((await viewer.c.get("/v1/reports/sales?from=2026-09-01&to=2026-09-30")).body.summary.revenue).toBe(135_000);
  });
});

describe("restock list (FR-STK-07)", () => {
  it("lists what sells faster than its stock lasts, with how much to order", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "TOPI", ["TOPI-1", "TOPI-2", "TOPI-3"]);
    await c.post("/v1/inventory/adjustments", {
      lines: [
        { variantId: v["TOPI-1"], warehouseId, mode: "set", quantity: 3 },
        { variantId: v["TOPI-2"], warehouseId, mode: "set", quantity: 100 },
        { variantId: v["TOPI-3"], warehouseId, mode: "set", quantity: 1 },
      ],
      reason: "correction",
    });
    expect((await c.put(`/v1/inventory/${v["TOPI-3"]}/warehouses/${warehouseId}`, { minStock: 2 })).status).toBe(200);
    const store = await connectShopee(c, tenantId, [item(961, ["TOPI-1", "TOPI-2", "TOPI-3"])]);
    // completed orders count as sales without holding stock
    const fiveDaysAgo = nowSec() - 5 * 86_400;
    const sold = [
      order(961, [{ model: 9611, sku: "TOPI-1", qty: 30 }], { create_time: fiveDaysAgo, order_status: "COMPLETED" }),
      order(961, [{ model: 9612, sku: "TOPI-2", qty: 3 }], { create_time: fiveDaysAgo, order_status: "COMPLETED" }),
      // outside the 30-day window
      order(961, [{ model: 9612, sku: "TOPI-2", qty: 90 }], {
        create_time: nowSec() - 40 * 86_400,
        order_status: "COMPLETED",
      }),
    ];
    store.orders.push(...sold);
    for (const o of sold) await push(tenantId, store.shopId, o);

    const list = (await c.get("/v1/inventory/restock")).body;
    expect(list).toMatchObject({ total: 2, needed: 2 });
    expect(list.items).toEqual([
      expect.objectContaining({
        sku: "TOPI-3",
        available: 1,
        minStock: 2,
        unitsSold: 0,
        suggested: 2,
        reason: "below_min",
      }),
      expect.objectContaining({
        id: v["TOPI-1"],
        sku: "TOPI-1",
        productName: "Produk TOPI",
        warehouseId,
        available: 3,
        unitsSold: 30,
        dailyRate: 1,
        daysOfCover: 3,
        suggested: 27,
        reason: "low_cover",
      }),
    ]);
    const all = (await c.get("/v1/inventory/restock?all=true")).body;
    expect(all.items.map((i: { sku: string; reason: string | null }) => [i.sku, i.reason])).toEqual([
      ["TOPI-3", "below_min"],
      ["TOPI-1", "low_cover"],
      ["TOPI-2", null],
    ]);
    const week = (await c.get("/v1/inventory/restock?window=7")).body.items.find(
      (i: { sku: string }) => i.sku === "TOPI-1",
    );
    expect(week).toMatchObject({ unitsSold: 30, dailyRate: 4.29, daysOfCover: 0.7, suggested: 126 });
    const csv = (await c.get("/v1/inventory/restock/export")).text;
    expect(csv.split("\r\n")[0]).toBe(
      "﻿sku;produk;varian;gudang;tersedia;stok_minimum;terjual_30_hari;terjual_per_hari;cukup_untuk_hari;saran_pesan;alasan",
    );
    expect(csv).toContain("TOPI-1;Produk TOPI;1;");
    expect(csv).toContain(";Cepat habis\r\n");
  });
});

describe("daily operational email (FR-NTF-02)", () => {
  it("mails yesterday's figures each morning to the people who want them, once a day", async () => {
    const { c, me, tenantId, warehouseId } = await business();
    const v = await product(c, "SEPATU", ["SEPATU-1"]);
    await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId: v["SEPATU-1"], warehouseId, mode: "set", quantity: 10 }],
      reason: "correction",
    });
    const store = await connectShopee(c, tenantId, [item(971, ["SEPATU-1"])]);
    const today = localDate(TZ, new Date());
    const yesterday = addDays(today, -1);
    const placed = [
      order(971, [{ model: 9711, sku: "SEPATU-1", qty: 1 }], {
        create_time: wib(`${yesterday}T10:00:00`),
        order_status: "COMPLETED",
      }),
      // to ship
      order(971, [{ model: 9711, sku: "SEPATU-1", qty: 1 }], { create_time: nowSec() - 120 }),
    ];
    store.orders.push(...placed);
    for (const o of placed) await push(tenantId, store.shopId, o);

    const viewer = await addMember(c, tenantId, "Viewer");
    const gudang = await addMember(c, tenantId, "Gudang");
    const cs = await addMember(c, tenantId, "CS");
    // preferences: the Viewer turns it off, CS (no sales figures by default) turns it on
    expect((await viewer.c.get("/v1/notifications/preferences")).body.items).toEqual([
      expect.objectContaining({ kind: "digest.daily", email: true, emailByDefault: true }),
    ]);
    expect(
      (await viewer.c.put("/v1/notifications/preferences/digest.daily", { email: false })).body.items[0].email,
    ).toBe(false);
    expect((await cs.c.get("/v1/notifications/preferences")).body.items[0]).toMatchObject({
      email: false,
      emailByDefault: false,
    });
    await cs.c.put("/v1/notifications/preferences/digest.daily", { email: true });
    expect((await c.put("/v1/notifications/preferences/tidak.ada", { email: true })).status).toBe(404);

    const sentBefore = worker.email.sent.length;
    await worker.runJob(digestDailyJob, { date: today }, tenantId);
    expect(await drain(tenantId)).toEqual(["digest.email", "digest.email"]);
    const mails = worker.email.sent.slice(sentBefore);
    expect(mails.map((m) => m.to).sort()).toEqual([me.user.email, cs.email].sort());

    const owner = mails.find((m) => m.to === me.user.email)!;
    expect(owner.subject).toBe(`Ringkasan ${me.tenant.name}, ${longDate(yesterday)}`);
    expect(owner.text).toContain("PENJUALAN\n- 1 pesanan, Rp45.000, baru ada penjualan.");
    expect(owner.text).toContain("Terlaris: Produk SEPATU 1 (1).");
    expect(owner.text).toContain("PESANAN\n- 1 pesanan harus dikirim.");
    expect(owner.text).toContain("STOK\n");
    expect(owner.html).toContain("<h2");
    const support = mails.find((m) => m.to === cs.email)!;
    expect(support.text).not.toContain("PENJUALAN");
    expect(support.text).toContain("PESANAN");
    expect(mails.some((m) => m.to === viewer.email || m.to === gudang.email)).toBe(false);

    // the same morning again sends nothing
    await worker.runJob(digestDailyJob, { date: today }, tenantId);
    expect(await drain(tenantId)).toEqual([]);

    // the scheduler: a business older than a day, from 07:00 local time, once per local date
    await h.system.db.execute(sql`UPDATE tenant SET created_at = now() - interval '3 days' WHERE id = ${tenantId}`);
    const added: { payload: { tenantId: string; date: string }; jobId: string }[] = [];
    const queues = {
      get: () => ({
        add: async (_name: string, payload: { tenantId: string; date: string }, o: { jobId: string }) =>
          added.push({ payload, jobId: o.jobId }),
      }),
    } as unknown as QueueRegistry;
    const registry = new JobRegistry(JOB_DEFINITIONS);
    const tomorrow = addDays(today, 1);
    await scanDailyDigests(h.system, queues, registry, new Date(`${tomorrow}T06:30:00+07:00`));
    expect(added.filter((a) => a.payload.tenantId === tenantId)).toEqual([]);
    await scanDailyDigests(h.system, queues, registry, new Date(`${tomorrow}T07:05:00+07:00`));
    expect(added.filter((a) => a.payload.tenantId === tenantId)).toEqual([
      { payload: { tenantId, date: tomorrow }, jobId: `digest.daily|${tenantId}|${tomorrow}` },
    ]);
    added.length = 0;
    await scanDailyDigests(h.system, queues, registry, new Date(`${today}T08:00:00+07:00`));
    expect(added.filter((a) => a.payload.tenantId === tenantId)).toEqual([]); // today's went out already
  });
});
