import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { ExportRenderService } from "../../src/modules/exports/export-render.service";
import { buyerDataAnonymizeJob } from "../../src/modules/retention/retention.jobs";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
import { scanBuyerRetention } from "../../src/scheduler/retention-scan";
import { type Client, signup, startApi, startWebhook, startWorker, WEBHOOK_URL } from "../setup/app";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace, type MockShopeeItem, type MockShopeeOrder } from "../setup/mock-marketplace";

/**
 * Buyer data retention (PRD 12.1, backend doc 8.34): orders older than the business keeps buyer data lose
 * the buyer's name, phone, address, and note, as do their shipments' tracking texts and their returns' reasons
 * and photos, while amounts, items, and dates stay. Orders still held for shipping wait. Later marketplace
 * snapshots do not bring the data back. Orders come from the fake Shopee; age comes from moving `ordered_at`.
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let queues: QueueRegistry;
const registry = new JobRegistry(JOB_DEFINITIONS);
let shopSeq = 920000;
let snSeq = 1;
let slotSeq = 0;
const nowSec = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  api = await startApi(h.infra, { marketplace: mock });
  hooks = await startWebhook(h.infra, { marketplace: mock });
  worker = await startWorker(h.infra, h.system, { marketplace: mock });
  queues = new QueueRegistry(h.redis, h.infra.keyPrefix);
});

afterAll(async () => {
  await queues?.close();
  await worker?.close();
  await hooks?.close();
  await api?.close();
  await mock?.close();
});

async function drain(tenantId: string): Promise<void> {
  for (let i = 0; i < 20; i++) if ((await worker.runOutbox(tenantId)).length === 0) return;
}

async function business() {
  const { c, me } = await signup(api);
  await drain(me.tenant.id);
  return { c, tenantId: me.tenant.id };
}

const kaos: MockShopeeItem = {
  item_id: 921,
  item_name: "Kaos",
  item_sku: "KAOS",
  item_status: "NORMAL",
  update_time: 1_700_000_000,
  tiers: [{ name: "Ukuran", options: ["M"] }],
  models: [{ model_id: 9211, model_sku: "KAOS-M", tier_index: [0], price: 50_000, stock: 3 }],
};

async function connectShopee(c: Client, tenantId: string) {
  const shopId = String(++shopSeq);
  mock.addShopeeShop({
    shopId,
    name: `Toko ${shopId}`,
    region: "ID",
    warehouses: "not_whitelisted",
    items: [kaos],
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
  return shopId;
}

function shopeeOrder(status: string): MockShopeeOrder {
  const t = nowSec();
  return {
    order_sn: `2610090${String(snSeq++).padStart(6, "0")}`,
    order_status: status,
    create_time: t - 600,
    update_time: t - 300,
    pay_time: t - 500,
    ship_by_date: t + 2 * 86_400,
    cod: false,
    total_amount: 90_000,
    buyer_user_id: 4242,
    buyer_username: "dewi_belanja",
    message_to_seller: "Tolong bungkus rapi, saya di rumah sore",
    shipping_carrier: "SPX Express",
    recipient_address: {
      name: "Dewi Lestari",
      phone: "6281234567890",
      city: "Jakarta Barat",
      state: "DKI Jakarta",
      zipcode: "11470",
      full_address: "Jl. Mawar No. 1, Kebon Jeruk",
    },
    item_list: [
      {
        item_id: 921,
        item_name: "Kaos",
        model_id: 9211,
        model_sku: "KAOS-M",
        model_name: "M",
        model_quantity_purchased: 2,
        model_original_price: 50_000,
        model_discounted_price: 45_000,
      },
    ],
  };
}

/** The order at the fake Shopee, announced by a signed push and taken in by the worker. */
async function placeAt(tenantId: string, shopId: string, o: MockShopeeOrder) {
  const orders = mock.shopeeShops.get(shopId)!.orders!;
  const i = orders.findIndex((x) => x.order_sn === o.order_sn);
  if (i >= 0) orders[i] = o;
  else orders.push(o);
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

async function orderOf(c: Client, externalOrderId: string) {
  const list = (await c.get(`/v1/orders?q=${externalOrderId}`)).body.items as { id: string; externalOrderId: string }[];
  const found = list.find((o) => o.externalOrderId === externalOrderId);
  expect(found, externalOrderId).toBeDefined();
  return (await c.get(`/v1/orders/${found!.id}`)).body;
}

/** The order was placed `months` months ago. */
async function age(tenantId: string, orderId: string, months: number) {
  await withTenantTx(h.worker, userCtx(tenantId), (tx) =>
    tx.execute(
      sql`UPDATE "order" SET ordered_at = now() - make_interval(months => ${months}::int) WHERE id = ${orderId}`,
    ),
  );
}

const anonymize = (tenantId: string) => worker.runJob(buyerDataAnonymizeJob, { slot: `t${++slotSeq}` }, tenantId);

async function rowOf(tenantId: string, orderId: string) {
  return withTenantTx(h.worker, userCtx(tenantId), async (tx) => {
    const r = await tx.execute<Record<string, unknown>>(
      sql`SELECT buyer_name, buyer_username, buyer_phone, buyer_note, external_buyer_id, shipping_address,
                 buyer_anonymized_at, total, status FROM "order" WHERE id = ${orderId}`,
    );
    return r.rows[0]!;
  });
}

describe("buyer data retention (PRD 12.1, backend doc 8.34)", () => {
  it("takes the buyer's data out of old orders, their parcels, and their returns, keeping what the business needs", async () => {
    const { c, tenantId } = await business();
    const shopId = await connectShopee(c, tenantId);
    const done = shopeeOrder("COMPLETED");
    const waiting = shopeeOrder("READY_TO_SHIP");
    await placeAt(tenantId, shopId, done);
    await placeAt(tenantId, shopId, waiting);
    const old = await orderOf(c, done.order_sn);
    const held = await orderOf(c, waiting.order_sn);
    expect(old).toMatchObject({ status: "completed", buyerName: "Dewi Lestari", buyerAnonymizedAt: null });
    expect(old.buyerNote).toBe("Tolong bungkus rapi, saya di rumah sore");

    // its parcel's tracking names who took it; a return carries the buyer's reason and photos
    const fileId = newId();
    await withTenantTx(h.worker, userCtx(tenantId), async (tx) => {
      const events = JSON.stringify([
        {
          at: "2026-10-01T09:00:00Z",
          description: "Diterima oleh Dewi (pemilik)",
          code: "DELIVERED",
          stage: "delivered",
        },
        {
          at: "2026-09-30T09:00:00Z",
          description: "Dalam perjalanan ke Jakarta Barat",
          code: null,
          stage: "in_transit",
        },
      ]);
      const shipped = await tx.execute(
        sql`UPDATE shipment SET tracking_events = ${events}::jsonb WHERE order_id = ${old.id}`,
      );
      if (shipped.rowCount === 0) {
        await tx.execute(sql`INSERT INTO shipment (id, tenant_id, order_id, tracking_events)
                             VALUES (${newId()}, ${tenantId}, ${old.id}, ${events}::jsonb)`);
      }
      await tx.execute(sql`INSERT INTO file_object (id, tenant_id, bucket, object_key, mime, size_bytes, purpose)
                           VALUES (${fileId}, ${tenantId}, 'local', ${`t/${tenantId}/evidence/${fileId}.jpg`},
                                   'image/jpeg', 10, 'evidence')`);
      const evidence = JSON.stringify([
        { type: "image", url: "https://cf.shopee.co.id/p1.jpg", thumbnailUrl: null, by: "buyer" },
      ]);
      const sellerEvidence = JSON.stringify([
        { fileId, contentType: "image/jpeg", size: 10, uploadedAt: "2026-10-02T00:00:00Z", uploadedBy: null },
      ]);
      await tx.execute(sql`INSERT INTO return_request (id, tenant_id, store_id, order_id, kind, external_return_id, status,
                                                       reason, evidence, seller_evidence, received_at, receipt_note)
                           SELECT ${newId()}, ${tenantId}, store_id, id, 'return_refund', '26100900RET01', 'closed',
                                  'Ukuran tidak sesuai, hubungi 081234567890', ${evidence}::jsonb, ${sellerEvidence}::jsonb,
                                  now(), 'Dus penyok' FROM "order" WHERE id = ${old.id}`);
    });

    // two years and a month ago: past the 24 months a business keeps buyer data by default
    await age(tenantId, old.id, 25);
    await age(tenantId, held.id, 25);
    await anonymize(tenantId);

    const after = await orderOf(c, done.order_sn);
    expect(after).toMatchObject({
      buyerName: null,
      buyerUsername: null,
      buyerPhone: null,
      buyerNote: null,
      status: "completed",
      total: old.total,
    });
    // only the city and the province are left of the address
    expect(after.shippingAddress).toEqual({ city: "Jakarta Barat", province: "DKI Jakarta" });
    expect(Date.parse(after.buyerAnonymizedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(after.items).toEqual(old.items);
    expect(await rowOf(tenantId, old.id)).toMatchObject({ external_buyer_id: null });

    // still to be shipped: the seller needs the address, so it waits
    expect(await orderOf(c, waiting.order_sn)).toMatchObject({ buyerName: "Dewi Lestari", buyerAnonymizedAt: null });

    const parts = await withTenantTx(h.worker, userCtx(tenantId), async (tx) => ({
      tracking: (
        await tx.execute<{ e: { description: string; stage: string | null }[] }>(
          sql`SELECT tracking_events AS e FROM shipment WHERE order_id = ${old.id}`,
        )
      ).rows[0]!.e,
      ret: (
        await tx.execute<Record<string, unknown>>(
          sql`SELECT reason, evidence, seller_evidence, receipt_note FROM return_request WHERE order_id = ${old.id}`,
        )
      ).rows[0]!,
      file: (
        await tx.execute<{ expired: boolean }>(
          sql`SELECT expires_at <= now() AS expired FROM file_object WHERE id = ${fileId}`,
        )
      ).rows[0]!,
    }));
    expect(parts.tracking).toEqual([
      { at: "2026-10-01T09:00:00Z", description: "", code: "DELIVERED", stage: "delivered" },
      { at: "2026-09-30T09:00:00Z", description: "", code: null, stage: "in_transit" },
    ]);
    // the seller's own note about the goods stays
    expect(parts.ret).toEqual({ reason: null, evidence: [], seller_evidence: [], receipt_note: "Dus penyok" });
    expect(parts.file.expired).toBe(true);

    // the full export no longer has the buyer, and says when they went
    const sheet = worker.ctx
      .get(ExportRenderService, { strict: false })
      .sheets()
      .find((s) => s.file === "pesanan.csv")!;
    const rows = await withTenantTx(h.worker, userCtx(tenantId), async (tx) => {
      const out: unknown[][] = [];
      const lookups = { storeName: () => null, warehouseCode: () => null, userName: () => null };
      for await (const page of sheet.pages(tx, lookups)) out.push(...page);
      return out;
    });
    const col = (name: string) => sheet.columns.indexOf(name);
    const exported = rows.find((r) => r[0] === old.id)!;
    expect([exported[col("nama_pembeli")], exported[col("telepon_penerima")], exported[col("alamat")]]).toEqual([
      null,
      undefined,
      undefined,
    ]);
    expect(exported[col("data_pembeli_dianonimkan_pada")]).toBeInstanceOf(Date);

    // a later snapshot from the marketplace does not bring the buyer back
    await placeAt(tenantId, shopId, { ...done, update_time: nowSec() });
    expect(await orderOf(c, done.order_sn)).toMatchObject({ buyerName: null, buyerPhone: null, buyerNote: null });
    expect(await rowOf(tenantId, old.id)).toMatchObject({ external_buyer_id: null, buyer_username: null });

    // the parcel finally ships: from then on it goes like the others
    await placeAt(tenantId, shopId, { ...waiting, order_status: "SHIPPED", update_time: nowSec() });
    await age(tenantId, held.id, 25);
    await anonymize(tenantId);
    expect(await orderOf(c, waiting.order_sn)).toMatchObject({ buyerName: null, buyerPhone: null });
  });

  it("keeps buyer data as long as the owner chose: 3 to 24 months, audited", async () => {
    const { c, tenantId } = await business();
    const shopId = await connectShopee(c, tenantId);
    const recent = shopeeOrder("COMPLETED");
    const older = shopeeOrder("CANCELLED");
    await placeAt(tenantId, shopId, recent);
    await placeAt(tenantId, shopId, older);
    const a = await orderOf(c, recent.order_sn);
    const b = await orderOf(c, older.order_sn);
    await age(tenantId, a.id, 5);
    await age(tenantId, b.id, 7);
    // the default two years keeps both
    expect((await c.get("/v1/business-profile")).body.buyerDataRetentionMonths).toBe(24);
    await anonymize(tenantId);
    expect((await rowOf(tenantId, b.id)).buyer_anonymized_at).toBeNull();

    // the profile exists already: changing how long buyer data is kept is an update of it
    expect((await c.patch("/v1/business-profile", { pkp: true })).status).toBe(200);
    for (const months of [2, 25, 6.5]) {
      expect((await c.patch("/v1/business-profile", { buyerDataRetentionMonths: months })).status).toBe(422);
    }
    const saved = await c.patch("/v1/business-profile", { buyerDataRetentionMonths: 6 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.buyerDataRetentionMonths).toBe(6);
    await anonymize(tenantId);
    expect((await rowOf(tenantId, b.id)).buyer_anonymized_at).not.toBeNull();
    expect((await rowOf(tenantId, a.id)).buyer_anonymized_at).toBeNull();

    const audit = (await c.get("/v1/audit-logs?entity_type=business_profile")).body.items as {
      change: string;
      changes: { field: string; before: unknown; after: unknown }[];
    }[];
    expect(audit.filter((e) => e.change === "updated").flatMap((e) => e.changes)).toContainEqual(
      expect.objectContaining({ field: "buyerDataRetentionMonths", before: 24, after: 6 }),
    );
  });

  it("queues each business with buyer data due once an hour, and nobody else", async () => {
    const due = await business();
    const fresh = await business();
    const shopId = await connectShopee(due.c, due.tenantId);
    const o = shopeeOrder("COMPLETED");
    await placeAt(due.tenantId, shopId, o);
    await age(due.tenantId, (await orderOf(due.c, o.order_sn)).id, 30);
    // nothing due here: an old order still to ship, and a recent one done
    const freshShop = await connectShopee(fresh.c, fresh.tenantId);
    const stuck = shopeeOrder("READY_TO_SHIP");
    const recent = shopeeOrder("COMPLETED");
    await placeAt(fresh.tenantId, freshShop, stuck);
    await placeAt(fresh.tenantId, freshShop, recent);
    await age(fresh.tenantId, (await orderOf(fresh.c, stuck.order_sn)).id, 30);

    const queued = async () =>
      (await queues.get("import").getJobs(["waiting", "delayed"])).filter(
        (j) => j.name === "retention.buyer_anonymize",
      );
    const now = new Date();
    await scanBuyerRetention(h.system, queues, registry, now);
    await scanBuyerRetention(h.system, queues, registry, now);
    const jobs = (await queued()).filter((j) => [due.tenantId, fresh.tenantId].includes(j.data.tenantId));
    expect(jobs.map((j) => j.data.tenantId)).toEqual([due.tenantId]);
    for (const j of await queued()) await j.remove();
  });

  it("refuses to write a buyer back into a manual order whose buyer data is gone", async () => {
    const { c, tenantId } = await business();
    const variant = (
      await c.post("/v1/products", {
        sku: "TAS",
        name: "Tas Anyam",
        variants: [{ sku: "TAS-1", basePrice: 120_000, costPrice: 60_000, weightG: 400 }],
      })
    ).body.variants[0].id as string;
    const channel = (await c.post("/v1/stores/manual", { name: "WhatsApp" })).body.id as string;
    const placed = await c.post("/v1/orders/manual", {
      storeId: channel,
      buyer: { name: "Sari", phone: "081300000001" },
      items: [{ variantId: variant, qty: 1 }],
      paymentMethod: "cash",
    });
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    await withTenantTx(h.worker, userCtx(tenantId), (tx) =>
      tx.execute(sql`UPDATE "order" SET buyer_anonymized_at = now(), buyer_name = NULL WHERE id = ${placed.body.id}`),
    );
    for (const patch of [{ buyer: { name: "Sari" } }, { buyerNote: "Antar sore" }]) {
      const refused = await c.patch(`/v1/orders/${placed.body.id}`, patch);
      expect([refused.status, refused.body.code]).toEqual([409, "order.buyer_anonymized"]);
    }
    // what is not the buyer's can still change
    expect((await c.patch(`/v1/orders/${placed.body.id}`, { trackingNumber: "JX123" })).status).toBe(200);
  });
});
