import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDate } from "../../src/common/time-zone";
import type { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
import { scanOrderPolls, scanWarehousePolls } from "../../src/scheduler/channel-scans";
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
 * More than one physical warehouse, manual orders, automatic allocation, and order tags end to end
 * (backend doc 8.21; PRD FR-STK-01, FR-WHS-08, 10, FR-ORD-04, 09, 12).
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 996000;
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

/** A business with its first warehouse in Jakarta and a second one in Surabaya. */
async function business() {
  const { c, me } = await signup(api);
  const jakarta = (await c.get("/v1/warehouses")).body.items[0].id as string;
  expect(
    (await c.patch(`/v1/warehouses/${jakarta}`, { address: { city: "Jakarta Barat", province: "DKI Jakarta" } }))
      .status,
  ).toBe(200);
  const sby = await c.post("/v1/warehouses", {
    code: "sby",
    name: "Gudang Surabaya",
    address: {
      contactName: "Budi",
      phone: "081234567890",
      line1: "Jl. Raya Darmo 5",
      city: "Surabaya",
      province: "jatim",
      postalCode: "60241",
    },
  });
  expect(sby.status).toBe(201);
  return { c, me, tenantId: me.tenant.id, jakarta, surabaya: sby.body.id as string };
}

async function product(c: Client, sku: string, variantSkus: string[]) {
  const res = await c.post("/v1/products", {
    sku,
    name: `Produk ${sku}`,
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

async function setStock(c: Client, warehouseId: string, lines: Record<string, number>) {
  const res = await c.post("/v1/inventory/adjustments", {
    lines: Object.entries(lines).map(([variantId, quantity]) => ({ variantId, warehouseId, mode: "set", quantity })),
    reason: "correction",
  });
  expect(res.status).toBe(200);
}

/** On hand and reserved of a SKU in one warehouse. */
async function stockAt(c: Client, sku: string, warehouseId: string) {
  const rows = (await c.get(`/v1/inventory?q=${sku}`)).body.items[0].warehouses as {
    warehouseId: string;
    onHand: number;
    reserved: number;
  }[];
  const row = rows.find((r) => r.warehouseId === warehouseId);
  return { onHand: row?.onHand ?? 0, reserved: row?.reserved ?? 0 };
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
  return { c: member, id: accepted.body.user.id as string };
}

const inbox = async (c: Client) =>
  (await c.get("/v1/notifications")).body.items as { kind: string; title: string; body: string; severity: string }[];

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

async function connectShopee(
  c: Client,
  tenantId: string,
  items: MockShopeeItem[],
  warehouses: "not_whitelisted" | { warehouse_id: number; warehouse_name: string; location_id: string }[],
) {
  const shopId = String(++shopSeq);
  const orders: MockShopeeOrder[] = [];
  const shop = { shopId, name: `Toko ${shopId}`, region: "ID", warehouses, items, orders };
  mock.addShopeeShop(shop);
  const started = await c.post("/v1/store-authorizations", { channel: "shopee" });
  await c.post("/v1/store-authorizations/callback", {
    channel: "shopee",
    state: new URL(started.body.authorizeUrl).searchParams.get("state"),
    code: mock.shopeeCode({ shopId }),
    shopId,
  });
  await drain(tenantId);
  const storeId = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body.result.stores[0].storeId as string;
  return { shopId, storeId, orders, shop, name: shop.name };
}

function order(
  itemId: number,
  lines: { model: number; sku: string; qty: number; location?: string }[],
  province: string,
): MockShopeeOrder {
  const t = nowSec() - 120;
  return {
    order_sn: `2610110${String(snSeq++).padStart(6, "0")}`,
    order_status: "READY_TO_SHIP",
    create_time: t,
    update_time: nowSec() - 5,
    pay_time: t + 30,
    ship_by_date: t + 3 * 86_400,
    total_amount: lines.reduce((n, l) => n + l.qty * 45_000, 0),
    buyer_user_id: 7000 + snSeq,
    buyer_username: "dewi",
    shipping_carrier: "SPX Standard",
    recipient_address: {
      name: "Dewi",
      phone: "6281200000",
      city: "Kota",
      state: province,
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
      ...(l.location ? { product_location_id: l.location } : {}),
    })),
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

async function orderBy(c: Client, externalOrderId: string) {
  const list = (await c.get(`/v1/orders?q=${externalOrderId}`)).body.items as { id: string; externalOrderId: string }[];
  const found = list.find((o) => o.externalOrderId === externalOrderId);
  expect(found, `order ${externalOrderId}`).toBeDefined();
  return (await c.get(`/v1/orders/${found!.id}`)).body;
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
  return PDFDocument.load(res.body as Buffer);
}

describe("more than one physical warehouse (FR-STK-01)", () => {
  it("adds, changes, and makes warehouses the default, and deletes only one nothing depends on", async () => {
    const { c, tenantId, jakarta, surabaya } = await business();
    const sby = (await c.get(`/v1/warehouses/${surabaya}`)).body;
    expect(sby).toMatchObject({
      code: "SBY",
      name: "Gudang Surabaya",
      isDefault: false,
      active: true,
      // the province is kept under its canonical name: nearest-warehouse allocation reads it
      address: { contactName: "Budi", province: "Jawa Timur", postalCode: "60241" },
    });
    expect((await c.post("/v1/warehouses", { code: "SBY", name: "Lagi" })).body.code).toBe("warehouse.code_taken");
    expect((await c.post("/v1/warehouses", { code: "x", name: "Kode pendek" })).status).toBe(422);
    expect((await c.get("/v1/warehouses")).body.items.map((w: { code: string }) => w.code)).toEqual(["UTAMA", "SBY"]);

    // optimistic locking
    const etag = (await c.get(`/v1/warehouses/${surabaya}`)).headers.etag as string;
    expect((await c.patch(`/v1/warehouses/${surabaya}`, { name: "Gudang SBY" }).set("If-Match", etag)).status).toBe(
      200,
    );
    expect((await c.patch(`/v1/warehouses/${surabaya}`, { name: "Basi" }).set("If-Match", etag)).body.code).toBe(
      "row.stale",
    );

    // the default moves; the default cannot be deleted
    expect((await c.post(`/v1/warehouses/${surabaya}/default`)).body).toMatchObject({ isDefault: true });
    expect((await c.get(`/v1/warehouses/${jakarta}`)).body.isDefault).toBe(false);
    expect((await c.delete(`/v1/warehouses/${surabaya}`)).body.code).toBe("warehouse.is_default");
    await c.post(`/v1/warehouses/${jakarta}/default`);

    // stock, a store's default, and open orders keep a warehouse
    const v = await product(c, "GDG", ["GDG-1"]);
    await setStock(c, surabaya, { [v["GDG-1"]!]: 4 });
    expect((await c.delete(`/v1/warehouses/${surabaya}`)).body).toMatchObject({ code: "warehouse.has_stock" });
    await setStock(c, surabaya, { [v["GDG-1"]!]: 0 });
    const channel = await c.post("/v1/stores/manual", { name: "WhatsApp Surabaya", defaultWarehouseId: surabaya });
    expect(channel.status).toBe(201);
    const inUse = (await c.delete(`/v1/warehouses/${surabaya}`)).body;
    expect(inUse).toMatchObject({ code: "warehouse.in_use" });
    expect(inUse.detail).toContain("WhatsApp Surabaya");
    await c.patch(`/v1/stores/${channel.body.id}`, { defaultWarehouseId: jakarta });
    const placed = await c.post("/v1/orders/manual", {
      storeId: channel.body.id,
      warehouseId: surabaya,
      buyer: { name: "Sari", phone: "081300000001" },
      items: [{ variantId: v["GDG-1"], qty: 1 }],
      paymentMethod: "cash",
    });
    expect(placed.status).toBe(201);
    expect((await c.delete(`/v1/warehouses/${surabaya}`)).body).toMatchObject({ code: "warehouse.has_orders" });
    await c.post(`/v1/orders/${placed.body.id}/cancel`, { reason: "buyer_request" });

    expect((await c.delete(`/v1/warehouses/${surabaya}`)).status).toBe(204);
    expect((await c.get(`/v1/warehouses/${surabaya}`)).status).toBe(404);
    expect((await c.get("/v1/warehouses")).body.items.map((w: { code: string }) => w.code)).toEqual(["UTAMA"]);
    // codes stay taken: exports and stock cards keep naming the old warehouse
    expect((await c.post("/v1/warehouses", { code: "SBY", name: "Baru" })).body.code).toBe("warehouse.code_taken");

    // every change is audited
    const audit = (await c.get(`/v1/audit-logs?entity_type=warehouse&entity_id=${surabaya}`)).body.items as {
      action: string;
    }[];
    expect(audit.length).toBeGreaterThanOrEqual(4);

    // staff without settings:warehouse cannot add one; staff limited to a warehouse do not see the others
    const cs = await addMember(c, tenantId, "CS");
    expect((await cs.c.post("/v1/warehouses", { code: "CS", name: "Gudang CS" })).status).toBe(403);
    const pusat = await c.post("/v1/warehouses", { code: "PST", name: "Gudang Pusat" });
    const gudang = await addMember(c, tenantId, "Gudang");
    expect((await c.put(`/v1/users/${gudang.id}/scopes`, { warehouseIds: [jakarta] })).status).toBe(200);
    const seen = (await gudang.c.get("/v1/warehouses")).body.items.map((w: { id: string }) => w.id);
    expect(seen).toEqual([jakarta]);
    expect((await gudang.c.get(`/v1/warehouses/${pusat.body.id}`)).status).toBe(404);
  });

  it("tells the people who manage a store when its marketplace warehouses change (FR-WHS-10)", async () => {
    const { c, tenantId, jakarta, surabaya } = await business();
    const store = await connectShopee(
      c,
      tenantId,
      [item(901, ["MW-1"])],
      [
        { warehouse_id: 1, warehouse_name: "Gudang Jakarta Barat", location_id: "IDJKT" },
        { warehouse_id: 2, warehouse_name: "Gudang Sidoarjo", location_id: "IDSDA" },
      ],
    );
    // two marketplace warehouses and two physical ones: nothing is mapped automatically
    const first = (await inbox(c)).filter((n) => n.kind === "store.warehouses_changed");
    expect(first).toEqual([
      expect.objectContaining({ severity: "warning", title: `Gudang ${store.name} perlu dipetakan` }),
    ]);
    expect(first[0]!.body).toContain("Gudang Jakarta Barat, Gudang Sidoarjo");

    const cws = (await c.get(`/v1/stores/${store.storeId}/channel-warehouses`)).body.items as {
      id: string;
      externalWarehouseId: string;
    }[];
    const cw = (ext: string) => cws.find((w) => w.externalWarehouseId === ext)!.id;
    await c.put(`/v1/stores/${store.storeId}/channel-warehouses/${cw("IDJKT")}`, { warehouseId: jakarta });
    await c.put(`/v1/stores/${store.storeId}/channel-warehouses/${cw("IDSDA")}`, { warehouseId: surabaya });

    // the marketplace drops one location
    store.shop.warehouses = [{ warehouse_id: 1, warehouse_name: "Gudang Jakarta Barat", location_id: "IDJKT" }];
    expect((await c.post(`/v1/stores/${store.storeId}/warehouses/sync`)).status).toBe(202);
    await drain(tenantId);
    const notes = (await inbox(c)).filter((n) => n.kind === "store.warehouses_changed");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ severity: "info", title: `Gudang Shopee ${store.name} berubah` });
    expect(notes[0]!.body).toContain("1 gudang tidak lagi tercantum");
  });
});

describe("manual orders (FR-ORD-09) and automatic allocation (FR-ORD-12)", () => {
  it("scopes courier filters and outstanding COD to the caller's stores and warehouses (FR-ORD-03, 15)", async () => {
    const { c, tenantId, jakarta, surabaya } = await business();
    const v = await product(c, "COD", ["COD-1"]);
    await setStock(c, jakarta, { [v["COD-1"]!]: 20 });
    await setStock(c, surabaya, { [v["COD-1"]!]: 20 });
    const stores = [
      await c.post("/v1/stores/manual", { name: "WhatsApp" }),
      await c.post("/v1/stores/manual", { name: "Offline" }),
    ] as const;
    for (const store of stores) expect(store.status).toBe(201);
    const create = async (storeId: string, warehouseId: string, paymentMethod = "cod") => {
      const res = await c.post("/v1/orders/manual", {
        storeId,
        warehouseId,
        buyer: { name: "Pembeli" },
        items: [{ variantId: v["COD-1"], qty: 1 }],
        paymentMethod,
        shippingProvider: "J&T Express",
        orderedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      });
      expect(res.status).toBe(201);
      return res.body;
    };
    const jkt = await create(stores[0].body.id, jakarta);
    const sby = await create(stores[0].body.id, surabaya);
    const otherStore = await create(stores[1].body.id, jakarta);
    const completed = await create(stores[0].body.id, jakarta);
    expect((await c.post(`/v1/orders/${completed.id}/complete`)).status).toBe(200);
    const cancelled = await create(stores[0].body.id, jakarta);
    expect((await c.post(`/v1/orders/${cancelled.id}/cancel`, { reason: "other" })).status).toBe(202);
    await create(stores[0].body.id, jakarta, "cash");
    const all = (await c.get("/v1/dashboard")).body.orders.codOutstanding;
    expect(all).toEqual({ orders: 3, total: 150_000 });
    // COD is not restricted to the dashboard's sales period, even for members without finance:read.
    const gudang = await addMember(c, tenantId, "Gudang");
    expect(
      (await c.put(`/v1/users/${gudang.id}/scopes`, { warehouseIds: [jakarta], storeIds: [stores[0].body.id] })).status,
    ).toBe(200);
    const scoped = (await gudang.c.get("/v1/dashboard?range=today")).body;
    expect(scoped.grossProfit).toBeNull();
    expect(scoped.orders.codOutstanding).toEqual({ orders: 1, total: 50_000 });
    expect((await gudang.c.get("/v1/dashboard?range=30d")).body.orders.codOutstanding).toEqual(
      scoped.orders.codOutstanding,
    );
    const rows = (await gudang.c.get("/v1/orders?courier=J%26T+Express&cod=true&status=new")).body.items;
    expect(rows.map((o: { id: string }) => o.id)).toEqual([jkt.id]);
    expect(rows.map((o: { id: string }) => o.id)).not.toContain(sby.id);
    expect(rows.map((o: { id: string }) => o.id)).not.toContain(otherStore.id);
    expect((await gudang.c.get(`/v1/orders?courier=J%26T+Express&warehouseId=${surabaya}`)).body.items).toEqual([]);
    expect((await gudang.c.get(`/v1/orders?courier=J%26T+Express&storeId=${stores[1].body.id}`)).body.items).toEqual(
      [],
    );
    expect((await gudang.c.get("/v1/orders/couriers")).body.items).toEqual([{ courier: "J&T Express", orders: 4 }]);
    const stranger = await business();
    expect((await stranger.c.get("/v1/dashboard")).body.orders.codOutstanding).toEqual({ orders: 0, total: 0 });
  });

  it("takes a WhatsApp order from end to end: reserve, pay, pack, label, ship, complete", async () => {
    const { c, tenantId, jakarta, surabaya } = await business();
    const v = await product(c, "KAOS", ["KAOS-M", "KAOS-L"]);
    await setStock(c, jakarta, { [v["KAOS-M"]!]: 10, [v["KAOS-L"]!]: 1 });
    await setStock(c, surabaya, { [v["KAOS-M"]!]: 5, [v["KAOS-L"]!]: 5 });

    const body = {
      buyer: { name: "Dewi Anggraini", phone: "081298765432" },
      shippingAddress: { line1: "Jl. Kenjeran 10", city: "Surabaya", province: "JAWA TIMUR", postalCode: "60134" },
      items: [
        { variantId: v["KAOS-M"], qty: 2 },
        { variantId: v["KAOS-L"], qty: 2, unitPrice: 55_000 },
      ],
      shippingFee: 15_000,
      discount: 10_000,
      paymentMethod: "transfer",
      shippingProvider: "J&T Express",
      buyerNote: "Bungkus kado",
    };
    const created = await c.post("/v1/orders/manual", body).set("Idempotency-Key", "wa-dewi-0001");
    expect(created.status).toBe(201);
    const o = created.body;
    const period = localDate("Asia/Jakarta", new Date()).slice(2, 7).replace("-", "");
    expect(o).toMatchObject({
      externalOrderId: `MN-${period}-0001`,
      store: { channel: "manual", channelName: "Manual", name: "Pesanan Manual" },
      status: "unpaid",
      paymentMethod: "transfer",
      isCod: false,
      // Surabaya has both sizes and is in the buyer's province
      warehouseId: surabaya,
      warehouseFixed: false,
      subtotal: 210_000,
      discountTotal: 10_000,
      shippingFeeBuyer: 15_000,
      total: 215_000,
      shippingAddress: { name: "Dewi Anggraini", phone: "081298765432", province: "JAWA TIMUR" },
    });
    expect(o.items).toMatchObject([
      { sku: "KAOS-M", qty: 2, unitPrice: 50_000, lineTotal: 100_000, reservedQty: 2, warehouseId: surabaya },
      { sku: "KAOS-L", qty: 2, unitPrice: 55_000, lineTotal: 110_000, reservedQty: 2, warehouseId: surabaya },
    ]);
    expect(o.events[0]).toMatchObject({ type: "created", payload: { allocation: "nearest", source: "manual" } });
    expect(await stockAt(c, "KAOS-M", surabaya)).toEqual({ onHand: 5, reserved: 2 });

    // the same request again: the same order, not a second one
    const again = await c.post("/v1/orders/manual", body).set("Idempotency-Key", "wa-dewi-0001");
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body.id).toBe(o.id);
    const reused = await c
      .post("/v1/orders/manual", { ...body, shippingFee: 0 })
      .set("Idempotency-Key", "wa-dewi-0001");
    expect(reused.body.code).toBe("idempotency.key_reused");
    expect((await c.get("/v1/orders?channel=manual")).body.items).toHaveLength(1);

    // not shipped before it is paid; paid, it is a new order in the queue
    expect((await c.post(`/v1/orders/${o.id}/ship`, {})).body.code).toBe("order.unpaid");
    expect((await c.post(`/v1/orders/${o.id}/pay`, {})).body).toMatchObject({ status: "new" });
    expect((await c.post("/v1/orders/accept", { orderIds: [o.id] })).body.items[0].ok).toBe(true);
    expect((await c.post("/v1/orders/pack", { orderIds: [o.id] })).body.items[0].ok).toBe(true);
    // a marketplace arranges shipping; a manual order is shipped by the seller
    expect(
      (await c.post("/v1/shipments/arrange", { orderIds: [o.id], method: "dropoff" })).body.items[0],
    ).toMatchObject({
      ok: false,
      code: "order.manual",
    });

    // its label is drawn by OmniSeller, with the warehouse as sender (FR-WHS-08)
    const doc = await c.post("/v1/documents", { kind: "labels", orderIds: [o.id], format: "thermal" });
    expect(doc.status).toBe(202);
    await drain(tenantId);
    const ready = (await c.get(`/v1/documents/${doc.body.id}`)).body;
    expect(ready).toMatchObject({ status: "ready", pageCount: 1 });
    expect((await pdfOf(c, ready.downloadUrl)).getPageCount()).toBe(1);
    const picks = (await c.post("/v1/pick-lists", { orderIds: [o.id] })).body.sections;
    expect(picks).toMatchObject([{ warehouseId: surabaya, units: 4 }]);

    // shipped with the courier's tracking number: the reserved units leave Surabaya
    const shipped = await c.post(`/v1/orders/${o.id}/ship`, { trackingNumber: "JT0012345678" });
    expect(shipped.body).toMatchObject({
      status: "shipped",
      trackingNumber: "JT0012345678",
      shippingProvider: "J&T Express",
    });
    expect(await stockAt(c, "KAOS-M", surabaya)).toEqual({ onHand: 3, reserved: 0 });
    expect(await stockAt(c, "KAOS-L", surabaya)).toEqual({ onHand: 3, reserved: 0 });
    expect((await c.patch(`/v1/orders/${o.id}`, { shippingAddress: null })).body.code).toBe("order.status_invalid");
    expect((await c.patch(`/v1/orders/${o.id}`, { trackingNumber: "JT0012345679" })).body.trackingNumber).toBe(
      "JT0012345679",
    );
    const done = (await c.post(`/v1/orders/${o.id}/complete`)).body;
    expect(done).toMatchObject({ status: "completed" });
    expect(done.events.map((e: { type: string; toStatus: string | null }) => e.toStatus ?? e.type)).toEqual([
      "unpaid",
      "new",
      "ready_to_pack",
      "packed",
      "label_printed",
      "ready_to_ship",
      "shipped",
      "details_changed",
      "delivered",
      "completed",
    ]);

    // typed in by the team: no "new order" notification
    expect((await inbox(c)).filter((n) => n.kind === "order.new")).toEqual([]);
    const flagged = await h.system.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM "order" WHERE tenant_id = ${tenantId} AND notify_new`,
    );
    expect(flagged.rows[0]!.n).toBe(0);

    // the manual channel is a store of channel "manual", counted in sales like any other
    const report = (await c.get("/v1/reports/sales")).body;
    expect(report.byChannel).toEqual([
      expect.objectContaining({ channel: "manual", displayName: "Manual", orders: 1, revenue: 215_000 }),
    ]);
  });

  it("finishes a COD sale picked up at the counter, and refuses what does not fit a manual order", async () => {
    const { c, tenantId, jakarta } = await business();
    const v = await product(c, "TOPI", ["TOPI-1", "TOPI-2"]);
    await setStock(c, jakarta, { [v["TOPI-1"]!]: 10, [v["TOPI-2"]!]: 10 });
    const counter = await c.post("/v1/stores/manual", { name: "Toko Offline" });
    const sale = await c.post("/v1/orders/manual", {
      storeId: counter.body.id,
      warehouseId: jakarta,
      buyer: { name: "Pembeli Toko" },
      items: [{ variantId: v["TOPI-1"], qty: 1 }],
      paymentMethod: "cod",
    });
    expect(sale.body).toMatchObject({ status: "new", isCod: true, paidAt: null, shippingAddress: null });
    // no address: nothing to ship, it completes when the buyer takes it
    expect((await c.post(`/v1/orders/${sale.body.id}/ship`, {})).body.code).toBe("order.no_address");
    const done = (await c.post(`/v1/orders/${sale.body.id}/complete`)).body;
    expect(done).toMatchObject({ status: "completed" });
    expect(done.paidAt).not.toBeNull();
    expect(await stockAt(c, "TOPI-1", jakarta)).toEqual({ onHand: 9, reserved: 0 });

    const base = { buyer: { name: "Rudi" }, items: [{ variantId: v["TOPI-1"], qty: 1 }], paymentMethod: "cash" };
    const twice = await c.post("/v1/orders/manual", {
      ...base,
      items: [
        { variantId: v["TOPI-1"], qty: 1 },
        { variantId: v["TOPI-1"], qty: 2 },
      ],
    });
    expect(twice.status).toBe(422);
    expect((await c.post("/v1/orders/manual", { ...base, discount: 60_000 })).body.errors).toMatchObject([
      { path: "discount" },
    ]);
    expect(
      (await c.post("/v1/orders/manual", { ...base, shippingAddress: { line1: "Jl. Tanpa Telepon 1" } })).body.errors,
    ).toMatchObject([{ path: "shippingAddress.phone" }]);
    await c.patch(`/v1/products/${(await c.get("/v1/products?q=TOPI")).body.items[0].id}/variants/${v["TOPI-2"]}`, {
      status: "archived",
    });
    expect(
      (await c.post("/v1/orders/manual", { ...base, items: [{ variantId: v["TOPI-2"], qty: 1 }] })).body.errors,
    ).toMatchObject([{ path: "items.0.variantId" }]);
    expect((await c.post("/v1/orders/manual", { ...base, storeId: counter.body.id })).status).toBe(201);

    // a marketplace-only action on a manual channel is refused; CS may not take manual orders
    expect((await c.post(`/v1/stores/${counter.body.id}/warehouses/sync`)).body.code).toBe("store.manual");
    expect((await c.post("/v1/orders/sync", { storeId: counter.body.id })).body.code).toBe("store.manual");
    expect((await c.patch(`/v1/stores/${counter.body.id}`, { syncMode: "read_only" })).body.code).toBe("store.manual");
    expect((await c.post("/v1/listings/sync", { storeId: counter.body.id })).body.code).toBe("store.manual");
    expect((await c.post("/v1/stock-allocation-rules", { storeId: counter.body.id, mode: "all" })).body.code).toBe(
      "store.manual",
    );
    const cs = await addMember(c, tenantId, "CS");
    expect((await cs.c.post("/v1/orders/manual", base)).status).toBe(403);
    // a manual channel has no connection whose health could fail
    expect(((await c.get("/v1/dashboard")).body.stores as { id: string }[]).map((s) => s.id)).not.toContain(
      counter.body.id,
    );
  });

  it("moves an order short of stock to another warehouse, and cancels manual orders at once", async () => {
    const { c, jakarta, surabaya } = await business();
    const v = await product(c, "JAKET", ["JAKET-1"]);
    await setStock(c, jakarta, { [v["JAKET-1"]!]: 1 });
    await setStock(c, surabaya, { [v["JAKET-1"]!]: 6 });
    const short = await c.post("/v1/orders/manual", {
      warehouseId: jakarta,
      buyer: { name: "Andi", phone: "081311112222" },
      shippingAddress: { line1: "Jl. Sudirman 1", province: "DKI Jakarta" },
      items: [{ variantId: v["JAKET-1"], qty: 3 }],
      paymentMethod: "cash",
    });
    expect(short.body).toMatchObject({ status: "problem", problems: [{ code: "insufficient_stock" }] });
    expect(await stockAt(c, "JAKET-1", jakarta)).toEqual({ onHand: 1, reserved: 3 });

    expect((await c.put(`/v1/orders/${short.body.id}/warehouse`, { warehouseId: surabaya })).status).toBe(204);
    const moved = (await c.get(`/v1/orders/${short.body.id}`)).body;
    expect(moved).toMatchObject({
      status: "new",
      warehouseId: surabaya,
      problems: [{ resolvedAt: expect.any(String) }],
    });
    expect(moved.events.map((e: { type: string }) => e.type)).toContain("warehouse_changed");
    expect(await stockAt(c, "JAKET-1", jakarta)).toEqual({ onHand: 1, reserved: 0 });
    expect(await stockAt(c, "JAKET-1", surabaya)).toEqual({ onHand: 6, reserved: 3 });

    expect(
      (await c.get(`/v1/orders/${short.body.id}/cancel-reasons`)).body.items.map((r: { code: string }) => r.code),
    ).toEqual(["buyer_request", "out_of_stock", "unpaid", "duplicate", "other"]);
    expect((await c.post(`/v1/orders/${short.body.id}/cancel`, { reason: "ga-ada" })).status).toBe(422);
    expect((await c.post(`/v1/orders/${short.body.id}/cancel`, { reason: "buyer_request" })).status).toBe(202);
    const cancelled = (await c.get(`/v1/orders/${short.body.id}`)).body;
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancelledBy: "seller",
      cancelReason: "Pembeli membatalkan",
    });
    expect(await stockAt(c, "JAKET-1", surabaya)).toEqual({ onHand: 6, reserved: 0 });
    // a seller's cancellation is audited like a marketplace one
    const audit = (await c.get(`/v1/audit-logs?entity_type=order_event`)).body.items as {
      after: { order_id: string };
    }[];
    expect(audit.some((a) => a.after.order_id === short.body.id)).toBe(true);
    expect((await c.put(`/v1/orders/${short.body.id}/warehouse`, { warehouseId: jakarta })).body.code).toBe(
      "order.status_invalid",
    );
  });

  it("allocates marketplace orders of a store without multi-warehouse when the seller turns it on", async () => {
    const { c, tenantId, jakarta, surabaya } = await business();
    const v = await product(c, "SEPATU", ["SEPATU-1"]);
    await setStock(c, jakarta, { [v["SEPATU-1"]!]: 0 });
    await setStock(c, surabaya, { [v["SEPATU-1"]!]: 5 });
    const single = await connectShopee(c, tenantId, [item(911, ["SEPATU-1"])], "not_whitelisted");
    expect((await c.patch(`/v1/stores/${single.storeId}`, { syncMode: "live" })).status).toBe(200);
    await drain(tenantId);

    // off: the order goes to the store's mapped warehouse, where nothing is left
    const first = order(911, [{ model: 9111, sku: "SEPATU-1", qty: 1 }], "DKI Jakarta");
    single.orders.push(first);
    await push(tenantId, single.shopId, first);
    const stuck = await orderBy(c, first.order_sn);
    expect(stuck).toMatchObject({ status: "problem", warehouseId: jakarta, warehouseFixed: false });

    // on: the next order goes to the nearest warehouse that has it
    expect((await c.patch(`/v1/stores/${single.storeId}`, { autoAllocate: true })).body.autoAllocate).toBe(true);
    const second = order(911, [{ model: 9111, sku: "SEPATU-1", qty: 2 }], "JAWA TIMUR");
    single.orders.push(second);
    await push(tenantId, single.shopId, second);
    const allocated = await orderBy(c, second.order_sn);
    expect(allocated).toMatchObject({ status: "new", warehouseId: surabaya });
    expect(allocated.events[0].payload).toMatchObject({ allocation: "nearest", warehouseId: surabaya });

    // the stuck order can move too: the marketplace did not choose its warehouse
    expect((await c.put(`/v1/orders/${stuck.id}/warehouse`, { warehouseId: surabaya })).status).toBe(204);
    expect((await c.get(`/v1/orders/${stuck.id}`)).body).toMatchObject({ status: "new", warehouseId: surabaya });
    expect(await stockAt(c, "SEPATU-1", surabaya)).toEqual({ onHand: 5, reserved: 3 });

    // a multi-warehouse store's orders stay where the marketplace put them (FR-WHS-07)
    const multi = await connectShopee(
      c,
      tenantId,
      [item(912, ["SEPATU-1"])],
      [
        { warehouse_id: 1, warehouse_name: "Gudang Jakarta Barat", location_id: "IDJKT" },
        { warehouse_id: 2, warehouse_name: "Gudang Sidoarjo", location_id: "IDSDA" },
      ],
    );
    const cws = (await c.get(`/v1/stores/${multi.storeId}/channel-warehouses`)).body.items as {
      id: string;
      externalWarehouseId: string;
    }[];
    for (const [ext, wh] of [
      ["IDJKT", jakarta],
      ["IDSDA", surabaya],
    ] as const) {
      await c.put(
        `/v1/stores/${multi.storeId}/channel-warehouses/${cws.find((w) => w.externalWarehouseId === ext)!.id}`,
        {
          warehouseId: wh,
        },
      );
    }
    expect((await c.patch(`/v1/stores/${multi.storeId}`, { syncMode: "live" })).status).toBe(200);
    await drain(tenantId);
    const fixed = order(912, [{ model: 9121, sku: "SEPATU-1", qty: 1, location: "IDSDA" }], "DKI Jakarta");
    multi.orders.push(fixed);
    await push(tenantId, multi.shopId, fixed);
    const placed = await orderBy(c, fixed.order_sn);
    expect(placed).toMatchObject({ warehouseId: surabaya, warehouseFixed: true });
    expect((await c.put(`/v1/orders/${placed.id}/warehouse`, { warehouseId: jakarta })).body.code).toBe(
      "order.warehouse_fixed",
    );

    // manual channels and scans: no marketplace behind them, so no poll is ever queued for one
    const counter = await c.post("/v1/stores/manual", { name: "Instagram" });
    expect((await c.patch(`/v1/stores/${counter.body.id}`, { autoAllocate: true })).body.code).toBe("store.manual");
    const added: string[] = [];
    const queues = {
      get: () => ({ add: async (_n: string, p: { storeId: string }) => added.push(p.storeId) }),
    } as unknown as QueueRegistry;
    const registry = new JobRegistry(JOB_DEFINITIONS);
    await scanOrderPolls(h.system, queues, registry);
    await scanWarehousePolls(h.system, queues, registry);
    expect(added).toContain(single.storeId);
    expect(added).not.toContain(counter.body.id);
  });
});

describe("order tags (FR-ORD-04)", () => {
  it("keeps a list of tags, puts them on many orders, and filters the queue by tag", async () => {
    const { c, tenantId, jakarta } = await business();
    const v = await product(c, "TAS", ["TAS-1"]);
    await setStock(c, jakarta, { [v["TAS-1"]!]: 20 });
    const make = async () =>
      (
        await c.post("/v1/orders/manual", {
          buyer: { name: "Sinta" },
          items: [{ variantId: v["TAS-1"], qty: 1 }],
          paymentMethod: "cash",
        })
      ).body.id as string;
    const [a, b] = [await make(), await make()];

    const prioritas = (await c.post("/v1/tags", { name: "Prioritas", color: "#d64545" })).body;
    expect(prioritas).toMatchObject({ name: "Prioritas", color: "#D64545", orders: 0 });
    const fragile = (await c.post("/v1/tags", { name: "Fragile" })).body;
    expect((await c.post("/v1/tags", { name: "  prioritas " })).body.code).toBe("tag.duplicate");
    expect((await c.post("/v1/tags", { name: "Merah", color: "red" })).status).toBe(422);

    const tagged = await c.post("/v1/orders/tags", { orderIds: [a, b], add: [prioritas.id, fragile.id] });
    expect(tagged.body.items).toEqual([
      {
        orderId: a,
        tags: [expect.objectContaining({ name: "Fragile" }), expect.objectContaining({ name: "Prioritas" })],
      },
      {
        orderId: b,
        tags: [expect.objectContaining({ name: "Fragile" }), expect.objectContaining({ name: "Prioritas" })],
      },
    ]);
    // tagging again changes nothing and writes no history
    await c.post("/v1/orders/tags", { orderIds: [a], add: [prioritas.id] });
    await c.post("/v1/orders/tags", { orderIds: [b], remove: [fragile.id] });
    const ids = async (tagId: string) =>
      ((await c.get(`/v1/orders?tagId=${tagId}`)).body.items as { id: string }[]).map((o) => o.id).sort();
    expect(await ids(prioritas.id)).toEqual([a, b].sort());
    expect(await ids(fragile.id)).toEqual([a]);
    const detail = (await c.get(`/v1/orders/${b}`)).body;
    expect(detail.tags).toEqual([{ id: prioritas.id, name: "Prioritas", color: "#D64545" }]);
    expect(
      detail.events
        .filter((e: { type: string }) => e.type === "tags_changed")
        .map((e: { payload: object }) => e.payload),
    ).toEqual([
      { added: ["Prioritas", "Fragile"], removed: [] },
      { added: [], removed: ["Fragile"] },
    ]);
    expect(
      (await c.get("/v1/tags")).body.items.map((t: { name: string; orders: number }) => [t.name, t.orders]),
    ).toEqual([
      ["Fragile", 1],
      ["Prioritas", 2],
    ]);
    expect((await c.post("/v1/orders/tags", { orderIds: [a], add: [jakarta] })).body.errors).toMatchObject([
      { path: "add.0" },
    ]);

    // renamed, recolored, deleted: a deleted tag leaves every order and its name is free again
    expect((await c.patch(`/v1/tags/${fragile.id}`, { name: "Mudah Pecah", color: null })).body).toMatchObject({
      name: "Mudah Pecah",
      color: null,
    });
    expect((await c.delete(`/v1/tags/${fragile.id}`)).status).toBe(204);
    expect(await ids(fragile.id)).toEqual([]);
    expect((await c.get(`/v1/orders/${a}`)).body.tags.map((t: { name: string }) => t.name)).toEqual(["Prioritas"]);
    expect((await c.post("/v1/tags", { name: "Mudah Pecah" })).status).toBe(201);

    // CS tags orders; Viewer reads them only
    const cs = await addMember(c, tenantId, "CS");
    expect((await cs.c.post("/v1/orders/tags", { orderIds: [b], remove: [prioritas.id] })).status).toBe(200);
    const viewer = await addMember(c, tenantId, "Viewer");
    expect((await viewer.c.get("/v1/tags")).status).toBe(200);
    expect((await viewer.c.post("/v1/tags", { name: "Penonton" })).status).toBe(403);
  });
});
