import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unguardCell } from "../../src/common/csv";
import { localDate } from "../../src/common/time-zone";
import type { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { readXlsx, readXlsxAll } from "../../src/modules/migration/xlsx";
import { longDate } from "../../src/modules/notification/templates";
import { digestDailyJob, reportScheduledJob } from "../../src/modules/reporting/reporting.jobs";
import { SALES_SECTIONS, SALES_SHEET_NAMES } from "../../src/modules/reporting/sales-report.service";
import { addDays } from "../../src/modules/reporting/sales-report-plan";
import { mondayOf } from "../../src/modules/reporting/scheduled-report-plan";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
import { scanDailyDigests } from "../../src/scheduler/digest-scan";
import { scanDelayMs, scanScheduledReports } from "../../src/scheduler/report-scan";
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

/** A binary download (an Excel workbook): its headers and bytes. */
async function download(c: Client, url: string) {
  const res = await c
    .get(url)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (d: Buffer) => chunks.push(d));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  return {
    status: res.status,
    headers: res.headers as Record<string, string>,
    bytes: new Uint8Array(res.body as Buffer),
  };
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
    // the whole report as one Excel workbook: a summary, then every section with the CSV's rows (FR-RPT-05)
    const xlsx = await download(c, "/v1/reports/sales/export?from=2026-09-01&to=2026-09-30&format=xlsx&section=hours");
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers["content-type"]).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(xlsx.headers["content-disposition"]).toBe('attachment; filename="penjualan-2026-09-01-2026-09-30.xlsx"');
    expect(xlsx.headers["cache-control"]).toContain("no-store");
    const sheets = readXlsxAll(xlsx.bytes, 100);
    expect(sheets.map((s) => s.name)).toEqual([
      "Ringkasan",
      "Per periode",
      "Per kanal",
      "Per toko",
      "Per produk",
      "Per kategori",
      "Per wilayah",
      "Per jam",
    ]);
    expect(sheets[0]!.rows.slice(0, 4)).toEqual([
      ["Ukuran", "Periode ini", "Periode sebelumnya"],
      ["Periode", "2026-09-01 s.d. 2026-09-30", "2026-08-01 s.d. 2026-08-31"],
      ["Omzet", "135000", "45000"],
      ["Pesanan", "2", "1"],
    ]);
    // every section's sheet holds exactly the rows its CSV has
    const trimEnd = (r: string[]) => {
      const out = [...r];
      while (out.length > 0 && out[out.length - 1] === "") out.pop();
      return out;
    };
    for (const section of SALES_SECTIONS) {
      const text = (await c.get(`/v1/reports/sales/export?from=2026-09-01&to=2026-09-30&section=${section}`)).text;
      const csvRows = text
        .replace(/^\uFEFF/, "")
        .trimEnd()
        .split("\r\n")
        .map((l) => trimEnd(l.split(";").map(unguardCell)));
      expect(csvRows.length, section).toBeGreaterThan(1);
      expect(sheets.find((s) => s.name === SALES_SHEET_NAMES[section])!.rows.map(trimEnd), section).toEqual(csvRows);
    }

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
    // the same rows as an Excel workbook
    const xlsx = await download(c, "/v1/inventory/restock/export?format=xlsx");
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers["content-disposition"]).toBe('attachment; filename="perlu-restock.xlsx"');
    const rows = readXlsx(xlsx.bytes, 50).rows;
    expect(rows[0]).toEqual(
      csv
        .split("\r\n")[0]!
        .replace(/^\uFEFF/, "")
        .split(";"),
    );
    expect(rows.find((r) => r[0] === "TOPI-1")?.slice(0, 3)).toEqual(["TOPI-1", "Produk TOPI", "1"]);
    expect(rows.find((r) => r[0] === "TOPI-1")?.at(-1)).toBe("Cepat habis");
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
    // a Viewer may choose the daily email and the sales report emails, nothing else (L44)
    expect((await viewer.c.get("/v1/notifications/preferences")).body.items).toEqual([
      expect.objectContaining({ kind: "digest.daily", email: true, emailByDefault: true, inApp: "always" }),
      expect.objectContaining({
        kind: "report.sales_weekly",
        email: false,
        emailByDefault: false,
        inApp: "with_email",
      }),
      expect.objectContaining({ kind: "report.sales_monthly", email: false, locked: false, feature: null }),
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

describe("scheduled report emails (FR-RPT-05, backend doc 8.20)", () => {
  it("mails the week's sales and team reports as Excel to the people who chose them, once per period", async () => {
    const { c, me, tenantId, warehouseId } = await business();
    const v = await product(c, "JAKET", ["JAKET-1"]);
    await c.post("/v1/inventory/adjustments", {
      lines: [{ variantId: v["JAKET-1"], warehouseId, mode: "set", quantity: 20 }],
      reason: "correction",
    });
    const store = await connectShopee(c, tenantId, [item(981, ["JAKET-1"])]);
    const other = await connectShopee(c, tenantId, [item(982, ["JAKET-1"])]);
    const today = localDate(TZ, new Date());
    // the week before the one holding today, as the Monday email reports it
    const period = { from: addDays(mondayOf(today), -7), to: addDays(mondayOf(today), -1) };
    const sold = [
      order(981, [{ model: 9811, sku: "JAKET-1", qty: 2 }], {
        create_time: wib(`${period.from}T10:00:00`),
        order_status: "COMPLETED",
      }),
      order(981, [{ model: 9811, sku: "JAKET-1", qty: 1 }], {
        create_time: wib(`${period.to}T20:00:00`),
        order_status: "COMPLETED",
      }),
    ];
    store.orders.push(...sold);
    for (const o of sold) await push(tenantId, store.shopId, o);

    // who may choose what (L44): the owner every report, a Viewer the sales reports, CS none
    const viewer = await addMember(c, tenantId, "Viewer");
    const silent = await addMember(c, tenantId, "Viewer"); // may read reports, chooses nothing
    const cs = await addMember(c, tenantId, "CS");
    const ownerKinds = (await c.get("/v1/notifications/preferences")).body.items as {
      kind: string;
      inApp: string;
      feature: string | null;
    }[];
    expect(ownerKinds.filter((k) => k.kind.startsWith("report."))).toEqual([
      {
        kind: "report.sales_weekly",
        inApp: "with_email",
        feature: null,
        email: false,
        emailByDefault: false,
        locked: false,
        label: expect.stringContaining("Senin pukul 07.00"),
      },
      expect.objectContaining({
        kind: "report.sales_monthly",
        label: expect.stringContaining("tanggal 1 pukul 07.00"),
      }),
      expect.objectContaining({ kind: "report.staff_weekly", feature: "staff_report" }),
      expect.objectContaining({ kind: "report.staff_monthly", feature: "staff_report", inApp: "with_email" }),
    ]);
    expect((await cs.c.get("/v1/notifications/preferences")).body.items.map((k: { kind: string }) => k.kind)).toEqual([
      "digest.daily",
    ]);
    expect((await cs.c.put("/v1/notifications/preferences/report.staff_weekly", { email: true })).status).toBe(404);
    expect((await viewer.c.put("/v1/notifications/preferences/report.staff_weekly", { email: true })).status).toBe(404);
    const chosen = await viewer.c.put("/v1/notifications/preferences/report.sales_weekly", { email: true });
    expect(chosen.status).toBe(200);
    expect(chosen.body.items.find((k: { kind: string }) => k.kind === "report.sales_weekly").email).toBe(true);
    expect((await c.put("/v1/notifications/preferences/report.sales_weekly", { email: true })).status).toBe(200);
    expect((await c.put("/v1/notifications/preferences/report.staff_weekly", { email: true })).status).toBe(200);
    // the Viewer sees only the second store: their workbook will hold none of the sales
    const viewerId = (await viewer.c.get("/v1/me")).body.user.id as string;
    expect((await c.put(`/v1/users/${viewerId}/scopes`, { storeIds: [other.storeId] })).status).toBe(200);

    // the scan: a business older than a day, from Monday 07.00 local, and again until the week is over
    // a business younger than a day is left alone, even on its first Monday morning
    await h.system.db.execute(
      sql`UPDATE tenant SET created_at = ${`${period.to}T23:00:00+07:00`}::timestamptz WHERE id = ${tenantId}`,
    );
    const added: { payload: Record<string, string>; jobId: string; delay: number | undefined }[] = [];
    const queues = {
      get: () => ({
        add: async (_name: string, payload: Record<string, string>, o: { jobId: string; delay?: number }) =>
          added.push({ payload, jobId: o.jobId, delay: o.delay }),
      }),
    } as unknown as QueueRegistry;
    const registry = new JobRegistry(JOB_DEFINITIONS);
    const monday = addDays(period.to, 1);
    const mine = () => added.filter((a) => a.payload.tenantId === tenantId && a.payload.cadence === "weekly");
    await scanScheduledReports(h.system, queues, registry, new Date(`${monday}T07:05:00+07:00`));
    expect(mine()).toEqual([]);
    // the business exists since the period's first day: the week is owed from Monday 07.00, an older month is not
    await h.system.db.execute(
      sql`UPDATE tenant SET created_at = ${`${period.from}T00:00:00+07:00`}::timestamptz WHERE id = ${tenantId}`,
    );
    await scanScheduledReports(h.system, queues, registry, new Date(`${monday}T06:30:00+07:00`));
    expect(mine()).toEqual([]);
    const at = new Date(`${monday}T07:05:00+07:00`);
    await scanScheduledReports(h.system, queues, registry, at);
    const slot = `h${Math.floor(at.getTime() / 3_600_000)}`;
    expect(mine()).toEqual([
      {
        payload: { tenantId, cadence: "weekly", periodStart: period.from, periodEnd: period.to, slot },
        jobId: `report.scheduled|${tenantId}|weekly|${period.from}|${slot}`,
        delay: scanDelayMs(tenantId),
      },
    ]);
    // Tuesday: still the same week's report, in another hour's slot; the monthly report only on the 1st
    await scanScheduledReports(h.system, queues, registry, new Date(`${addDays(monday, 1)}T09:00:00+07:00`));
    expect(mine().map((a) => a.payload.cadence)).toEqual(["weekly", "weekly"]);
    expect(new Set(mine().map((a) => a.jobId)).size).toBe(2);
    const firstOfMonth = addDays(`${addDays(monday, 31).slice(0, 8)}01`, 0);
    await scanScheduledReports(h.system, queues, registry, new Date(`${firstOfMonth}T07:30:00+07:00`));
    const monthly = added.find((a) => a.payload.tenantId === tenantId && a.payload.cadence === "monthly")!;
    expect(monthly.payload.periodStart!.slice(8)).toBe("01");
    expect(addDays(monthly.payload.periodEnd!, 1)).toBe(firstOfMonth);

    // the job: one period claimed once; a notification and an email per person, with their own workbook
    const sentBefore = worker.email.sent.length;
    await worker.runJob(
      reportScheduledJob,
      { cadence: "weekly", periodStart: period.from, periodEnd: period.to, slot },
      tenantId,
    );
    expect(await drain(tenantId)).toEqual(["notification.email", "notification.email", "notification.email"]);
    const mails = worker.email.sent.slice(sentBefore);
    expect(mails.map((m) => [m.to, m.attachments?.map((a) => a.filename)]).sort()).toEqual(
      [
        [me.user.email, [`penjualan-${period.from}-${period.to}.xlsx`]],
        [me.user.email, [`kinerja-tim-${period.from}-${period.to}.xlsx`]],
        [viewer.email, [`penjualan-${period.from}-${period.to}.xlsx`]],
      ].sort(),
    );
    const title = (m: { subject: string }) => m.subject;
    expect(mails.map(title).sort()).toEqual(
      [
        `Laporan penjualan minggu ${periodLabelOf(period)} (${me.tenant.name})`,
        `Laporan kinerja tim minggu ${periodLabelOf(period)} (${me.tenant.name})`,
        `Laporan penjualan minggu ${periodLabelOf(period)} (${me.tenant.name})`,
      ].sort(),
    );
    const ownerSales = mails.find(
      (m) => m.to === me.user.email && m.attachments?.[0]?.filename.startsWith("penjualan"),
    )!;
    expect(ownerSales.text).toContain("Terlampir:");
    expect(ownerSales.attachments?.[0]?.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const ownerBook = readXlsxAll(ownerSales.attachments![0]!.content, 50);
    expect(ownerBook.map((s) => s.name)).toEqual([
      "Ringkasan",
      "Per periode",
      "Per kanal",
      "Per toko",
      "Per produk",
      "Per kategori",
      "Per wilayah",
      "Per jam",
    ]);
    expect(ownerBook[0]!.rows[1]).toEqual(["Periode", `${period.from} s.d. ${period.to}`, expect.any(String)]);
    expect(ownerBook[0]!.rows[2]).toEqual(["Omzet", "135000", "0"]);
    expect(ownerBook[4]!.rows[1]).toEqual(["JAKET-1", "Produk JAKET", "1", "3", "2", "135000"]);
    // the Viewer's workbook is theirs: the second store sold nothing
    const viewerBook = readXlsxAll(mails.find((m) => m.to === viewer.email)!.attachments![0]!.content, 50);
    expect(viewerBook[0]!.rows[2]).toEqual(["Omzet", "0", "0"]);
    const team = readXlsxAll(
      mails.find((m) => m.attachments?.[0]?.filename.startsWith("kinerja"))!.attachments![0]!.content,
      50,
    );
    expect(team.map((s) => s.name)).toEqual(["Ringkasan", "Per anggota", "Per anggota per hari", "Per hari"]);
    expect(mails.some((m) => m.to === cs.email || m.to === silent.email)).toBe(false);
    // the in-app notice says where the Excel went and opens the period
    const notices = (await viewer.c.get("/v1/notifications")).body.items as {
      kind: string;
      title: string;
      body: string;
      data: Record<string, string>;
    }[];
    expect(notices[0]).toMatchObject({
      kind: "report.sales_weekly",
      title: `Laporan penjualan minggu ${periodLabelOf(period)}`,
      body: expect.stringContaining("berkas Excel"),
      data: { report: "sales", cadence: "weekly", from: period.from, to: period.to },
    });

    // the same period again plans nothing, and the scan no longer picks it
    await worker.runJob(
      reportScheduledJob,
      { cadence: "weekly", periodStart: period.from, periodEnd: period.to, slot: "again" },
      tenantId,
    );
    expect(await drain(tenantId)).toEqual([]);
    added.length = 0;
    await scanScheduledReports(h.system, queues, registry, new Date(`${addDays(monday, 2)}T09:00:00+07:00`));
    expect(mine()).toEqual([]);

    // on Starter the team report cannot be chosen, and a choice from the trial sends nothing
    expect((await c.post("/v1/billing/subscription", { planCode: "starter" })).status).toBe(200);
    const refused = await c.put("/v1/notifications/preferences/report.staff_monthly", { email: true });
    expect([refused.status, refused.body.code]).toEqual([422, "billing.feature_unavailable"]);
    expect((await c.put("/v1/notifications/preferences/report.staff_weekly", { email: true })).status).toBe(422);
    // the owner's weekly team report, chosen on the trial, stays chosen and goes to nobody on Starter
    expect(
      (await c.get("/v1/notifications/preferences")).body.items.find(
        (k: { kind: string }) => k.kind === "report.staff_weekly",
      ),
    ).toMatchObject({ email: true, feature: "staff_report" });
    const before = { from: addDays(period.from, -7), to: addDays(period.to, -7) };
    const sentBefore2 = worker.email.sent.length;
    await worker.runJob(
      reportScheduledJob,
      { cadence: "weekly", periodStart: before.from, periodEnd: before.to, slot },
      tenantId,
    );
    expect(await drain(tenantId)).toEqual(["notification.email", "notification.email"]);
    expect(worker.email.sent.slice(sentBefore2).map((m) => m.attachments?.[0]?.filename)).toEqual([
      `penjualan-${before.from}-${before.to}.xlsx`,
      `penjualan-${before.from}-${before.to}.xlsx`,
    ]);
  });
});

/** "6–12 Okt 2026" as the plan words a week; the spec repeats the rule only for the same-month case it uses. */
function periodLabelOf(period: { from: string; to: string }): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const d = (x: string) => Number(x.slice(8, 10));
  const m = (x: string) => months[Number(x.slice(5, 7)) - 1];
  const y = (x: string) => x.slice(0, 4);
  if (period.from.slice(0, 7) === period.to.slice(0, 7))
    return `${d(period.from)}–${d(period.to)} ${m(period.to)} ${y(period.to)}`;
  if (y(period.from) === y(period.to))
    return `${d(period.from)} ${m(period.from)}–${d(period.to)} ${m(period.to)} ${y(period.to)}`;
  return `${d(period.from)} ${m(period.from)} ${y(period.from)}–${d(period.to)} ${m(period.to)} ${y(period.to)}`;
}
