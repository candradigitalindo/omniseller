import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { StockHistoryService } from "../../src/modules/inventory/stock-history.service";
import { orderPullJob } from "../../src/modules/orders/orders.jobs";
import {
  returnDueAlertJob,
  returnNewNoticeJob,
  returnPullJob,
  returnRespondJob,
} from "../../src/modules/returns/returns.jobs";
import { ReturnsRepository } from "../../src/modules/returns/returns.repository";
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
import type { MockShopeeReturn, MockTiktokCancellation, MockTiktokReturn } from "../setup/mock-returns";

/**
 * Returns end to end (PRD FR-RET-01, 02, 03, 06, 07; backend doc 8.26): requests read from Shopee and
 * Tokopedia & Shop, the seller's decisions sent with their evidence, buyers' cancellation requests,
 * parcels of orders cancelled after shipping, and returned goods received into stock or quarantine.
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 940000;
let snSeq = 1;
let notificationSeq = 7_327_112_393_057_400_000n;
const nowSec = () => Math.floor(Date.now() / 1000);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]).toString(
  "base64",
);

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

async function stockOf(c: Client, sku: string) {
  return (await c.get(`/v1/inventory?q=${sku}`)).body.items[0].warehouses[0] as {
    onHand: number;
    reserved: number;
    damaged: number;
    available: number;
  };
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

async function connectShopee(c: Client, tenantId: string, items: MockShopeeItem[], live = true) {
  const shopId = String(++shopSeq);
  mock.addShopeeShop({
    shopId,
    name: `Toko ${shopId}`,
    region: "ID",
    warehouses: "not_whitelisted",
    items,
    orders: [],
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
  return { shopId, storeId, shop: mock.shopeeShops.get(shopId)! };
}

function shopeeOrder(itemId: number, qty: number, extra: Partial<MockShopeeOrder> = {}): MockShopeeOrder {
  const t = nowSec();
  return {
    order_sn: `2610040${String(snSeq++).padStart(6, "0")}`,
    order_status: "READY_TO_SHIP",
    create_time: t - 600,
    update_time: t - 500,
    pay_time: t - 550,
    ship_by_date: t + 2 * 86_400,
    total_amount: qty * 45_000,
    buyer_user_id: 4242,
    buyer_username: "dewi",
    shipping_carrier: "SPX Express",
    recipient_address: { name: "Dewi", phone: "6281200000", city: "Jakarta Barat", full_address: "Jl. Mawar 1" },
    item_list: [
      {
        item_id: itemId,
        item_name: "Kaos",
        model_id: itemId * 10 + 1,
        model_sku: "KAOS-M",
        model_name: "M",
        model_quantity_purchased: qty,
        model_original_price: 50_000,
        model_discounted_price: 45_000,
      },
    ],
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
  await processInbox(tenantId, shopId);
}

async function processInbox(tenantId: string, shopId: string) {
  const rows = await h.system.db.execute<{ id: string }>(
    sql`SELECT id FROM webhook_inbox WHERE processed_at IS NULL AND external_shop_id = ${shopId} ORDER BY id`,
  );
  for (const r of rows.rows) await worker.runJob(webhookProcessJob, { inboxId: r.id }, tenantId);
  await drain(tenantId);
}

/** Moves a mock Shopee order to another status and tells OmniSeller, like Shopee's push. */
async function moveShopee(tenantId: string, shopId: string, o: MockShopeeOrder, status: string) {
  o.order_status = status;
  o.update_time += 10;
  await pushShopeeOrder(tenantId, shopId, o);
}

function shopeeReturn(o: MockShopeeOrder, extra: Partial<MockShopeeReturn> = {}): MockShopeeReturn {
  const t = nowSec();
  const line = o.item_list[0]!;
  return {
    return_sn: `RET${o.order_sn}`,
    order_sn: o.order_sn,
    status: "REQUESTED",
    reason: "ITEM_WRONGDAMAGED",
    text_reason: "Ukuran tidak sesuai",
    image: ["https://cf.shopee.co.id/file/bukti-1"],
    refund_amount: line.model_quantity_purchased * 45_000,
    currency: "IDR",
    create_time: t - 60,
    update_time: t - 60,
    due_date: t + 2 * 86_400,
    needs_logistics: true,
    return_solution: 0,
    item: [
      {
        item_id: line.item_id,
        model_id: line.model_id,
        name: "Kaos",
        amount: line.model_quantity_purchased,
        item_sku: "KAOS",
        variation_sku: "KAOS-M",
      },
    ],
    ...extra,
  };
}

type ReturnBody = {
  id: string;
  externalReturnId: string | null;
  kind: string;
  status: string;
  externalStatus: string;
  awaitingDecision: boolean;
  respondByAt: string | null;
  decisions: { code: string; action: string; reasons: { code: string }[] }[] | null;
  response: { decision: string; status: string; error: string | null } | null;
  items: { id: string; orderItemId: string | null; qty: number }[];
};

async function returnsOf(c: Client, query = ""): Promise<ReturnBody[]> {
  const res = await c.get(`/v1/returns${query}`);
  expect(res.status).toBe(200);
  return res.body.items;
}

async function orderBy(c: Client, externalOrderId: string) {
  const list = (await c.get(`/v1/orders?q=${externalOrderId}`)).body.items as { id: string; externalOrderId: string }[];
  const found = list.find((o) => o.externalOrderId === externalOrderId);
  expect(found, `order ${externalOrderId}`).toBeDefined();
  return (await c.get(`/v1/orders/${found!.id}`)).body;
}

type Notice = { kind: string; severity: string; title: string; body: string; data: Record<string, unknown> };
const notices = async (c: Client, kind: string): Promise<Notice[]> =>
  ((await c.get("/v1/notifications")).body.items as Notice[]).filter((n) => n.kind === kind);

/** A shipped Shopee order of `qty` units of KAOS-M, reserved first, so its units left the warehouse. */
async function shippedShopeeOrder(tenantId: string, shopId: string, itemId: number, qty: number) {
  const o = shopeeOrder(itemId, qty);
  mock.shopeeShops.get(shopId)!.orders!.push(o);
  await pushShopeeOrder(tenantId, shopId, o);
  await moveShopee(tenantId, shopId, o, "SHIPPED");
  return o;
}

describe("returns from Shopee (FR-RET-01, 02, 03)", () => {
  it("reads a return when the order says TO_RETURN, answers it, and receives the goods into stock and quarantine", async () => {
    const { c, me, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 10 });
    const { shopId, storeId } = await connectShopee(c, tenantId, [kaosItem(801)]);
    const o = await shippedShopeeOrder(tenantId, shopId, 801, 2);
    await moveShopee(tenantId, shopId, o, "COMPLETED");
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 8, reserved: 0, damaged: 0 });

    // the buyer asks to send both units back; Shopee says so only through the order's status
    const ret = shopeeReturn(o);
    mock.returns.shopee.set(shopId, [ret]);
    await moveShopee(tenantId, shopId, o, "TO_RETURN");
    const order = await orderBy(c, o.order_sn);
    expect(order.status).toBe("return_in_progress");

    const [r] = await returnsOf(c, "?awaitingDecision=true");
    expect(r).toMatchObject({
      kind: "return_refund",
      status: "requested",
      externalStatus: "REQUESTED",
      externalReturnId: ret.return_sn,
      externalOrderId: o.order_sn,
      store: { id: storeId, channel: "shopee", channelName: "Shopee" },
      warehouseId,
      reason: "Ukuran tidak sesuai",
      reasonCode: "ITEM_WRONGDAMAGED",
      refundAmount: 90_000,
      respondByAt: new Date(ret.due_date! * 1000).toISOString(),
      goodsReturn: true,
      awaitingDecision: true,
      evidence: [{ type: "image", url: "https://cf.shopee.co.id/file/bukti-1", thumbnailUrl: null, by: "buyer" }],
      items: [{ orderItemId: order.items[0].id, sku: "KAOS-M", qty: 2, receivedAt: null }],
      response: null,
    });
    expect(r!.decisions!.map((d) => [d.code, d.action, d.reasons.map((x) => x.code)])).toEqual([
      ["confirm", "accept", []],
      ["dispute", "reject", ["47", "44"]],
    ]);
    expect((await c.get("/v1/returns/summary")).body).toEqual({
      awaitingDecision: 1,
      dueSoon: 0,
      toReceive: 1,
      cancellations: 0,
      rto: 0,
      failedResponses: 0,
    });
    // the buyer's email, name, and pickup address came with the return and were left out
    const stored = await h.system.db.execute<{ j: string }>(
      sql`SELECT row_to_json(r)::text AS j FROM return_request r WHERE id = ${r!.id}`,
    );
    expect(stored.rows[0]!.j).not.toMatch(/pembeli\.rahasia|pembeli_rahasia|Rahasia|6281299990000/);

    // people who answer returns hear about it once
    await worker.runJob(returnNewNoticeJob, { slot: "s1" }, tenantId);
    await worker.runJob(returnNewNoticeJob, { slot: "s2" }, tenantId);
    expect(await notices(c, "return.new")).toMatchObject([{ title: "1 retur menunggu keputusan", severity: "info" }]);

    // accepted: the only accepting decision is chosen by itself, and sent by the worker
    const accepted = await c.post(`/v1/returns/${r!.id}/accept`, {});
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      awaitingDecision: false,
      response: { decision: "confirm", status: "pending" },
    });
    expect((await c.post(`/v1/returns/${r!.id}/accept`, {})).body.code).toBe("return.response_pending");
    await drain(tenantId);
    expect(mock.returns.decisions).toContain(`shopee:${ret.return_sn}:confirm`);
    let now = (await c.get(`/v1/returns/${r!.id}`)).body;
    expect(now).toMatchObject({
      status: "accepted",
      externalStatus: "ACCEPTED",
      awaitingDecision: false,
      response: {
        decision: "confirm",
        action: "accept",
        label: "Setujui pengembalian dana",
        status: "sent",
        error: null,
      },
    });
    // in ACCEPTED Shopee still takes a dispute (after the goods come back), not another confirmation
    expect(now.decisions.map((d: { code: string }) => d.code)).toEqual(["dispute"]);
    // the worker sent the seller's answer: the log names the seller for it, not the system (backend doc 8.28)
    const answered = (await c.get(`/v1/audit-logs?entity_type=return_request&entity_id=${r!.id}`)).body.items as {
      actorId: string | null;
      changes: { field: string; after: unknown }[];
    }[];
    expect(
      answered.find((e) => e.changes.some((ch) => ch.field === "responseStatus" && ch.after === "sent"))?.actorId,
    ).toBe(me.user.id);

    // a snapshot older than the one applied changes nothing
    const applied = ret.update_time;
    Object.assign(ret, { status: "REQUESTED", update_time: applied - 30 });
    await worker.runJob(returnPullJob, { storeId }, tenantId);
    expect((await c.get(`/v1/returns/${r!.id}`)).body).toMatchObject({
      status: "accepted",
      externalStatus: "ACCEPTED",
    });

    // the buyer ships the parcel back: the next poll sees its tracking number
    ret.status = "ACCEPTED";
    ret.tracking_number = "SPXID-RETUR-1";
    ret.update_time = applied;
    await worker.runJob(returnPullJob, { storeId }, tenantId);
    now = (await c.get(`/v1/returns/${r!.id}`)).body;
    expect(now).toMatchObject({ status: "in_transit", returnTrackingNumber: "SPXID-RETUR-1" });

    // received: one unit as good as new, one damaged
    const bad = await c.post(`/v1/returns/${r!.id}/receive`, {
      items: [{ returnItemId: now.items[0].id, sellable: 1, damaged: 0, missing: 0 }],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([
      { path: "items.0", message: "Jumlah layak jual, rusak, dan tidak diterima harus 2." },
    ]);
    const received = await c.post(`/v1/returns/${r!.id}/receive`, {
      note: "Satu kaos sobek",
      items: [{ returnItemId: now.items[0].id, sellable: 1, damaged: 1, missing: 0 }],
    });
    expect(received.status).toBe(200);
    expect(received.body).toMatchObject({
      receivedWarehouseId: warehouseId,
      receiptNote: "Satu kaos sobek",
      items: [{ sellableQty: 1, damagedQty: 1, missingQty: 0 }],
    });
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 9, damaged: 1, available: 9 });
    const moves = (await c.get(`/v1/inventory/movements?variantId=${v["KAOS-M"]}`)).body.items as {
      id: string;
      type: string;
      onHandDelta: number;
      damagedDelta: number;
      referenceType: string;
      referenceId: string;
      note: string;
      document: unknown;
    }[];
    expect(moves.slice(0, 2)).toEqual([
      expect.objectContaining({
        type: "return_quarantine",
        onHandDelta: 0,
        damagedDelta: 1,
        referenceType: "return_item",
        referenceId: now.items[0].id,
        note: `Retur pesanan ${o.order_sn}`,
        document: { type: "return", id: r!.id, number: o.order_sn },
      }),
      expect.objectContaining({
        type: "return_restock",
        onHandDelta: 1,
        damagedDelta: 0,
        referenceId: now.items[0].id,
      }),
    ]);
    // the stock card names the return only to those who see its store
    const history = worker.ctx.get(StockHistoryService);
    const otherStore = { ...userCtx(tenantId), storeScope: new Set([newId()]) };
    expect(await history.documentsOf(otherStore, moves.slice(0, 1))).toEqual(new Map());
    const after = await orderBy(c, o.order_sn);
    expect(after.status).toBe("returned");
    expect(after.items[0]).toMatchObject({ returnedQty: 2 });
    expect(after.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(["return_received", "status_changed"]),
    );
    expect((await c.post(`/v1/returns/${r!.id}/receive`, { items: [] })).status).toBe(422);
    const again = await c.post(`/v1/returns/${r!.id}/receive`, {
      items: [{ returnItemId: now.items[0].id, sellable: 2, damaged: 0, missing: 0 }],
    });
    expect(again.body.code).toBe("return.already_received");
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 9, damaged: 1 });

    // the sellable unit reaches the marketplace
    const before = mock.callsTo("POST", "/api/v2/product/update_stock").length;
    await worker.flushStock(tenantId);
    const sent = mock
      .callsTo("POST", "/api/v2/product/update_stock")
      .slice(before)
      .map((x) => JSON.parse(x.body));
    expect(sent).toContainEqual({
      item_id: 801,
      stock_list: [{ model_id: 8011, seller_stock: [{ location_id: "IDZ", stock: 9 }] }],
    });
    expect((await c.get("/v1/returns/summary")).body).toMatchObject({ awaitingDecision: 0, toReceive: 0 });
  });

  it("disputes with the photos Shopee asks for, and keeps no contact email once sent", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 5 });
    const { shopId, storeId } = await connectShopee(c, tenantId, [kaosItem(802)]);
    const o = await shippedShopeeOrder(tenantId, shopId, 802, 1);
    const ret = shopeeReturn(o);
    mock.returns.shopee.set(shopId, [ret]);
    await worker.runJob(returnPullJob, { storeId }, tenantId);
    const [r] = await returnsOf(c);

    expect(
      (await c.post(`/v1/returns/${r!.id}/evidence`, { content: Buffer.from("bukan foto").toString("base64") })).body,
    ).toMatchObject({ code: "validation.failed", errors: [{ path: "content" }] });
    const photo = await c.post(`/v1/returns/${r!.id}/evidence`, { content: JPEG });
    expect(photo.status).toBe(201);
    expect(photo.body).toMatchObject({ contentType: "image/jpeg", size: 16 });

    const incomplete = await c.post(`/v1/returns/${r!.id}/reject`, { reason: "47" });
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.errors).toEqual([
      { path: "email", message: "Email kontak wajib untuk sanggahan ke marketplace." },
      { path: "evidence", message: "Foto wajib: Foto atau video membuka paket retur dengan resi.." },
    ]);
    const rejected = await c.post(`/v1/returns/${r!.id}/reject`, {
      reason: "47",
      comment: "Kaos yang kembali bukan dari toko kami",
      email: "gudang@tokoku.id",
      evidence: [{ fileId: photo.body.fileId, module: 1 }],
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.response).toMatchObject({
      decision: "dispute",
      action: "reject",
      reason: "47",
      reasonLabel: "Barang retur diterima dalam keadaan rusak fisik",
      status: "pending",
    });
    await drain(tenantId);

    const convert = mock.callsTo("POST", "/api/v2/returns/convert_image");
    expect(convert).toHaveLength(1);
    expect(convert[0]!.form!.get("return_sn")).toBe(ret.return_sn);
    expect(mock.returns.disputes).toEqual([
      {
        return_sn: ret.return_sn,
        email: "gudang@tokoku.id",
        dispute_reason_id: 47,
        dispute_text_reason: "Kaos yang kembali bukan dari toko kami",
        image_list: [
          {
            module_index: 1,
            requirement: "Foto atau video membuka paket retur dengan resi.",
            image_url: [...mock.returns.shopeeProofs],
          },
        ],
      },
    ]);
    const now = (await c.get(`/v1/returns/${r!.id}`)).body;
    expect(now).toMatchObject({ status: "disputed", externalStatus: "SELLER_DISPUTE", response: { status: "sent" } });
    const kept = await h.system.db.execute<{ email: string | null; decision: string }>(
      sql`SELECT response->>'email' AS email, decision FROM return_request WHERE id = ${r!.id}`,
    );
    expect(kept.rows[0]).toEqual({ email: null, decision: "dispute" });
  });

  it("answers a buyer's cancellation request; rejected, the order goes on with its stock", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 5 });
    const { shopId } = await connectShopee(c, tenantId, [kaosItem(803)]);
    const o = shopeeOrder(803, 1);
    mock.shopeeShops.get(shopId)!.orders!.push(o);
    await pushShopeeOrder(tenantId, shopId, o);
    o.buyer_cancel_reason = "Ingin mengubah alamat";
    await moveShopee(tenantId, shopId, o, "IN_CANCEL");

    const [r] = await returnsOf(c, "?group=cancellations");
    expect(r).toMatchObject({
      kind: "cancellation",
      status: "requested",
      externalReturnId: o.order_sn,
      reason: "Ingin mengubah alamat",
      respondByAt: null,
      goodsReturn: false,
      awaitingDecision: true,
      items: [{ qty: 1 }],
    });
    expect(r!.decisions!.map((d) => d.code)).toEqual(["ACCEPT", "REJECT"]);
    expect((await c.get("/v1/returns/summary")).body).toMatchObject({ cancellations: 1, toReceive: 0 });
    // nothing to receive for a cancellation
    expect((await c.post(`/v1/returns/${r!.id}/receive`, { items: [] })).status).toBe(422);
    expect(
      (
        await c.post(`/v1/returns/${r!.id}/receive`, {
          items: [{ returnItemId: r!.items[0]!.id, sellable: 1, damaged: 0, missing: 0 }],
        })
      ).body.code,
    ).toBe("return.no_goods");

    // Shopee takes the rejection but has not moved the order yet: answered, no longer waiting
    mock.failNext("POST", "/api/v2/order/handle_buyer_cancellation", 200, {
      error: "",
      message: "",
      response: { update_time: nowSec() },
    });
    expect((await c.post(`/v1/returns/${r!.id}/reject`, {})).status).toBe(200);
    await drain(tenantId);
    expect(JSON.parse(mock.callsTo("POST", "/api/v2/order/handle_buyer_cancellation").at(-1)!.body)).toEqual({
      order_sn: o.order_sn,
      operation: "REJECT",
    });
    expect((await c.get(`/v1/returns/${r!.id}`)).body).toMatchObject({
      status: "requested",
      externalStatus: "IN_CANCEL",
      awaitingDecision: false,
      response: { decision: "REJECT", status: "sent" },
    });
    expect((await c.get("/v1/returns/summary")).body).toMatchObject({ awaitingDecision: 0 });
    expect(await returnsOf(c, "?awaitingDecision=true")).toEqual([]);
    // the order goes on at Shopee; its push ends the request
    await moveShopee(tenantId, shopId, o, "READY_TO_SHIP");
    expect((await c.get(`/v1/returns/${r!.id}`)).body).toMatchObject({
      status: "closed",
      externalStatus: "READY_TO_SHIP",
      awaitingDecision: false,
    });
    expect(await orderBy(c, o.order_sn)).toMatchObject({ status: "new", cancelRequested: false });
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 5, reserved: 1 });
  });

  it("expects the parcel of an order cancelled after shipping (RTO) and puts what comes back in stock", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 10 });
    const { shopId } = await connectShopee(c, tenantId, [kaosItem(804)]);
    const o = await shippedShopeeOrder(tenantId, shopId, 804, 3);
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 7 });
    // the courier could not deliver (a COD parcel refused): Shopee cancels the order
    o.cancel_by = "system";
    o.cancel_reason = "FAILED_DELIVERY";
    await moveShopee(tenantId, shopId, o, "CANCELLED");
    const order = await orderBy(c, o.order_sn);
    expect(order.status).toBe("cancelled");

    const [r] = await returnsOf(c, "?group=rto");
    expect(r).toMatchObject({
      kind: "rto",
      status: "in_transit",
      externalReturnId: null,
      reason: "FAILED_DELIVERY",
      warehouseId,
      goodsReturn: true,
      awaitingDecision: false,
      decisions: null,
      items: [{ orderItemId: order.items[0].id, qty: 3 }],
    });
    expect((await c.post(`/v1/returns/${r!.id}/accept`, {})).body.code).toBe("return.not_marketplace");
    expect((await c.post(`/v1/returns/${r!.id}/refresh`, {})).body.code).toBe("return.not_marketplace");
    await worker.runJob(returnNewNoticeJob, { slot: "rto" }, tenantId);
    expect(await notices(c, "return.parcel_back")).toMatchObject([{ title: "1 paket akan kembali ke gudang" }]);
    // a second cancellation event changes nothing
    expect((await returnsOf(c, "?group=rto")).length).toBe(1);

    const received = await c.post(`/v1/returns/${r!.id}/receive`, {
      items: [{ returnItemId: r!.items[0]!.id, sellable: 2, damaged: 0, missing: 1 }],
    });
    expect(received.status).toBe(200);
    expect(received.body).toMatchObject({ status: "closed" });
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 9, damaged: 0 });
    const after = await orderBy(c, o.order_sn);
    expect(after).toMatchObject({ status: "cancelled" });
    expect(after.items[0]).toMatchObject({ shippedQty: 3, returnedQty: 2 });
    expect((await c.get(`/v1/inventory/movements?variantId=${v["KAOS-M"]}`)).body.items[0]).toMatchObject({
      type: "return_restock",
      onHandDelta: 2,
      note: `Paket kembali pesanan ${o.order_sn}`,
    });
  });
});

describe("a burst of returns", () => {
  it("reads the store's returns once for many orders entering TO_RETURN, and every decision in follow-up jobs", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 100 });
    const { shopId, storeId, shop } = await connectShopee(c, tenantId, [kaosItem(806)]);
    // 55 delivered orders from before, imported as they are
    const orders = Array.from({ length: 55 }, () => shopeeOrder(806, 1, { order_status: "COMPLETED" }));
    shop.orders!.push(...orders);
    await worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId);
    await drain(tenantId);

    mock.returns.shopee.set(
      shopId,
      orders.map((o) => shopeeReturn(o)),
    );
    for (const o of orders) {
      o.order_status = "TO_RETURN";
      o.update_time = nowSec() - 1;
    }
    const lists = mock.callsTo("GET", "/api/v2/returns/get_return_list").length;
    const reasons = mock.callsTo("GET", "/api/v2/returns/get_return_dispute_reason").length;
    await worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId);
    const ran = await drain(tenantId);
    expect(ran.filter((j) => j === "return.pull")).toHaveLength(55);
    // one read of the store's requests; the other 54 asks were covered by it
    expect(mock.callsTo("GET", "/api/v2/returns/get_return_list").length - lists).toBe(1);
    expect(ran.filter((j) => j === "return.details")).toHaveLength(1);
    const all = await returnsOf(c, "?awaitingDecision=true&limit=100");
    expect(all).toHaveLength(55);
    expect(all.every((r) => r.decisions?.length === 2)).toBe(true);
    expect(mock.callsTo("GET", "/api/v2/returns/get_return_dispute_reason").length - reasons).toBe(55);

    // two jobs never read the same requests: a claim holds them, and is taken over after five minutes
    await h.system.db.execute(
      sql`UPDATE return_request SET decisions_for = NULL, decisions_claimed_at = NULL WHERE store_id = ${storeId}`,
    );
    const repo = worker.ctx.get(ReturnsRepository);
    const claim = (at: Date) =>
      withTenantTx(h.worker, userCtx(tenantId), (tx) =>
        repo.claimStaleDecisions(tx, storeId, 50, at, new Date(at.getTime() - 5 * 60_000)),
      );
    const at = new Date();
    expect((await claim(at)).length).toBe(50);
    expect((await claim(at)).length).toBe(5);
    expect((await claim(at)).length).toBe(0);
    expect((await claim(new Date(at.getTime() + 5 * 60_000 + 1000))).length).toBe(50);
  });
});

describe("returns from Tokopedia & Shop (FR-RET-01, 02, 03)", () => {
  const SKU = "1729592969712209401";
  let shopIdSeq = 7_495_000_000_000_009_400n;

  async function connectTiktok(c: Client, tenantId: string, orders: MockTiktokOrder[], cipher: string) {
    const shopId = String(++shopIdSeq);
    const products: MockTiktokProduct[] = [
      {
        id: "1729592969712209400",
        title: "Kaos",
        status: "ACTIVATE",
        update_time: 1_700_000_000,
        skus: [{ id: SKU, seller_sku: "KAOS-M", price: 50_000, attrs: {}, inventory: { "7100000000000009401": 3 } }],
      },
    ];
    const sellerId = mock.addTiktokSeller({
      openId: `70100000000000${shopId.slice(-5)}`,
      name: "Toko Shop",
      shops: [
        {
          id: shopId,
          name: "Toko Shop",
          region: "ID",
          cipher,
          warehouses: [{ id: "7100000000000009401", name: "Gudang", type: "SALES_WAREHOUSE", is_default: true }],
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
    const storeId = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body.result.stores[0]
      .storeId as string;
    expect((await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" })).status).toBe(200);
    await drain(tenantId);
    return { shopId, storeId };
  }

  const tiktokOrder = (id: string, units: number, extra: Partial<MockTiktokOrder> = {}): MockTiktokOrder => {
    const t = nowSec();
    return {
      id,
      status: "AWAITING_SHIPMENT",
      create_time: t - 600,
      update_time: t - 500,
      paid_time: t - 550,
      rts_sla_time: t + 86_400,
      commerce_platform: "TOKOPEDIA",
      fulfillment_type: "FULFILLMENT_BY_SELLER",
      warehouse_id: "7100000000000009401",
      user_id: "7021436810468239401",
      recipient_address: { name: "Budi", phone_number: "(+62)812****", full_address: "Jl. Melati 2" },
      payment: { currency: "IDR", sub_total: String(units * 45_000), total_amount: String(units * 45_000) },
      line_items: Array.from({ length: units }, (_, i) => ({
        id: `${id}${i}`,
        sku_id: SKU,
        product_id: "1729592969712209400",
        seller_sku: "KAOS-M",
        product_name: "Kaos",
        sku_name: "M",
        sale_price: "45000",
        original_price: "50000",
      })),
      ...extra,
    };
  };

  async function pushTiktok(tenantId: string, shopId: string, type: number, data: object) {
    const id = String(++notificationSeq);
    const raw = JSON.stringify({ type, tts_notification_id: id, shop_id: shopId, timestamp: nowSec(), data });
    const res = await request(hooks.getHttpServer())
      .post("/webhooks/tiktokshop")
      .set("content-type", "application/json")
      .set("authorization", mock.signTiktokWebhook(raw))
      .send(raw);
    expect(res.status).toBe(200);
    await processInbox(tenantId, shopId);
  }

  it("follows a return from its webhook through approval, the buyer's parcel, and a rejection of what came back", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 10 });
    const orders: MockTiktokOrder[] = [];
    const cipher = "ROW_returns_a";
    const { shopId, storeId } = await connectTiktok(c, tenantId, orders, cipher);
    const o = tiktokOrder("576486316948499401", 2);
    orders.push(o);
    await worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId);
    o.status = "DELIVERED";
    o.update_time = nowSec() - 2;
    await worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId);
    await drain(tenantId);
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 8, reserved: 0 });

    const t = nowSec();
    const ret: MockTiktokReturn = {
      return_id: "4035318504086609401",
      order_id: o.id,
      return_type: "RETURN_AND_REFUND",
      return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
      role: "BUYER",
      return_reason: "ecom_order_delivered_refund_and_return_reason_wrong_size",
      return_reason_text: "Ukuran tidak sesuai",
      create_time: t - 30,
      update_time: t - 30,
      seller_next_action_response: [{ action: "SELLER_RESPOND_RETURN", deadline: t + 2 * 86_400 }],
      return_line_items: [
        {
          return_line_item_id: "1",
          sku_id: SKU,
          seller_sku: "KAOS-M",
          product_name: "Kaos",
          refund_amount: { currency: "IDR", refund_total: "45000" },
        },
        {
          return_line_item_id: "2",
          sku_id: SKU,
          seller_sku: "KAOS-M",
          product_name: "Kaos",
          refund_amount: { currency: "IDR", refund_total: "45000" },
        },
      ],
      refund_amount: { currency: "IDR", refund_total: "90000" },
      records: [{ role: "BUYER", images: [{ url: "https://p16.ibyteimg.com/bukti.jpeg" }] }],
    };
    mock.returns.tiktokReturns.set(cipher, [ret]);
    await pushTiktok(tenantId, shopId, 12, {
      order_id: o.id,
      return_id: ret.return_id,
      return_status: ret.return_status,
      return_type: ret.return_type,
      return_role: "BUYER",
      update_time: t - 30,
    });

    const [r] = await returnsOf(c);
    expect(r).toMatchObject({
      kind: "return_refund",
      status: "requested",
      externalReturnId: ret.return_id,
      store: { channelName: "Tokopedia & Shop" },
      refundAmount: 90_000,
      respondByAt: new Date((t + 2 * 86_400) * 1000).toISOString(),
      sellerAction: "SELLER_RESPOND_RETURN",
      awaitingDecision: true,
      evidence: [{ type: "image", url: "https://p16.ibyteimg.com/bukti.jpeg", by: "buyer" }],
      items: [{ qty: 2, sku: "KAOS-M", refundAmount: 90_000 }],
    });
    expect(r!.decisions!.map((d) => d.code)).toEqual(["APPROVE_RETURN", "DIRECT_REFUND", "REJECT_RETURN"]);

    // two ways to accept: the seller must say which
    const unclear = await c.post(`/v1/returns/${r!.id}/accept`, {});
    expect(unclear.body.errors).toEqual([
      { path: "decision", message: "Pilih keputusan: APPROVE_RETURN, DIRECT_REFUND." },
    ]);
    expect((await c.post(`/v1/returns/${r!.id}/accept`, { decision: "APPROVE_REFUND" })).body.errors).toEqual([
      { path: "decision", message: "Keputusan ini tidak tersedia untuk pengajuan ini sekarang." },
    ]);
    expect((await c.post(`/v1/returns/${r!.id}/accept`, { decision: "APPROVE_RETURN" })).status).toBe(200);
    await drain(tenantId);
    const approve = mock.calls.find((x) => x.path === `/return_refund/202309/returns/${ret.return_id}/approve`)!;
    expect(approve.query.idempotency_key).toBe(`${r!.id}-1`);
    expect(JSON.parse(approve.body)).toEqual({ decision: "APPROVE_RETURN" });
    let now = (await c.get(`/v1/returns/${r!.id}`)).body;
    expect(now).toMatchObject({
      status: "accepted",
      externalStatus: "AWAITING_BUYER_SHIP",
      awaitingDecision: false,
      decisions: [],
      response: { decision: "APPROVE_RETURN", status: "sent" },
    });
    // the same decision's job again sends nothing
    const calls = mock.calls.length;
    await worker.runJob(returnRespondJob, { returnRequestId: r!.id, attempt: 1 }, tenantId);
    expect(mock.calls.length).toBe(calls);

    // the buyer ships it back; TikTok Shop waits for the seller to check the parcel
    ret.return_status = "BUYER_SHIPPED_ITEM";
    ret.return_tracking_number = "JX-RETUR-9401";
    ret.seller_next_action_response = [{ action: "SELLER_RESPOND_RECEIVE_PACKAGE", deadline: nowSec() + 86_400 }];
    ret.update_time += 1;
    // TikTok Shop does not answer what the seller may decide this time
    mock.failNext("GET", "/return_refund/202601/decision_eligibility", 500, {
      code: 36009003,
      message: "Internal error. Please try again.",
      data: {},
    });
    await pushTiktok(tenantId, shopId, 12, {
      order_id: o.id,
      return_id: ret.return_id,
      return_status: ret.return_status,
    });
    now = (await c.get(`/v1/returns/${r!.id}`)).body;
    expect(now).toMatchObject({
      status: "in_transit",
      returnTrackingNumber: "JX-RETUR-9401",
      awaitingDecision: true,
      decisions: null,
    });
    // a deadline running counts as waiting, in the tab and its counter too
    expect((await returnsOf(c, "?awaitingDecision=true")).map((x) => x.id)).toEqual([r!.id]);
    expect((await c.get("/v1/returns/summary")).body).toMatchObject({ awaitingDecision: 1, dueSoon: 0 });
    expect((await c.post(`/v1/returns/${r!.id}/accept`, {})).body.code).toBe("return.decisions_stale");
    expect((await c.post(`/v1/returns/${r!.id}/refresh`, {})).status).toBe(202);
    await drain(tenantId);
    now = (await c.get(`/v1/returns/${r!.id}`)).body;
    expect(now.decisions.map((d: { code: string }) => d.code)).toEqual([
      "APPROVE_RECEIVED_PACKAGE",
      "REJECT_RECEIVED_PACKAGE",
    ]);

    const received = await c.post(`/v1/returns/${r!.id}/receive`, {
      items: [{ returnItemId: now.items[0].id, sellable: 1, damaged: 1, missing: 0 }],
    });
    expect(received.status).toBe(200);
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 9, damaged: 1 });
    // TikTok Shop has no return status for orders: the order stays as it was, its units counted back
    expect((await orderBy(c, o.id)).items[0]).toMatchObject({ returnedQty: 2 });

    const photo = await c.post(`/v1/returns/${r!.id}/evidence`, { content: JPEG });
    const rejected = await c.post(`/v1/returns/${r!.id}/reject`, {
      reason: "seller_reject_receive_package_damaged",
      comment: "Satu kaos kembali rusak",
      evidence: [{ fileId: photo.body.fileId }],
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.response).toMatchObject({
      decision: "REJECT_RECEIVED_PACKAGE",
      reasonLabel: "Barang retur rusak",
    });
    await drain(tenantId);
    const upload = mock.callsTo("POST", "/product/202309/images/upload").at(-1)!;
    expect(upload.form!.get("use_case")).toBe("DESCRIPTION_IMAGE");
    const [uri] = [...mock.products.tiktokImages.keys()].slice(-1);
    expect(mock.returns.rejections).toEqual([
      {
        decision: "REJECT_RECEIVED_PACKAGE",
        reject_reason: "seller_reject_receive_package_damaged",
        comment: "Satu kaos kembali rusak",
        images: [{ image_id: uri, mime_type: "image/jpeg", width: 600, height: 600 }],
      },
    ]);
    const reject = mock.calls.find((x) => x.path === `/return_refund/202606/returns/${ret.return_id}/reject`)!;
    expect(reject.query.idempotency_key).toBe(`${r!.id}-2`);
    expect((await c.get(`/v1/returns/${r!.id}`)).body).toMatchObject({
      status: "rejected",
      externalStatus: "REJECT_RECEIVE_PACKAGE",
      response: { status: "sent" },
    });

    // an order a TikTok Shop warehouse fulfilled: its goods go back to that warehouse, not the seller's
    const fbt = tiktokOrder("576486316948499405", 1, {
      status: "DELIVERED",
      fulfillment_type: "FULFILLMENT_BY_TIKTOK",
      update_time: nowSec() - 2,
    });
    orders.push(fbt);
    await worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId);
    await drain(tenantId);
    const fbtReturn: MockTiktokReturn = {
      ...ret,
      return_id: "4035318504086609405",
      order_id: fbt.id,
      return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
      return_line_items: ret.return_line_items.slice(0, 1),
      update_time: nowSec(),
    };
    mock.returns.tiktokReturns.get(cipher)!.push(fbtReturn);
    await pushTiktok(tenantId, shopId, 12, { order_id: fbt.id, return_id: fbtReturn.return_id });
    const viaFbt = (await returnsOf(c)).find((x) => x.externalReturnId === fbtReturn.return_id)!;
    expect(viaFbt).toMatchObject({ kind: "return_refund", goodsReturn: false });
    expect((await c.post(`/v1/returns/${viaFbt.id}/receive`, { items: [] })).status).toBe(422);
    expect(
      (
        await c.post(`/v1/returns/${viaFbt.id}/receive`, {
          items: [{ returnItemId: viaFbt.items[0]!.id, sellable: 1, damaged: 0, missing: 0 }],
        })
      ).body.code,
    ).toBe("return.no_goods");
  });

  it("accepts a buyer's cancellation request; the order is cancelled and its stock released", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 4 });
    const orders: MockTiktokOrder[] = [];
    const cipher = "ROW_returns_b";
    const { shopId, storeId } = await connectTiktok(c, tenantId, orders, cipher);
    const o = tiktokOrder("576486316948499402", 1);
    orders.push(o);
    await worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId);
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ reserved: 1 });

    const t = nowSec();
    const cancel: MockTiktokCancellation = {
      cancel_id: "4035400000000009402",
      order_id: o.id,
      cancel_type: "BUYER_CANCEL",
      cancel_status: "CANCELLATION_REQUEST_PENDING",
      role: "BUYER",
      cancel_reason: "ecom_order_to_ship_canceled_reason_created_by_mistakes",
      cancel_reason_text: "Pesanan dibuat tidak sengaja",
      create_time: t - 5,
      update_time: t - 5,
      seller_next_action_response: [{ action: "SELLER_RESPOND_CANCEL", deadline: t + 86_400 }],
      cancel_line_items: [{ cancel_line_item_id: "1", sku_id: SKU, seller_sku: "KAOS-M", product_name: "Kaos" }],
      refund_amount: { currency: "IDR", refund_total: "45000" },
    };
    // another buyer asked and withdrew before OmniSeller read the request: nothing to answer
    const withdrawn = tiktokOrder("576486316948499403", 1, { is_buyer_request_cancel: true, update_time: t - 2 });
    orders.push(withdrawn);
    mock.returns.tiktokCancellations.set(cipher, [
      cancel,
      {
        ...cancel,
        cancel_id: "4035400000000009403",
        order_id: withdrawn.id,
        cancel_status: "CANCELLATION_REQUEST_CANCEL",
      },
      // a seller's own cancellation of another order is no request to answer
      { ...cancel, cancel_id: "4035400000000009409", order_id: "576486316948499409", cancel_type: "CANCEL" },
    ]);
    o.is_buyer_request_cancel = true;
    o.update_time = t - 2;
    await worker.runJob(orderPullJob, { storeId, mode: "incremental" }, tenantId);
    await drain(tenantId);

    const [r] = await returnsOf(c, "?group=cancellations");
    expect(r).toMatchObject({
      kind: "cancellation",
      externalReturnId: cancel.cancel_id,
      status: "requested",
      reason: "Pesanan dibuat tidak sengaja",
      respondByAt: new Date((t + 86_400) * 1000).toISOString(),
      awaitingDecision: true,
    });
    expect(r!.decisions!.map((d) => d.code)).toEqual(["APPROVE_REQUEST_CANCEL", "REJECT_REQUEST_CANCEL"]);
    // a rejection needs a reason from TikTok Shop's list
    expect((await c.post(`/v1/returns/${r!.id}/reject`, {})).body.errors).toEqual([
      { path: "reason", message: "Pilih alasan penolakan." },
    ]);
    expect((await c.post(`/v1/returns/${r!.id}/accept`, {})).status).toBe(200);
    await drain(tenantId);
    expect(mock.returns.decisions).toContain(`tiktokshop:${cancel.cancel_id}:APPROVE_REQUEST_CANCEL`);
    expect((await c.get(`/v1/returns/${r!.id}`)).body).toMatchObject({
      status: "accepted",
      externalStatus: "CANCELLATION_REQUEST_SUCCESS",
      response: { status: "sent" },
    });
    // the order's own change arrives with its notification
    await pushTiktok(tenantId, shopId, 1, { order_id: o.id, order_status: "CANCELLED", update_time: o.update_time });
    expect(await orderBy(c, o.id)).toMatchObject({ status: "cancelled", cancelRequested: false });
    // the order whose buyer withdrew the request still holds its unit
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 4, reserved: 1 });
    expect((await returnsOf(c, "?group=cancellations")).length).toBe(1);
  });
});

describe("who answers and receives returns", () => {
  async function member(owner: Client, tenantId: string, role: string) {
    const roles = (await owner.get("/v1/roles")).body.items as { id: string; name: string }[];
    const email = uniqueEmail(role.toLowerCase());
    expect(
      (await owner.post("/v1/invitations", { email, roleId: roles.find((r) => r.name === role)!.id })).status,
    ).toBe(201);
    await drain(tenantId);
    const m = client(api);
    const accepted = await m.post("/v1/auth/invitations/accept", {
      token: tokenFrom(worker.email.lastTo(email)!.text),
      name: role,
      password: PASSWORD,
    });
    expect(accepted.status).toBe(201);
    return Object.assign(m, { userId: accepted.body.user.id as string });
  }

  it("needs return:respond to answer and return:receive to receive, refuses decisions for read-only stores, and alerts deadlines once", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, warehouseId, { [v["KAOS-M"]!]: 5 });
    const { shopId, storeId } = await connectShopee(c, tenantId, [kaosItem(805)], false);
    const o = await shippedShopeeOrder(tenantId, shopId, 805, 1);
    // the marketplace decides by itself in two hours
    const ret = shopeeReturn(o, { due_date: nowSec() + 2 * 3600 });
    mock.returns.shopee.set(shopId, [ret]);
    await worker.runJob(returnPullJob, { storeId }, tenantId);
    const [r] = await returnsOf(c);
    expect((await c.get("/v1/returns/summary")).body).toMatchObject({ awaitingDecision: 1, dueSoon: 1 });
    // stores in parallel mode are worked in the old application: nobody is told about the request
    await worker.runJob(returnNewNoticeJob, { slot: "ro" }, tenantId);
    expect(await notices(c, "return.new")).toEqual([]);

    // parallel mode: the old application answers
    expect((await c.post(`/v1/returns/${r!.id}/accept`, {})).body.code).toBe("store.read_only");
    await worker.runJob(returnDueAlertJob, { slot: "d1" }, tenantId);
    expect(await notices(c, "return.due_soon")).toEqual([]);

    expect((await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" })).status).toBe(200);
    await drain(tenantId);
    // read-only stores were alerted of nothing; the deadline counts as alerted
    await worker.runJob(returnDueAlertJob, { slot: "d2" }, tenantId);
    expect(await notices(c, "return.due_soon")).toEqual([]);
    // a new deadline is alerted, once
    ret.due_date = nowSec() + 3 * 3600;
    ret.update_time = nowSec();
    await worker.runJob(returnPullJob, { storeId }, tenantId);
    await worker.runJob(returnDueAlertJob, { slot: "d3" }, tenantId);
    await worker.runJob(returnDueAlertJob, { slot: "d4" }, tenantId);
    expect(await notices(c, "return.due_soon")).toMatchObject([
      { severity: "warning", title: "1 pengajuan harus ditanggapi" },
    ]);

    const viewer = await member(c, tenantId, "Viewer");
    expect((await returnsOf(viewer)).map((x) => x.id)).toEqual([r!.id]);
    // a member limited to another warehouse does not see the order's return
    const other = await c.post("/v1/warehouses", { code: "SBY", name: "Gudang Surabaya" });
    expect(other.status).toBe(201);
    const elsewhere = await member(c, tenantId, "Viewer");
    expect((await c.put(`/v1/users/${elsewhere.userId}/scopes`, { warehouseIds: [other.body.id] })).status).toBe(200);
    expect(await returnsOf(elsewhere)).toEqual([]);
    expect((await elsewhere.get(`/v1/returns/${r!.id}`)).status).toBe(404);
    expect((await elsewhere.get("/v1/returns/summary")).body).toMatchObject({ awaitingDecision: 0 });
    expect((await viewer.post(`/v1/returns/${r!.id}/accept`, {})).status).toBe(403);
    const gudang = await member(c, tenantId, "Gudang");
    expect((await gudang.post(`/v1/returns/${r!.id}/accept`, {})).status).toBe(403);
    expect((await gudang.post(`/v1/returns/${r!.id}/evidence`, { content: JPEG })).status).toBe(403);
    const cs = await member(c, tenantId, "CS");
    const answered = await cs.post(`/v1/returns/${r!.id}/accept`, {});
    expect(answered.status).toBe(200);
    expect(
      (
        await cs.post(`/v1/returns/${r!.id}/receive`, {
          items: [{ returnItemId: r!.items[0]!.id, sellable: 1, damaged: 0, missing: 0 }],
        })
      ).status,
    ).toBe(403);
    const byGudang = await gudang.post(`/v1/returns/${r!.id}/receive`, {
      items: [{ returnItemId: r!.items[0]!.id, sellable: 1, damaged: 0, missing: 0 }],
    });
    expect(byGudang.status).toBe(200);
    expect(await stockOf(c, "KAOS-M")).toMatchObject({ onHand: 5 });
    // who answered and who received are in the audit log
    const audit = (await c.get(`/v1/audit-logs?entity_type=return_request&entity_id=${r!.id}`)).body.items as {
      after: Record<string, unknown>;
    }[];
    expect(audit.map((a) => [a.after.response_status, a.after.received_at === null])).toEqual(
      expect.arrayContaining([["pending", true]]),
    );
    expect(JSON.stringify(audit)).not.toMatch(/Ukuran tidak sesuai|bukti-1/);
  });
});
