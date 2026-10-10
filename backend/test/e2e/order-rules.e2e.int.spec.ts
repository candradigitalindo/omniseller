import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemContext } from "../../src/common/context/request-context";
import { withTenantTx } from "../../src/db/tenant-tx";
import { AutoProcessService } from "../../src/modules/automation/auto-process.service";
import { orderAutoProcessJob } from "../../src/modules/automation/automation.jobs";
import { ExportRenderService } from "../../src/modules/exports/export-render.service";
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
import { MockMarketplace, type MockShopeeItem, type MockShopeeOrder } from "../setup/mock-marketplace";

/**
 * Automatic order processing (PRD FR-ORD-19, backend doc 8.37): new marketplace orders checked against the
 * business's rules by priority as they arrive, the first that matches acting as the system through the
 * same services as the buttons, once per order; rules kept from plan Growth on by whoever holds what they
 * do, inside their stores.
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 910000;
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

interface RuleBody {
  id: string;
  name: string;
  priority: number;
  active: boolean;
  rowVersion: number;
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>;
}
interface EventBody {
  type: string;
  actorType: string;
  actorName: string | null;
  toStatus: string | null;
  payload: Record<string, unknown>;
}

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
  const v = await c.post("/v1/products", {
    sku: "KAOS",
    name: "Kaos Polos",
    attributeNames: ["Ukuran"],
    variants: ["KAOS-M", "KAOS-L"].map((sku, i) => ({
      sku,
      attributes: { Ukuran: String(i + 1) },
      basePrice: 50_000,
      costPrice: 20_000,
      weightG: 200,
    })),
  });
  expect(v.status).toBe(201);
  const variants = v.body.variants as { id: string; sku: string }[];
  const adjusted = await c.post("/v1/inventory/adjustments", {
    lines: variants.map((x) => ({ variantId: x.id, warehouseId, mode: "set", quantity: 20 })),
    reason: "correction",
  });
  expect(adjusted.status).toBe(200);
  return { c, me, tenantId: me.tenant.id as string, warehouseId, variants };
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
    order_sn: `2610140${String(snSeq++).padStart(6, "0")}`,
    order_status: "READY_TO_SHIP",
    create_time: t - 600,
    update_time: t - 30,
    pay_time: t - 500,
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

/** A new order announced by a signed Shopee push, received and processed as in production. */
async function arrives(tenantId: string, shop: { shopId: string; orders: MockShopeeOrder[] }, o: MockShopeeOrder) {
  shop.orders.push(o);
  return pushed(tenantId, shop, o);
}

/** The order's change announced by a signed Shopee push (code 3), then the outbox run empty. */
async function pushed(tenantId: string, shop: { shopId: string }, o: MockShopeeOrder) {
  const data = { ordersn: o.order_sn, status: o.order_status, update_time: o.update_time };
  const raw = JSON.stringify({ data, shop_id: Number(shop.shopId), code: 3, timestamp: nowSec() + snSeq++ });
  const res = await request(hooks.getHttpServer())
    .post("/webhooks/shopee")
    .set("content-type", "application/json")
    .set("authorization", mock.signShopeePush(`${WEBHOOK_URL}/webhooks/shopee`, raw))
    .send(raw);
  expect(res.status).toBe(200);
  const rows = await h.system.db.execute<{ id: string }>(
    sql`SELECT id FROM webhook_inbox WHERE processed_at IS NULL AND external_shop_id = ${shop.shopId} ORDER BY id`,
  );
  for (const r of rows.rows) await worker.runJob(webhookProcessJob, { inboxId: r.id }, tenantId);
  return drain(tenantId);
}

async function orderBy(c: Client, externalOrderId: string) {
  const list = (await c.get(`/v1/orders?q=${externalOrderId}`)).body.items as { id: string; externalOrderId: string }[];
  const found = list.find((o) => o.externalOrderId === externalOrderId);
  expect(found, `order ${externalOrderId}`).toBeDefined();
  return (await c.get(`/v1/orders/${found!.id}`)).body as {
    id: string;
    status: string;
    warehouseId: string | null;
    tags: { name: string }[];
    problems: { code: string }[];
    events: EventBody[];
  };
}

const autoRuns = (o: { events: EventBody[] }) => o.events.filter((e) => e.type === "auto_processed");

async function tag(c: Client, name: string): Promise<string> {
  const res = await c.post("/v1/tags", { name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function rule(c: Client, body: object): Promise<RuleBody> {
  const res = await c.post("/v1/order-rules", body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

/** A member invited through the email flow with a role (a custom one made here, or a built-in one). */
async function member(owner: Client, tenantId: string, role: { name: string; permissions?: string[] }) {
  let roleId = ((await owner.get("/v1/roles")).body.items as { id: string; name: string }[]).find(
    (r) => r.name === role.name,
  )?.id;
  if (!roleId) {
    const made = await owner.post("/v1/roles", { name: role.name, permissions: role.permissions });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    roleId = made.body.id as string;
  }
  const email = uniqueEmail("staf");
  expect((await owner.post("/v1/invitations", { email, roleId })).status).toBe(201);
  await drain(tenantId);
  const m = client(api);
  const accepted = await m.post("/v1/auth/invitations/accept", {
    token: tokenFrom(worker.email.lastTo(email)!.text),
    name: "Budi",
    password: PASSWORD,
  });
  expect(accepted.status).toBe(201);
  return { c: m, userId: accepted.body.user.id as string };
}

describe("rules acting on new orders (FR-ORD-19)", () => {
  it("lets the first matching rule tag, accept, and arrange the pickup as the system, within a minute of arrival", async () => {
    const { c, tenantId } = await business();
    const shop = await connectShopee(c, tenantId, 711);
    const kilat = await tag(c, "Kilat");
    const besar = await tag(c, "Pesanan Besar");
    // checked first: big orders are only tagged, for a look before they go
    const big = await rule(c, {
      name: "Pesanan besar",
      conditions: { minTotal: 200_000 },
      actions: { tagIds: [besar] },
    });
    const spx = await rule(c, {
      name: "SPX satuan",
      conditions: { storeIds: [shop.storeId], couriers: ["SPX"], items: "single" },
      actions: { tagIds: [kilat], arrange: "pickup" },
    });
    expect([big.priority, spx.priority]).toEqual([1, 2]);
    expect(spx.actions).toEqual({ warehouseId: null, tagIds: [kilat], accept: true, arrange: "pickup" });

    const single = shopeeOrder(711, [{ model: 7111, sku: "KAOS-M", qty: 1 }]);
    const ran = await arrives(tenantId, shop, single);
    expect(ran).toEqual(expect.arrayContaining(["order.auto_process", "shipment.arrange", "label.fetch"]));
    const a = await orderBy(c, single.order_sn);
    expect(a.status).toBe("ready_to_pack");
    expect(a.tags.map((t) => t.name)).toEqual(["Kilat"]);
    expect((await c.get(`/v1/orders/${a.id}/shipments`)).body.items[0]).toMatchObject({
      status: "label_ready",
      method: "pickup",
    });
    expect(autoRuns(a)).toEqual([
      expect.objectContaining({
        actorType: "system",
        actorName: null,
        payload: { ruleId: spx.id, rule: "SPX satuan", done: ["tags", "arrange"], refused: [] },
      }),
    ]);
    // every step was the system's: the history says "otomatis", and the team's report counts none of it
    const steps = a.events.filter(
      (e) => e.type === "tags_changed" || e.type === "shipment_requested" || e.toStatus === "ready_to_pack",
    );
    expect(steps.map((e) => e.actorType)).toEqual(["system", "system", "system"]);

    const many = shopeeOrder(711, [{ model: 7112, sku: "KAOS-L", qty: 5 }]);
    await arrives(tenantId, shop, many);
    const b = await orderBy(c, many.order_sn);
    expect(b.status).toBe("new");
    expect(b.tags.map((t) => t.name)).toEqual(["Pesanan Besar"]);
    expect(autoRuns(b).map((e) => e.payload)).toEqual([
      { ruleId: big.id, rule: "Pesanan besar", done: ["tags"], refused: [] },
    ]);

    const none = shopeeOrder(711, [{ model: 7111, sku: "KAOS-M", qty: 2 }]);
    await arrives(tenantId, shop, none);
    const d = await orderBy(c, none.order_sn);
    expect([d.status, d.tags, autoRuns(d)]).toEqual(["new", [], []]);

    // once per order: a job run again for an order still new does nothing more
    await worker.runJob(orderAutoProcessJob, { orderId: b.id }, tenantId);
    expect(autoRuns(await orderBy(c, many.order_sn))).toHaveLength(1);
  });

  it("leaves alone orders with a problem, orders of a read-only store, and switched-off rules", async () => {
    const { c, tenantId } = await business();
    const shop = await connectShopee(c, tenantId, 712);
    const off = await rule(c, { name: "Mati", active: false, conditions: {}, actions: { accept: true } });
    expect(off.active).toBe(false);
    await rule(c, { name: "Terima semua", actions: { accept: true } });

    // an item the catalog does not know: the order waits with a problem, whatever the rules say
    const unknown = shopeeOrder(712, []);
    unknown.item_list.push({
      item_id: 9712,
      item_name: "Topi Rajut",
      model_id: 0,
      model_sku: "TOPI-RAJUT",
      model_name: "",
      model_quantity_purchased: 1,
      model_original_price: 20_000,
      model_discounted_price: 20_000,
    });
    await arrives(tenantId, shop, unknown);
    const p = await orderBy(c, unknown.order_sn);
    expect(p.status).toBe("problem");
    expect(p.problems.map((x) => x.code)).toContain("unmapped_sku");
    expect(autoRuns(p)).toEqual([]);

    const fine = shopeeOrder(712, [{ model: 7121, sku: "KAOS-M", qty: 1 }]);
    await arrives(tenantId, shop, fine);
    const f = await orderBy(c, fine.order_sn);
    expect(f.status).toBe("ready_to_pack");
    expect(autoRuns(f).map((e) => e.payload.rule)).toEqual(["Terima semua"]);

    // in parallel mode the old app processes orders: no rule acts there
    expect((await c.patch(`/v1/stores/${shop.storeId}`, { syncMode: "read_only" })).status).toBe(200);
    const parallel = shopeeOrder(712, [{ model: 7121, sku: "KAOS-M", qty: 1 }]);
    await arrives(tenantId, shop, parallel);
    const r = await orderBy(c, parallel.order_sn);
    expect([r.status, autoRuns(r)]).toEqual(["new", []]);
  });

  it("acts on an order once it is paid, and never on a manual order", async () => {
    const { c, tenantId, variants } = await business();
    const shop = await connectShopee(c, tenantId, 718);
    await rule(c, { name: "Terima", actions: { accept: true } });
    const later = shopeeOrder(718, [{ model: 7181, sku: "KAOS-M", qty: 1 }], { order_status: "UNPAID" });
    await arrives(tenantId, shop, later);
    const unpaid = await orderBy(c, later.order_sn);
    expect([unpaid.status, autoRuns(unpaid)]).toEqual(["unpaid", []]);
    // paid: the marketplace now says it is ready to ship
    later.order_status = "READY_TO_SHIP";
    later.update_time = nowSec();
    await pushed(tenantId, shop, later);
    const paid = await orderBy(c, later.order_sn);
    expect(paid.status).toBe("ready_to_pack");
    expect(autoRuns(paid).map((e) => e.payload.rule)).toEqual(["Terima"]);

    // a manual order is the team's own: no rule looks at it, even when asked directly
    const channel = (await c.post("/v1/stores/manual", { name: "WhatsApp" })).body.id as string;
    const placed = await c.post("/v1/orders/manual", {
      storeId: channel,
      buyer: { name: "Sari", phone: "081300000001" },
      shippingAddress: { line1: "Jl. Kenanga 3", city: "Bandung", province: "Jawa Barat" },
      items: [{ variantId: variants[0]!.id, qty: 1 }],
      paymentMethod: "cash",
    });
    expect(placed.status).toBe(201);
    expect(placed.body.status).toBe("new");
    const engine = worker.ctx.get(AutoProcessService, { strict: false });
    expect(await engine.run(systemContext(tenantId), placed.body.id)).toBeNull();
  });

  it("records what was refused: a warehouse without the stock, then a tag deleted since", async () => {
    const { c, tenantId, variants } = await business();
    const shop = await connectShopee(c, tenantId, 713);
    const surabaya = await c.post("/v1/warehouses", {
      code: "sby",
      name: "Gudang Surabaya",
      address: {
        contactName: "Budi",
        phone: "081234567890",
        line1: "Jl. Darmo 5",
        city: "Surabaya",
        province: "jatim",
      },
    });
    expect(surabaya.status).toBe(201);
    // counted empty: stock nobody established says nothing about the shelf (ADR-036)
    const counted = await c.post("/v1/inventory/adjustments", {
      lines: variants.map((x) => ({ variantId: x.id, warehouseId: surabaya.body.id, mode: "set", quantity: 0 })),
      reason: "correction",
    });
    expect(counted.status).toBe(200);
    const gone = await tag(c, "Sementara");
    const moving = await rule(c, {
      name: "Ke Surabaya",
      conditions: { skus: ["kaos-l"] },
      actions: { warehouseId: surabaya.body.id, tagIds: [gone], accept: true },
    });
    expect((await c.delete(`/v1/tags/${gone}`)).status).toBe(204);

    const o = shopeeOrder(713, [{ model: 7132, sku: "KAOS-L", qty: 1 }]);
    await arrives(tenantId, shop, o);
    const moved = await orderBy(c, o.order_sn);
    expect(moved.warehouseId).toBe(surabaya.body.id);
    // Surabaya holds none of it: the order waits for the team, as it would after the button
    expect(moved.status).toBe("problem");
    expect(moved.problems.map((x) => x.code)).toContain("insufficient_stock");
    expect(autoRuns(moved).map((e) => e.payload)).toEqual([
      {
        ruleId: moving.id,
        rule: "Ke Surabaya",
        done: ["warehouse"],
        refused: [
          { action: "tags", code: "tag.not_found", message: "Tag di aturan ini sudah dihapus." },
          { action: "accept", code: "order.has_problems", message: "Selesaikan masalah pesanan ini dulu." },
        ],
      },
    ]);
    expect(moved.events.find((e) => e.type === "warehouse_changed")?.actorType).toBe("system");
  });

  it("goes on after a refusal: a warehouse deleted since the rule was saved", async () => {
    const { c, tenantId } = await business();
    const shop = await connectShopee(c, tenantId, 719);
    const spare = await c.post("/v1/warehouses", {
      code: "cdg",
      name: "Gudang Cadangan",
      address: {
        contactName: "Budi",
        phone: "081234567890",
        line1: "Jl. Kenari 2",
        city: "Bandung",
        province: "jabar",
      },
    });
    expect(spare.status).toBe(201);
    const moving = await rule(c, { name: "Ke cadangan", actions: { warehouseId: spare.body.id, accept: true } });
    expect((await c.delete(`/v1/warehouses/${spare.body.id}`)).status).toBe(204);

    const o = shopeeOrder(719, [{ model: 7191, sku: "KAOS-M", qty: 1 }]);
    await arrives(tenantId, shop, o);
    const kept = await orderBy(c, o.order_sn);
    // the move is refused as the button would refuse it, and the order is still accepted where it was
    expect(kept.status).toBe("ready_to_pack");
    expect(kept.warehouseId).not.toBe(spare.body.id);
    expect(autoRuns(kept).map((e) => e.payload)).toEqual([
      {
        ruleId: moving.id,
        rule: "Ke cadangan",
        done: ["accept"],
        refused: [
          {
            action: "warehouse",
            code: "validation.failed",
            message: "Gudang tidak ditemukan, tidak aktif, atau di luar cakupan Anda.",
          },
        ],
      },
    ]);
  });

  it("follows the operating hours, and waits while the plan lacks the feature", async () => {
    const { c, me, tenantId } = await business();
    const shop = await connectShopee(c, tenantId, 714);
    const early = shopeeOrder(714, [{ model: 7141, sku: "KAOS-M", qty: 1 }]);
    const late = shopeeOrder(714, [{ model: 7141, sku: "KAOS-M", qty: 1 }]);
    // they arrive before any rule exists
    await arrives(tenantId, shop, early);
    await arrives(tenantId, shop, late);
    const open = await tag(c, "Jam kerja");
    const closed = await tag(c, "Di luar jam");
    await rule(c, { name: "Jam kerja", conditions: { withinOperatingHours: true }, actions: { tagIds: [open] } });
    await rule(c, { name: "Di luar jam", actions: { tagIds: [closed] } });
    const nine = { open: "09:00", close: "17:00" };
    expect(
      (await c.put("/v1/operating-hours/week", { schedule: [null, nine, nine, nine, nine, nine, nine] })).status,
    ).toBe(200);

    const engine = worker.ctx.get(AutoProcessService, { strict: false });
    const ctx = systemContext(tenantId);
    // Monday 12 October 2026, 10.00 WIB; then Sunday the 11th, closed all day
    const a = await engine.run(ctx, (await orderBy(c, early.order_sn)).id, new Date("2026-10-12T03:00:00Z"));
    const b = await engine.run(ctx, (await orderBy(c, late.order_sn)).id, new Date("2026-10-11T03:00:00Z"));
    expect([a?.rule, b?.rule]).toEqual(["Jam kerja", "Di luar jam"]);
    expect((await orderBy(c, early.order_sn)).tags.map((t) => t.name)).toEqual(["Jam kerja"]);
    expect((await orderBy(c, late.order_sn)).tags.map((t) => t.name)).toEqual(["Di luar jam"]);

    // on Starter the rules stay, but nothing runs (the trial ends early on Starter)
    await drain(me.tenant.id);
    expect((await c.post("/v1/billing/subscription", { planCode: "starter" })).status).toBe(200);
    const starter = shopeeOrder(714, [{ model: 7141, sku: "KAOS-M", qty: 1 }]);
    await arrives(tenantId, shop, starter);
    expect(autoRuns(await orderBy(c, starter.order_sn))).toEqual([]);
    expect(((await c.get("/v1/order-rules")).body.items as RuleBody[]).map((r) => r.name)).toEqual([
      "Jam kerja",
      "Di luar jam",
    ]);
  });
});

describe("managing rules (UI L55)", () => {
  it("saves, checks, reorders, and deletes rules, audited and exported", async () => {
    const { c, me, tenantId } = await business();
    const { storeId } = await connectShopee(c, tenantId, 715);
    const besar = await tag(c, "Besar");
    const pickup = await rule(c, {
      name: "Pickup J&T",
      conditions: { storeIds: [storeId], couriers: ["J&T", " j&t "], skus: ["KAOS-M"] },
      actions: { arrange: "pickup" },
    });
    expect(pickup).toMatchObject({
      priority: 1,
      active: true,
      conditions: {
        storeIds: [storeId],
        couriers: ["J&T"],
        warehouseIds: [],
        skus: ["KAOS-M"],
        items: "any",
        minTotal: null,
        maxTotal: null,
        withinOperatingHours: false,
      },
      actions: { warehouseId: null, tagIds: [], accept: true, arrange: "pickup" },
    });
    const tagging = await rule(c, {
      name: "Tag besar",
      conditions: { minTotal: 500_000 },
      actions: { tagIds: [besar] },
    });
    expect(tagging.priority).toBe(2);

    const refused = async (body: object) => {
      const res = await c.post("/v1/order-rules", body);
      return [res.status, res.body.code, res.body.errors?.[0]?.path ?? null, res.body.errors?.[0]?.message ?? null];
    };
    expect((await c.post("/v1/order-rules", { name: "pickup j&t", actions: { accept: true } })).body.code).toBe(
      "order_rule.duplicate",
    );
    expect(await refused({ name: "Kosong", actions: {} })).toEqual([
      422,
      "validation.failed",
      "actions",
      "Pilih paling sedikit satu tindakan.",
    ]);
    expect(
      await refused({ name: "Terbalik", conditions: { minTotal: 9, maxTotal: 1 }, actions: { accept: true } }),
    ).toEqual([
      422,
      "validation.failed",
      "conditions.maxTotal",
      "Nilai pesanan terkecil harus di bawah yang terbesar.",
    ]);
    const manual = await c.post("/v1/stores/manual", { name: "WhatsApp" });
    expect(manual.status).toBe(201);
    expect(
      await refused({ name: "Manual", conditions: { storeIds: [manual.body.id] }, actions: { accept: true } }),
    ).toEqual([
      422,
      "validation.failed",
      "conditions.storeIds.0",
      "Aturan otomatis hanya untuk pesanan toko marketplace.",
    ]);
    const nobody = "01JZZZZZZZZZZZZZZZZZZZZZZZ";
    expect((await refused({ name: "X", conditions: { storeIds: [nobody] }, actions: { accept: true } }))[2]).toBe(
      "conditions.storeIds.0",
    );
    expect((await refused({ name: "X", actions: { warehouseId: nobody } }))[2]).toBe("actions.warehouseId");
    expect((await refused({ name: "X", actions: { tagIds: [nobody] } }))[2]).toBe("actions.tagIds.0");

    // switched off, with optimistic locking
    const offed = await c
      .patch(`/v1/order-rules/${tagging.id}`, { active: false })
      .set("If-Match", `"${tagging.rowVersion}"`);
    expect(offed.status).toBe(200);
    expect(offed.body).toMatchObject({ active: false, rowVersion: tagging.rowVersion + 1 });
    const stale = await c
      .patch(`/v1/order-rules/${tagging.id}`, { name: "Basi" })
      .set("If-Match", `"${tagging.rowVersion}"`);
    expect([stale.status, stale.body.code]).toEqual([409, "row.stale"]);
    expect((await c.patch(`/v1/order-rules/${pickup.id}`, { name: "TAG BESAR" })).body.code).toBe(
      "order_rule.duplicate",
    );

    // the order they are checked in
    const reordered = await c.put("/v1/order-rules/priority", { ids: [tagging.id, pickup.id] });
    expect(reordered.status).toBe(200);
    expect((reordered.body.items as RuleBody[]).map((r) => [r.name, r.priority])).toEqual([
      ["Tag besar", 1],
      ["Pickup J&T", 2],
    ]);
    expect((await c.put("/v1/order-rules/priority", { ids: [pickup.id] })).body.errors[0].path).toBe("ids");
    expect((await c.put("/v1/order-rules/priority", { ids: [pickup.id, pickup.id] })).status).toBe(422);

    // the full export names stores and tags
    const sheet = worker.ctx
      .get(ExportRenderService, { strict: false })
      .sheets()
      .find((s) => s.file === "aturan_otomatis.csv")!;
    const rows = await withTenantTx(h.worker, userCtx(tenantId), async (tx) => {
      const out: unknown[][] = [];
      const lookups = {
        storeName: (id: string | null) => (id ? "Toko Shopee" : null),
        warehouseCode: () => null,
        userName: () => null,
      };
      for await (const page of sheet.pages(tx, lookups)) out.push(...page);
      return out;
    });
    expect(rows).toEqual([
      [1, "Tag besar", false, "", "", "", "", "any", 500_000, null, false, null, "Besar", false, null],
      [2, "Pickup J&T", true, "Toko Shopee", "J&T", "", "KAOS-M", "any", null, null, false, null, "", true, "pickup"],
    ]);

    expect((await c.delete(`/v1/order-rules/${pickup.id}`)).status).toBe(204);
    expect((await c.patch(`/v1/order-rules/${pickup.id}`, { active: true })).status).toBe(404);
    expect(((await c.get("/v1/order-rules")).body.items as RuleBody[]).map((r) => r.name)).toEqual(["Tag besar"]);

    // the log of who changed which rule (backend doc 8.28)
    const audit = (await c.get("/v1/audit-logs?entity_type=order_rule&limit=50")).body.items as {
      action: string;
      label: string | null;
      actor: { id: string | null };
    }[];
    expect(audit.map((e) => [e.action, e.label])).toEqual(
      expect.arrayContaining([
        ["insert", "Pickup J&T"],
        ["insert", "Tag besar"],
        ["update", "Tag besar"],
        ["delete", "Pickup J&T"],
      ]),
    );
    expect(audit.every((e) => e.actor.id === me.user.id)).toBe(true);
  });

  it("asks for what the rule does, and keeps a member limited to some stores inside them", async () => {
    const { c, tenantId } = await business();
    const first = await connectShopee(c, tenantId, 716);
    const second = await connectShopee(c, tenantId, 717);
    const t = await tag(c, "Cek");
    const everywhere = await rule(c, { name: "Semua toko", actions: { accept: true } });

    // CS may tag but not accept: the screen is not theirs
    const cs = await member(c, tenantId, { name: "CS" });
    expect((await cs.c.get("/v1/order-rules")).status).toBe(403);

    // accepting without arranging or tagging rights: only what they could do by hand
    const acceptor = await member(c, tenantId, { name: "Penerima", permissions: ["order:read", "order:accept"] });
    const arrange = await acceptor.c.post("/v1/order-rules", { name: "Atur", actions: { arrange: "dropoff" } });
    expect([arrange.status, arrange.body.code]).toEqual([403, "order_rule.permission_not_held"]);
    expect(arrange.body.detail).toBe(
      'Aturan ini menjalankan "Atur pengiriman dan pickup", izin yang tidak Anda miliki.',
    );
    expect((await acceptor.c.post("/v1/order-rules", { name: "Tag", actions: { tagIds: [t] } })).body.code).toBe(
      "order_rule.permission_not_held",
    );
    expect((await acceptor.c.post("/v1/order-rules", { name: "Terima", actions: { accept: true } })).status).toBe(201);
    // nor change a rule that does more than they may
    const tagger = await rule(c, { name: "Beri tag", actions: { tagIds: [t] } });
    expect((await acceptor.c.patch(`/v1/order-rules/${tagger.id}`, { active: false })).body.code).toBe(
      "order_rule.permission_not_held",
    );

    // an Admin of the first store only
    const admin = await member(c, tenantId, { name: "Admin" });
    expect((await c.put(`/v1/users/${admin.userId}/scopes`, { storeIds: [first.storeId] })).status).toBe(200);
    const unscoped = await admin.c.post("/v1/order-rules", { name: "Lepas", actions: { accept: true } });
    expect(unscoped.body.errors[0]).toEqual({
      path: "conditions.storeIds",
      message: "Pilih toko: Anda hanya mengelola sebagian toko.",
    });
    const theirs = await admin.c.post("/v1/order-rules", {
      name: "Toko kedua",
      conditions: { storeIds: [second.storeId] },
      actions: { accept: true },
    });
    expect(theirs.body.errors[0].path).toBe("conditions.storeIds.0");
    const own = await admin.c.post("/v1/order-rules", {
      name: "Toko pertama",
      conditions: { storeIds: [first.storeId] },
      actions: { accept: true },
    });
    expect(own.status).toBe(201);
    // they see and order only their own; rules over every store are not theirs to touch
    expect(((await admin.c.get("/v1/order-rules")).body.items as RuleBody[]).map((r) => r.name)).toEqual([
      "Toko pertama",
    ]);
    expect((await admin.c.patch(`/v1/order-rules/${everywhere.id}`, { active: false })).status).toBe(404);
    expect((await admin.c.delete(`/v1/order-rules/${everywhere.id}`)).status).toBe(404);
    const before = ((await c.get("/v1/order-rules")).body.items as RuleBody[]).map((r) => [r.name, r.priority]);
    expect((await admin.c.put("/v1/order-rules/priority", { ids: [own.body.id] })).status).toBe(200);
    expect(((await c.get("/v1/order-rules")).body.items as RuleBody[]).map((r) => [r.name, r.priority])).toEqual(
      before,
    );
  });

  it("on Starter: rules are listed and deleted, never made or changed", async () => {
    const { c, me } = await business();
    const kept = await rule(c, { name: "Terima", actions: { accept: true } });
    await drain(me.tenant.id);
    expect((await c.post("/v1/billing/subscription", { planCode: "starter" })).status).toBe(200);

    const made = await c.post("/v1/order-rules", { name: "Baru", actions: { accept: true } });
    expect([made.status, made.body.code, made.body.detail]).toEqual([
      422,
      "billing.feature_unavailable",
      "Aturan proses otomatis tidak termasuk paket Starter. Tersedia mulai paket Growth; naik paket di Langganan & Tagihan.",
    ]);
    expect((await c.patch(`/v1/order-rules/${kept.id}`, { active: false })).body.code).toBe(
      "billing.feature_unavailable",
    );
    expect((await c.put("/v1/order-rules/priority", { ids: [kept.id] })).body.code).toBe("billing.feature_unavailable");
    expect(((await c.get("/v1/order-rules")).body.items as RuleBody[]).map((r) => r.name)).toEqual(["Terima"]);
    expect((await c.delete(`/v1/order-rules/${kept.id}`)).status).toBe(204);
  });
});
