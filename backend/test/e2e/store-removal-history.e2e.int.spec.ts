import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { internalEan13, isValidGtin } from "../../src/common/barcode";
import { systemContext } from "../../src/common/context/request-context";
import type { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { storeConnectionCheckJob } from "../../src/modules/channel/channel.jobs";
import { MM } from "../../src/modules/fulfillment/shipping-plan";
import { orderPullJob } from "../../src/modules/orders/orders.jobs";
import { StoreDataDeletionService } from "../../src/modules/retention/store-data-deletion.service";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
import { scanConnectionAlerts } from "../../src/scheduler/channel-scans";
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
 * Disconnecting a store with or without its data, connection alerts, product history, and barcodes end to
 * end (backend doc 8.23; PRD FR-INT-07, 08, FR-PRD-11, 12).
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 998000;
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
  for (let i = 0; i < 30; i++) {
    const round = await worker.runOutbox(tenantId);
    if (round.length === 0) break;
    ran.push(...round);
  }
  return ran;
}

async function business() {
  const { c, me, email } = await signup(api);
  const warehouseId = (await c.get("/v1/warehouses")).body.items[0].id as string;
  return { c, me, email, tenantId: me.tenant.id, warehouseId };
}

async function product(c: Client, sku: string, variantSkus: string[]) {
  const res = await c.post("/v1/products", {
    sku,
    name: `Produk ${sku}`,
    variants: variantSkus.map((v) => ({ sku: v, basePrice: 50_000, costPrice: 20_000, weightG: 200 })),
  });
  expect(res.status).toBe(201);
  return {
    id: res.body.id as string,
    v: Object.fromEntries((res.body.variants as { id: string; sku: string }[]).map((v) => [v.sku, v.id])),
  };
}

async function stock(c: Client, warehouseId: string, lines: Record<string, number>) {
  const res = await c.post("/v1/inventory/adjustments", {
    lines: Object.entries(lines).map(([variantId, quantity]) => ({ variantId, warehouseId, mode: "set", quantity })),
    reason: "correction",
  });
  expect(res.status).toBe(200);
}

async function reserved(c: Client, sku: string): Promise<number> {
  const item = (await c.get(`/v1/inventory?q=${sku}`)).body.items[0] as { warehouses: { reserved: number }[] };
  return item.warehouses.reduce((n, w) => n + w.reserved, 0);
}

const kaosItem = (itemId: number): MockShopeeItem => ({
  item_id: itemId,
  item_name: "Kaos",
  item_sku: "KAOS",
  item_status: "NORMAL",
  update_time: 1_700_000_000,
  tiers: [{ name: "Ukuran", options: ["M", "L", "XL"] }],
  models: [
    { model_id: itemId * 10 + 1, model_sku: "KAOS-M", tier_index: [0], price: 50_000, stock: 3 },
    { model_id: itemId * 10 + 2, model_sku: "KAOS-L", tier_index: [1], price: 50_000, stock: 3 },
    // no product has this SKU: its listing stays unmapped
    { model_id: itemId * 10 + 3, model_sku: "KAOS-XL", tier_index: [2], price: 50_000, stock: 3 },
  ],
});

function shopeeOrder(
  itemId: number,
  lines: { model: number; sku: string; qty: number }[],
  extra: Partial<MockShopeeOrder> = {},
): MockShopeeOrder {
  const t = nowSec();
  return {
    order_sn: `2610130${String(snSeq++).padStart(6, "0")}`,
    order_status: "READY_TO_SHIP",
    create_time: t - 4000,
    update_time: t - 30,
    pay_time: t - 3900,
    ship_by_date: t + 2 * 86_400,
    total_amount: lines.reduce((n, l) => n + l.qty * 45_000, 0),
    buyer_user_id: 7000 + snSeq,
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

/** A Shopee shop in the fake marketplace, with orders it already had before connecting. */
function addShop(itemId: number, history: MockShopeeOrder[] = []) {
  const shopId = String(++shopSeq);
  const orders: MockShopeeOrder[] = [...history];
  mock.addShopeeShop({
    shopId,
    name: `Toko ${shopId}`,
    region: "ID",
    warehouses: "not_whitelisted",
    items: [kaosItem(itemId)],
    orders,
  });
  return { shopId, orders };
}

/** Connects the shop and imports it; the authorization's outcome, and the store when it connected. */
async function connect(c: Client, tenantId: string, shopId: string, live = true) {
  const started = await c.post("/v1/store-authorizations", { channel: "shopee" });
  await c.post("/v1/store-authorizations/callback", {
    channel: "shopee",
    state: new URL(started.body.authorizeUrl).searchParams.get("state"),
    code: mock.shopeeCode({ shopId }),
    shopId,
  });
  await drain(tenantId);
  const auth = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body;
  const storeId = auth.result.stores[0]?.storeId as string | undefined;
  if (storeId && live) {
    expect((await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" })).status).toBe(200);
    await drain(tenantId);
  }
  return { auth, storeId: storeId! };
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

async function orderBy(c: Client, externalOrderId: string, storeId?: string) {
  const list = (await c.get(`/v1/orders?q=${externalOrderId}${storeId ? `&storeId=${storeId}` : ""}`)).body.items as {
    id: string;
    externalOrderId: string;
  }[];
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
  return PDFDocument.load(res.body as Buffer);
}

/** A scheduler scan, with the jobs it would queue collected instead of queued. */
async function connectionScan(): Promise<string[]> {
  const added: { tenantId: string }[] = [];
  const queues = {
    get: () => ({ add: async (_n: string, p: { tenantId: string }) => added.push(p) }),
  } as unknown as QueueRegistry;
  await scanConnectionAlerts(h.system, queues, new JobRegistry(JOB_DEFINITIONS));
  return added.map((a) => a.tenantId);
}

const notifications = async (c: Client) =>
  (await c.get("/v1/notifications")).body.items as {
    kind: string;
    severity: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
  }[];

describe("disconnecting a store (FR-INT-07)", () => {
  it("keeps the history, releases the stock open orders held, and frees the shop for another business", async () => {
    const { c, tenantId, warehouseId } = await business();
    const { v } = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 10, [v["KAOS-L"]!]: 2 });
    const { shopId, orders } = addShop(801);
    const { storeId } = await connect(c, tenantId, shopId);
    const open = shopeeOrder(801, [{ model: 8011, sku: "KAOS-M", qty: 2 }]);
    // more than the stock: an insufficient_stock problem that a stock change re-checks
    const short = shopeeOrder(801, [{ model: 8012, sku: "KAOS-L", qty: 5 }]);
    const done = shopeeOrder(801, [{ model: 8011, sku: "KAOS-M", qty: 1 }], { order_status: "COMPLETED" });
    // a line whose listing is not mapped yet holds nothing
    const unmapped = shopeeOrder(801, [{ model: 8013, sku: "KAOS-XL", qty: 1 }]);
    orders.push(open, short, done, unmapped);
    for (const o of [open, short, done, unmapped]) await pushOrder(tenantId, shopId, o);
    expect(await reserved(c, "KAOS-M")).toBe(2);
    expect(await reserved(c, "KAOS-L")).toBe(5);
    const before = (await c.get("/v1/orders/summary")).body.statuses;
    expect((before.new ?? 0) + (before.problem ?? 0)).toBe(3);

    const res = await c.post(`/v1/stores/${storeId}/disconnect`, { keepData: true });
    expect(res.status).toBe(200);
    expect(res.body.store).toMatchObject({ status: "disconnected", dataDeletion: null });
    expect(await drain(tenantId)).toContain("order.store_disconnected");

    // nothing will ship the open orders through OmniSeller: their stock goes back, their status stays
    expect(await reserved(c, "KAOS-M")).toBe(0);
    expect(await reserved(c, "KAOS-L")).toBe(0);
    const o = await orderBy(c, open.order_sn, storeId);
    expect(o.status).toBe("new");
    expect(o.events.map((e: { type: string }) => e.type)).toContain("store_disconnected");
    // out of the work queue and its counters, still there as history of the store
    expect((await c.get(`/v1/orders?q=${open.order_sn}`)).body.items).toEqual([]);
    expect((await c.get(`/v1/orders?q=${done.order_sn}`)).body.items).toHaveLength(1);
    const after = (await c.get("/v1/orders/summary")).body.statuses;
    expect((after.new ?? 0) + (after.problem ?? 0)).toBe(0);
    expect((await c.get(`/v1/orders?storeId=${storeId}`)).body.items).toHaveLength(4);
    // a stock change re-checks short orders, and a mapping gives lines their variant; neither holds
    // stock again for a disconnected store
    await stock(c, warehouseId, { [v["KAOS-L"]!]: 20 });
    await drain(tenantId);
    expect(await reserved(c, "KAOS-L")).toBe(0);
    const xl = (await c.get(`/v1/listings?storeId=${storeId}&q=KAOS-XL`)).body.items[0] as { id: string };
    expect((await c.put(`/v1/listings/${xl.id}/mapping`, { variantId: v["KAOS-M"] })).status).toBe(200);
    await drain(tenantId);
    expect(await reserved(c, "KAOS-M")).toBe(0);
    expect((await c.get("/v1/stores")).body.items.map((s: { id: string }) => s.id)).toEqual([storeId]);

    // another business connects the shop now, and its notifications go there
    const b = await business();
    const taken = await connect(b.c, b.tenantId, shopId, false);
    expect(taken.auth.status).toBe("succeeded");
    const later = shopeeOrder(801, [{ model: 8011, sku: "KAOS-M", qty: 1 }]);
    orders.push(later);
    await pushOrder(b.tenantId, shopId, later);
    expect((await b.c.get(`/v1/orders?q=${later.order_sn}`)).body.items).toHaveLength(1);
    // so this business cannot take it back
    const back = await connect(c, tenantId, shopId, false);
    expect(back.auth).toMatchObject({ status: "failed", errorCode: "shop_connected_elsewhere" });
    // a manual sales channel is archived the same way; it has nothing to revoke
    const manual = await c.post("/v1/stores/manual", { name: "WhatsApp" });
    const archived = await c.post(`/v1/stores/${manual.body.id}/disconnect`, {});
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ store: { status: "disconnected" }, revokeUrl: null });
  });

  it("deletes the store's orders, listings, warehouses, and sync log in batches, and keeps the store as a marker", async () => {
    const { c, tenantId, warehouseId } = await business();
    const { v } = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 10, [v["KAOS-L"]!]: 10 });
    const t = nowSec();
    // 210 finished orders from before: more than one batch of 200
    const history = Array.from({ length: 210 }, (_, i) =>
      shopeeOrder(802, [{ model: 8021, sku: "KAOS-M", qty: 1 }], {
        order_status: "COMPLETED",
        create_time: t - 86_400 * 3 - i,
        update_time: t - 86_400 * 2 - i,
      }),
    );
    const { shopId, orders } = addShop(802, history);
    const { storeId } = await connect(c, tenantId, shopId);
    expect((await c.get(`/v1/orders?storeId=${storeId}&limit=1`)).body.items).toHaveLength(1);
    // an open order with its shipment arranged and its label stored
    const open = shopeeOrder(802, [{ model: 8022, sku: "KAOS-L", qty: 2 }]);
    orders.push(open);
    await pushOrder(tenantId, shopId, open);
    const o = await orderBy(c, open.order_sn);
    expect((await c.post("/v1/shipments/arrange", { orderIds: [o.id], method: "pickup" })).status).toBe(200);
    await drain(tenantId);
    const labelFiles = await h.system.db.execute<{ id: string }>(
      sql`SELECT p.label_file_id AS id FROM shipment_package p JOIN shipment s ON s.id = p.shipment_id
           WHERE s.order_id = ${o.id} AND p.label_file_id IS NOT NULL`,
    );
    expect(labelFiles.rows.length).toBeGreaterThan(0);
    const doc = await c.post("/v1/documents", { kind: "labels", orderIds: [o.id] });
    await drain(tenantId);
    const docFile = (await c.get(`/v1/documents/${doc.body.id}`)).body.downloadUrl as string;
    expect(await reserved(c, "KAOS-L")).toBe(2);
    const movementCount = async () =>
      Number(
        (
          await h.system.db.execute<{ n: string }>(
            sql`SELECT count(*)::text AS n FROM stock_movement WHERE tenant_id = ${tenantId}`,
          )
        ).rows[0]!.n,
      );

    const movementsBefore = await movementCount();
    const res = await c.post(`/v1/stores/${storeId}/disconnect`, { keepData: false });
    expect(res.status).toBe(200);
    expect(res.body.store.dataDeletion).toMatchObject({ deletedAt: null });
    expect(res.body.store.dataDeletion.requestedAt).toEqual(expect.any(String));
    // the store leaves the list at once
    expect((await c.get("/v1/stores")).body.items).toEqual([]);
    // one deletion run stops after a batch when its time is up (the queued jobs have not run yet)
    const service = worker.ctx.get(StoreDataDeletionService);
    expect(await service.run(systemContext(tenantId), storeId, -1)).toBe("continued");
    const left = await h.system.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM "order" WHERE store_id = ${storeId}`,
    );
    expect(Number(left.rows[0]!.n)).toBe(11);
    // the queued run finishes it; the continuation finds nothing left
    expect(await drain(tenantId)).toEqual(
      expect.arrayContaining(["order.store_disconnected", "store.data_delete", "store.data_delete"]),
    );

    const counts = await h.system.db.execute<Record<string, string>>(sql`
      SELECT (SELECT count(*) FROM "order" WHERE store_id = ${storeId})::text AS orders,
             (SELECT count(*) FROM shipment WHERE tenant_id = ${tenantId})::text AS shipments,
             (SELECT count(*) FROM channel_listing WHERE store_id = ${storeId})::text AS listings,
             (SELECT count(*) FROM channel_warehouse WHERE store_id = ${storeId})::text AS warehouses,
             (SELECT count(*) FROM sync_job WHERE store_id = ${storeId})::text AS sync_jobs,
             (SELECT count(*) FROM sync_cursor WHERE store_id = ${storeId})::text AS cursors`);
    expect(counts.rows[0]).toEqual({
      orders: "0",
      shipments: "0",
      listings: "0",
      warehouses: "0",
      sync_jobs: "0",
      cursors: "0",
    });
    expect(await reserved(c, "KAOS-L")).toBe(0);
    // stock movements stay, they record what happened to the stock; one more released the open order's
    expect(await movementCount()).toBe(movementsBefore + 1);
    // label files and printed documents with buyer data expire now for the file cleanup
    const fileId = docFile.split("/")[3]!;
    const fileIds = [...labelFiles.rows.map((r) => r.id), fileId];
    const expiring = await h.system.db.execute<{ id: string }>(
      sql`SELECT id FROM file_object WHERE id = ANY(${`{${fileIds.join(",")}}`}::text[]) AND expires_at <= now()`,
    );
    expect(expiring.rows).toHaveLength(labelFiles.rows.length + 1);
    const marker = (await c.get(`/v1/stores/${storeId}`)).body;
    expect(marker).toMatchObject({ status: "disconnected" });
    expect(marker.dataDeletion.deletedAt).toEqual(expect.any(String));

    // connecting the shop again starts a new store with a fresh import
    const again = await connect(c, tenantId, shopId, false);
    expect(again.auth.status).toBe("succeeded");
    expect(again.storeId).not.toBe(storeId);
    const imported = await h.system.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM "order" WHERE store_id = ${again.storeId}`,
    );
    expect(Number(imported.rows[0]!.n)).toBe(211);
  });
});

describe("connection alerts (FR-INT-08)", () => {
  it("tells the store's managers in-app and by email after 15 minutes down, once, and when it is back", async () => {
    const { c, tenantId, email: ownerEmail } = await business();
    await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    const { shopId } = addShop(803);
    const { storeId } = await connect(c, tenantId, shopId);
    const second = await connect(c, tenantId, addShop(804).shopId);
    const cs = await addMember(c, tenantId, "CS");

    // Shopee does not answer: the outage starts with the first failed call
    mock.failNext("GET", "/api/v2/order/get_order_list", 503, { error: "error_server", message: "System busy." });
    await expect(worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId)).rejects.toThrow();
    const failingSince = (await c.get(`/v1/stores/${storeId}`)).body.failingSince as string;
    expect(failingSince).toEqual(expect.any(String));
    // not yet 15 minutes
    expect(await connectionScan()).not.toContain(tenantId);
    await h.system.db.execute(
      sql`UPDATE store SET failing_since = now() - interval '20 minutes' WHERE id = ${storeId}`,
    );
    expect(await connectionScan()).toContain(tenantId);
    // the other store of the business started failing just now: too early to tell anyone about it
    mock.failNext("GET", "/api/v2/order/get_order_list", 503, { error: "error_server", message: "System busy." });
    await expect(
      worker.runJob(orderPullJob, { storeId: second.storeId, mode: "incremental" }, tenantId),
    ).rejects.toThrow();
    await worker.runJob(storeConnectionCheckJob, {}, tenantId);
    const [lost, ...others] = await notifications(c);
    expect(others.filter((n) => n.kind === "store.connection_lost")).toEqual([]);
    expect(lost).toMatchObject({
      kind: "store.connection_lost",
      severity: "critical",
      data: { storeId, cause: "unreachable" },
    });
    expect(lost!.body).toMatch(/tidak bisa menghubungi Shopee untuk toko ini sejak 20 menit lalu/);
    // the people who do not manage stores are not told
    expect(await notifications(cs)).toEqual([]);
    expect(await drain(tenantId)).toContain("notification.email");
    expect(worker.email.lastTo(ownerEmail)).toMatchObject({ subject: expect.stringContaining("terputus dari Shopee") });
    // once per outage
    await worker.runJob(storeConnectionCheckJob, {}, tenantId);
    expect(await connectionScan()).not.toContain(tenantId);
    expect((await notifications(c)).filter((n) => n.kind === "store.connection_lost")).toHaveLength(1);

    // the next call that works ends the outage; its managers hear it is back
    await worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId);
    expect((await c.get(`/v1/stores/${storeId}`)).body.failingSince).toBeNull();
    expect(await connectionScan()).toContain(tenantId);
    await worker.runJob(storeConnectionCheckJob, {}, tenantId);
    expect((await notifications(c))[0]).toMatchObject({ kind: "store.connection_restored", severity: "info" });
    expect(await connectionScan()).not.toContain(tenantId);

    // an authorization that is gone counts after 15 minutes too
    await h.system.db.execute(sql`UPDATE store SET status = 'reauth_required', status_reason = 'authorization_revoked',
                                         status_changed_at = now() - interval '16 minutes' WHERE id = ${storeId}`);
    await worker.runJob(storeConnectionCheckJob, {}, tenantId);
    expect((await notifications(c))[0]).toMatchObject({
      kind: "store.connection_lost",
      data: { cause: "authorization" },
    });
    expect((await notifications(c))[0]!.body).toMatch(/Hubungkan ulang toko/);

    // always sent: shown in the preferences, but cannot be turned off
    const prefs = (await c.get("/v1/notifications/preferences")).body.items;
    expect(prefs).toContainEqual(expect.objectContaining({ kind: "store.connection_lost", email: true, locked: true }));
    const off = await c.put("/v1/notifications/preferences/store.connection_lost", { email: false });
    expect(off.status).toBe(422);
    expect(off.body.code).toBe("notification_preference.locked");

    // a store disconnected on purpose is never announced
    expect((await c.post(`/v1/stores/${storeId}/disconnect`, {})).status).toBe(200);
    await h.system.db.execute(sql`UPDATE store SET failing_since = now() - interval '1 hour' WHERE id = ${storeId}`);
    expect(await connectionScan()).not.toContain(tenantId);
  });
});

describe("product history (FR-PRD-11)", () => {
  it("shows who changed the product or its variants, what, and when", async () => {
    const { c, me } = await business();
    const p = await product(c, "TAS", ["TAS-1", "TAS-2"]);
    expect((await c.patch(`/v1/products/${p.id}`, { name: "Tas Kanvas", categoryPath: "Fashion > Tas" })).status).toBe(
      200,
    );
    expect(
      (await c.patch(`/v1/products/${p.id}/variants/${p.v["TAS-1"]}`, { basePrice: 55_000, barcode: "8991234567891" }))
        .status,
    ).toBe(200);
    expect((await c.patch(`/v1/products/${p.id}/variants/${p.v["TAS-2"]}`, { status: "archived" })).status).toBe(200);

    const page = (await c.get(`/v1/products/${p.id}/history`)).body;
    const summary = page.items.map((e: { action: string; target: { type: string; sku: string } }) => [
      e.action,
      e.target.type,
      e.target.sku,
    ]);
    expect(summary.slice(0, 3)).toEqual([
      ["updated", "variant", "TAS-2"],
      ["updated", "variant", "TAS-1"],
      ["updated", "product", "TAS"],
    ]);
    // written in one transaction: the same moment, in no particular order
    expect(summary.slice(3)).toEqual(
      expect.arrayContaining([
        ["created", "variant", "TAS-2"],
        ["created", "variant", "TAS-1"],
        ["created", "product", "TAS"],
      ]),
    );
    expect(summary).toHaveLength(6);
    expect(page.items[0]).toMatchObject({
      actor: { type: "user", id: me.user.id, name: me.user.name },
      changes: [{ field: "status", label: "Status", before: "active", after: "archived" }],
    });
    expect(page.items[1].changes).toEqual([
      { field: "barcode", label: "Barcode", before: null, after: "8991234567891" },
      { field: "basePrice", label: "Harga dasar", before: 50_000, after: 55_000 },
    ]);
    // in the order of the product form
    expect(page.items[2].changes).toEqual([
      { field: "name", label: "Nama produk", before: "Produk TAS", after: "Tas Kanvas" },
      { field: "categoryPath", label: "Kategori", before: null, after: "Fashion > Tas" },
    ]);
    // pages of the same list
    const first = (await c.get(`/v1/products/${p.id}/history?limit=4`)).body;
    expect(first.items).toHaveLength(4);
    const rest = (await c.get(`/v1/products/${p.id}/history?limit=4&cursor=${first.next_cursor}`)).body;
    expect([...first.items, ...rest.items].map((e: { id: string }) => e.id)).toEqual(
      page.items.map((e: { id: string }) => e.id),
    );
    expect(rest.next_cursor).toBeNull();
    expect((await c.get(`/v1/products/${p.v["TAS-1"]}/history`)).status).toBe(404);
  });
});

describe("barcodes (FR-PRD-12)", () => {
  it("checks EAN digits, numbers internal barcodes, and finds variants by a scanned code", async () => {
    const { c } = await business();
    const p = await product(c, "SEPATU", ["SEPATU-39", "SEPATU-40", "SEPATU-41"]);
    // someone typed in what would be the first internal number
    expect(
      (await c.patch(`/v1/products/${p.id}/variants/${p.v["SEPATU-41"]}`, { barcode: internalEan13(1) })).status,
    ).toBe(200);
    const wrong = await c.patch(`/v1/products/${p.id}/variants/${p.v["SEPATU-39"]}`, { barcode: "8991234567890" });
    expect(wrong.status).toBe(422);
    expect(JSON.stringify(wrong.body)).toContain("Digit terakhir");
    expect(
      (await c.patch(`/v1/products/${p.id}/variants/${p.v["SEPATU-39"]}`, { barcode: "8991234567891" })).status,
    ).toBe(200);
    const imported = await c.post("/v1/products/import", {
      content: "sku_produk;nama_produk;sku_varian;barcode;harga_jual;berat_gram\nBARU;Baru;BARU-1;12345678;10000;100",
      dryRun: true,
    });
    expect(imported.status).toBe(422);
    expect(imported.body.errors).toContainEqual(expect.objectContaining({ path: "rows.2.barcode" }));

    const generated = await c.post("/v1/products/barcodes", { variantIds: [p.v["SEPATU-39"], p.v["SEPATU-40"]] });
    expect(generated.status).toBe(200);
    const by = Object.fromEntries(
      (generated.body.items as { sku: string; barcode: string; generated: boolean }[]).map((i) => [i.sku, i]),
    );
    expect(by["SEPATU-39"]).toMatchObject({ barcode: "8991234567891", generated: false });
    expect(by["SEPATU-40"]!.generated).toBe(true);
    // the number already in use is skipped
    expect(by["SEPATU-40"]!.barcode).toBe(internalEan13(2));
    expect(isValidGtin(by["SEPATU-40"]!.barcode)).toBe(true);
    // asked again, nothing changes
    const again = await c.post("/v1/products/barcodes", { variantIds: [p.v["SEPATU-40"]] });
    expect(again.body.items).toEqual([
      expect.objectContaining({ barcode: by["SEPATU-40"]!.barcode, generated: false }),
    ]);

    expect((await c.get(`/v1/products/lookup?code=${by["SEPATU-40"]!.barcode}`)).body).toMatchObject({
      matchedBy: "barcode",
      variant: { id: p.v["SEPATU-40"], sku: "SEPATU-40" },
      product: { id: p.id, sku: "SEPATU" },
    });
    expect((await c.get("/v1/products/lookup?code=sepatu-39")).body).toMatchObject({
      matchedBy: "sku",
      variant: { barcode: "8991234567891" },
    });
    expect((await c.get("/v1/products/lookup?code=TIDAK-ADA")).status).toBe(404);
    // the history shows who gave it the number
    const history = (await c.get(`/v1/products/${p.id}/history`)).body.items;
    expect(history[0]).toMatchObject({ target: { sku: "SEPATU-40" }, changes: [{ field: "barcode", before: null }] });
  });

  it("prints barcode labels on label stock and A4, and says which codes could not be printed", async () => {
    const { c, tenantId } = await business();
    const p = await product(c, "KAOS", ["KAOS-POLOS-HITAM-XL-LENGAN-PANJANG", "KAOS-É", "KAOS-EAN"]);
    const ean = p.v["KAOS-EAN"]!;
    await c.post("/v1/products/barcodes", { variantIds: [ean] });
    const gudang = await addMember(c, tenantId, "Gudang");
    const cs = await addMember(c, tenantId, "CS");
    const items = [
      { variantId: ean, copies: 2 },
      { variantId: p.v["KAOS-POLOS-HITAM-XL-LENGAN-PANJANG"], copies: 1 },
      { variantId: p.v["KAOS-É"], copies: 1 },
    ];
    expect((await cs.post("/v1/documents/barcode-labels", { items })).status).toBe(403);
    const requested = await gudang.post("/v1/documents/barcode-labels", { items, format: "label_50x30" });
    expect(requested.status).toBe(202);
    expect(requested.body).toMatchObject({ kind: "barcode_labels", labelFormat: "label_50x30", format: null });
    await drain(tenantId);
    const ready = (await gudang.get(`/v1/documents/${requested.body.id}`)).body;
    expect(ready).toMatchObject({
      status: "ready",
      pageCount: 3,
      result: {
        labels: 3,
        missing: [{ orderId: null, variantId: p.v["KAOS-É"], code: "barcode.unencodable" }],
        // a long SKU in Code 128 on a 50 mm label: thinner bars than cheap scanners like
        dense: [p.v["KAOS-POLOS-HITAM-XL-LENGAN-PANJANG"]],
      },
    });
    const pdf = await pdfOf(gudang, ready.downloadUrl);
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(50 * MM, 3);
    expect(pdf.getPage(0).getHeight()).toBeCloseTo(30 * MM, 3);

    const sheet = await gudang.post("/v1/documents/barcode-labels", {
      items: [{ variantId: ean, copies: 31 }],
      format: "a4_3x10",
    });
    await drain(tenantId);
    expect((await gudang.get(`/v1/documents/${sheet.body.id}`)).body).toMatchObject({
      status: "ready",
      pageCount: 2,
      result: { labels: 31, missing: [], dense: [] },
    });
    const unknown = await gudang.post("/v1/documents/barcode-labels", {
      items: [{ variantId: "01J0000000000000000000000Z", copies: 1 }],
    });
    expect(unknown.status).toBe(422);
  });
});
