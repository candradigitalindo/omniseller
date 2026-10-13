import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemContext } from "../../src/common/context/request-context";
import { localDate } from "../../src/common/time-zone";
import { withSystemTx, withTenantTx } from "../../src/db/tenant-tx";
import type { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { AutoProcessService } from "../../src/modules/automation/auto-process.service";
import { orderAutoArrangeJob, orderAutoProcessJob } from "../../src/modules/automation/automation.jobs";
import { ExportRenderService } from "../../src/modules/exports/export-render.service";
import { AutoPrintService } from "../../src/modules/fulfillment/auto-print.service";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
import { scanAutoArranges } from "../../src/scheduler/auto-arrange-scan";
import {
  type Client,
  client,
  fakeIp,
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
  pending: number;
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
  await announce(tenantId, shop, o);
  return drain(tenantId);
}

/** A new order at the fake Shopee, its push received and the order read in; nothing more run yet. */
async function announce(tenantId: string, shop: { shopId: string; orders: MockShopeeOrder[] }, o: MockShopeeOrder) {
  shop.orders.push(o);
  await webhook(tenantId, shop, o);
}

/** The order's change announced by a signed Shopee push (code 3), then the outbox run empty. */
async function pushed(tenantId: string, shop: { shopId: string }, o: MockShopeeOrder) {
  await webhook(tenantId, shop, o);
  return drain(tenantId);
}

/** A signed Shopee push (code 3) through the webhook process, and its inbox row processed. */
async function webhook(tenantId: string, shop: { shopId: string }, o: MockShopeeOrder) {
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
}

/** A print agent paired by the owner (its token is shown once) and its REST client. */
async function pairAgent(c: Client, body: object = { name: "PC Gudang" }) {
  const paired = await c.post("/v1/print-agents", body);
  expect(paired.status, JSON.stringify(paired.body)).toBe(201);
  const token = paired.body.token as string;
  const ip = fakeIp();
  const auth = <T extends { set(k: string, v: string): T }>(r: T) =>
    r.set("authorization", `Bearer ${token}`).set("CF-Connecting-IP", ip);
  const server = api.getHttpServer();
  return {
    id: paired.body.agent.id as string,
    agent: { get: (url: string) => auth(request(server).get(url)) },
  };
}

/** The scheduler's queue as a list of what it added. */
function fakeQueues() {
  const added: { name: string; payload: { tenantId: string; slot: string; until: string }; jobId: string }[] = [];
  const queues = {
    get: () => ({
      add: async (name: string, payload: (typeof added)[number]["payload"], o: { jobId: string }) =>
        added.push({ name, payload, jobId: o.jobId }),
    }),
  } as unknown as QueueRegistry;
  return { added, queues };
}

/** The moment of a WIB wall-clock time on a date; the fake orders' ship-by dates are two days from now. */
const wib = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`);
const today = () => localDate("Asia/Jakarta", new Date());

const printJobsOf = async (c: Client, deviceId: string) =>
  (await c.get(`/v1/print-jobs?deviceId=${deviceId}`)).body.items as {
    id: string;
    title: string;
    status: string;
    waitingForDocument: boolean;
    documentId: string;
    requestedBy: string | null;
  }[];

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
    expect(spx.actions).toEqual({
      warehouseId: null,
      tagIds: [kilat],
      accept: true,
      arrange: "pickup",
      arrangeAt: null,
      print: null,
    });

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

  it("processes an order once when its job is delivered twice at the same moment", async () => {
    const { c, tenantId } = await business();
    const shop = await connectShopee(c, tenantId, 724);
    const o = shopeeOrder(724, [{ model: 7241, sku: "KAOS-M", qty: 1 }]);
    await arrives(tenantId, shop, o);
    const id = (await orderBy(c, o.order_sn)).id;
    // a rule that leaves the status alone: only the processed entry tells a second run to stop
    const kilat = await tag(c, "Kilat");
    const saved = await rule(c, { name: "Tag kilat", actions: { tagIds: [kilat] } });
    const engine = worker.ctx.get(AutoProcessService, { strict: false });
    const ctx = systemContext(tenantId);
    // a run waits on the order's lock while another delivery holds it, instead of reading the order
    let held: Promise<string> | undefined;
    let whileLocked: string | undefined;
    await withSystemTx(h.system, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`order.auto_process|${id}`}))`);
      held = engine.run(ctx, id).then((r) => (r ? "ran" : "nothing"));
      whileLocked = await Promise.race([held, new Promise<string>((r) => setTimeout(() => r("waiting"), 400))]);
    });
    expect(whileLocked).toBe("waiting");
    // the lock went with that transaction: the run goes on and processes the order
    expect(await held).toBe("ran");
    // a second delivery finds the order processed
    expect(await engine.run(ctx, id)).toBeNull();
    const d = await orderBy(c, o.order_sn);
    expect(d.status).toBe("new");
    expect(d.tags.map((t) => t.name)).toEqual(["Kilat"]);
    expect(autoRuns(d).map((e) => e.payload)).toMatchObject([{ ruleId: saved.id, done: ["tags"], refused: [] }]);
    expect(d.events.filter((e) => e.type === "tags_changed")).toHaveLength(1);
  });
});

describe("auto print and timed arranges (FR-SHP-18, backend doc 8.37)", () => {
  it("prints labels ready together on the rule's agent as one document, seen by the warehouse's own staff", async () => {
    const { c, me, tenantId, warehouseId } = await business();
    const shop = await connectShopee(c, tenantId, 720);
    const agent = await pairAgent(c, { name: "PC Packing" });
    const saved = await rule(c, {
      name: "Pickup dan cetak",
      actions: { arrange: "pickup", print: { deviceId: agent.id, packingList: true } },
    });
    expect(saved.actions).toMatchObject({
      arrange: "pickup",
      print: { deviceId: agent.id, format: "thermal", template: "standard", packingList: true },
    });
    const one = shopeeOrder(720, [{ model: 7201, sku: "KAOS-M", qty: 1 }]);
    const two = shopeeOrder(720, [{ model: 7202, sku: "KAOS-L", qty: 2 }]);
    await announce(tenantId, shop, one);
    await announce(tenantId, shop, two);
    const ran = await drain(tenantId);
    expect(ran).toEqual(
      expect.arrayContaining(["order.auto_process", "label.fetch", "shipment.auto_print", "document.render"]),
    );

    // the two labels, ready in the same batch, went in one document to the agent
    const jobs = await printJobsOf(c, agent.id);
    expect(jobs).toMatchObject([
      { title: "Label 2 pesanan (otomatis)", status: "queued", waitingForDocument: false, requestedBy: null },
    ]);
    expect((await agent.agent.get("/v1/agent/print-jobs")).body.items).toMatchObject([
      { title: "Label 2 pesanan (otomatis)" },
    ]);
    const doc = (await c.get(`/v1/documents/${jobs[0]!.documentId}`)).body;
    expect(doc).toMatchObject({ kind: "labels", status: "ready", orderCount: 2 });
    for (const o of [one, two]) {
      const detail = await orderBy(c, o.order_sn);
      expect(detail.status).toBe("ready_to_pack");
      expect(autoRuns(detail)[0]!.payload.done).toEqual(["arrange", "print"]);
      const printed = detail.events.filter((e) => e.type === "auto_print");
      expect(printed).toHaveLength(1);
      expect(printed[0]).toMatchObject({
        actorType: "system",
        payload: { status: "queued", agent: "PC Packing", ruleId: saved.id },
      });
      // the label was printed by the system (the team report counts nobody), and the list says so
      expect(detail.events.find((e) => e.type === "label_printed")?.actorType).toBe("system");
    }
    const listed = (await c.get("/v1/orders?status=ready_to_pack")).body.items as { labelPrintedAt: string | null }[];
    expect(listed.map((o) => o.labelPrintedAt !== null)).toEqual([true, true]);

    // a packer limited to the warehouse sees the system's job on its agent (L07), and can open the document
    const packer = await member(c, tenantId, { name: "Gudang" });
    expect((await c.put(`/v1/users/${packer.userId}/scopes`, { warehouseIds: [warehouseId] })).status).toBe(200);
    expect((await packer.c.get(`/v1/print-jobs?deviceId=${agent.id}`)).body.items).toHaveLength(1);
    expect((await packer.c.get(`/v1/print-jobs/${jobs[0]!.id}`)).status).toBe(200);
    expect((await packer.c.get(`/v1/documents/${jobs[0]!.documentId}`)).status).toBe(200);
    void me;
  });

  it("skips a label somebody printed first or ready too late, and refuses an agent revoked since", async () => {
    const { c, tenantId } = await business();
    const ctx = systemContext(tenantId);
    const shop = await connectShopee(c, tenantId, 721);
    const agent = await pairAgent(c, { name: "PC Lama" });
    await rule(c, { name: "Cetak", actions: { arrange: "dropoff", print: { deviceId: agent.id } } });
    const first = shopeeOrder(721, [{ model: 7211, sku: "KAOS-M", qty: 1 }]);
    await announce(tenantId, shop, first);
    // run the chain up to the label: the print job itself is still in the outbox
    for (let i = 0; i < 10; i++) {
      const round = await worker.runOutbox(tenantId);
      if (round.includes("label.fetch")) break;
    }
    const o = await orderBy(c, first.order_sn);
    expect((await c.get(`/v1/orders/${o.id}/shipments`)).body.items[0]).toMatchObject({ status: "label_ready" });
    // a person prints the label from the queue before the automatic print runs
    expect((await c.post("/v1/documents", { kind: "labels", orderIds: [o.id] })).status).toBe(202);
    await drain(tenantId);
    const skipped = (await orderBy(c, first.order_sn)).events.filter((e) => e.type === "auto_print");
    expect(skipped.map((e) => e.payload)).toMatchObject([{ status: "skipped", code: "auto_print.already_printed" }]);
    expect(await printJobsOf(c, agent.id)).toEqual([]);

    // a label ready long after the arrange: the rule's instruction has expired
    const late = shopeeOrder(721, [{ model: 7212, sku: "KAOS-L", qty: 1 }]);
    await announce(tenantId, shop, late);
    for (let i = 0; i < 10; i++) {
      const round = await worker.runOutbox(tenantId);
      if (round.includes("label.fetch")) break;
    }
    const printer = worker.ctx.get(AutoPrintService, { strict: false });
    expect(await printer.printDue(ctx, new Date(Date.now() + 13 * 3600_000))).toEqual({
      queued: 0,
      skipped: 1,
      refused: 0,
    });
    expect(
      (await orderBy(c, late.order_sn)).events.filter((e) => e.type === "auto_print").map((e) => e.payload),
    ).toMatchObject([{ status: "skipped", code: "auto_print.expired" }]);
    // the queued auto print job finds nothing left
    await drain(tenantId);
    expect(await printJobsOf(c, agent.id)).toEqual([]);

    // the agent is revoked after the arrange, before the label: refused when the label is ready
    const third = shopeeOrder(721, [{ model: 7211, sku: "KAOS-M", qty: 1 }]);
    await announce(tenantId, shop, third);
    for (let i = 0; i < 10; i++) {
      const round = await worker.runOutbox(tenantId);
      if (round.includes("label.fetch")) break;
    }
    expect((await c.delete(`/v1/print-agents/${agent.id}`)).status).toBe(204);
    await drain(tenantId);
    expect(
      (await orderBy(c, third.order_sn)).events.filter((e) => e.type === "auto_print").map((e) => e.payload),
    ).toEqual([
      {
        status: "refused",
        code: "print_agent.invalid",
        message: "Agen cetak tidak ditemukan atau sudah dicabut.",
        ruleId: expect.any(String),
      },
    ]);
    expect(await printJobsOf(c, agent.id)).toEqual([]);

    // after the revoke, the next order is arranged, and the print refused at once
    const second = shopeeOrder(721, [{ model: 7211, sku: "KAOS-M", qty: 1 }]);
    await arrives(tenantId, shop, second);
    const detail = await orderBy(c, second.order_sn);
    expect(detail.status).toBe("ready_to_pack");
    expect(autoRuns(detail)[0]!.payload).toMatchObject({
      done: ["arrange"],
      refused: [{ action: "print", code: "print_agent.invalid" }],
    });
    expect(detail.events.filter((e) => e.type === "auto_print")).toEqual([]);
  });

  it("arranges at the rule's time, leaving alone what a person arranged, a switched-off rule, and a near deadline", async () => {
    const { c, tenantId } = await business();
    const shop = await connectShopee(c, tenantId, 722);
    // the orders come in before the rule exists, so each run below is the rule's first look at them
    const o1 = shopeeOrder(722, [{ model: 7221, sku: "KAOS-M", qty: 1 }]);
    const o2 = shopeeOrder(722, [{ model: 7221, sku: "KAOS-M", qty: 1 }]);
    const o3 = shopeeOrder(722, [{ model: 7222, sku: "KAOS-L", qty: 1 }]);
    // o4 must be shipped within the hour: waiting until 13.00 would miss it
    const o4 = shopeeOrder(722, [{ model: 7221, sku: "KAOS-M", qty: 1 }], {
      ship_by_date: Math.floor(wib(today(), "10:00").getTime() / 1000),
    });
    for (const o of [o1, o2, o3, o4]) await arrives(tenantId, shop, o);
    const ids = await Promise.all([o1, o2, o3, o4].map(async (o) => (await orderBy(c, o.order_sn)).id));
    const timed = await rule(c, { name: "Pickup siang", actions: { arrange: "pickup", arrangeAt: "13:00" } });
    expect(timed.pending).toBe(0);

    const engine = worker.ctx.get(AutoProcessService, { strict: false });
    const ctx = systemContext(tenantId);
    // the rule looks at the orders at 09.00 WIB today
    const morning = wib(today(), "09:00");
    for (const id of ids.slice(0, 3)) {
      const run = await engine.run(ctx, id, morning);
      expect(run).toMatchObject({
        done: ["accept", "schedule"],
        refused: [],
        arrangeAt: wib(today(), "13:00").toISOString(),
      });
    }
    expect(await engine.run(ctx, ids[3]!, morning)).toMatchObject({ done: ["arrange"], arrangeNow: "deadline" });
    expect((await orderBy(c, o1.order_sn)).status).toBe("ready_to_pack");
    expect(((await c.get("/v1/order-rules")).body.items as { pending: number }[])[0]!.pending).toBe(3);
    await drain(tenantId);
    expect((await c.get(`/v1/orders/${ids[3]}/shipments`)).body.items[0]).toMatchObject({ status: "label_ready" });

    // before the time, a person arranges o2 by hand; the rule is switched off for o3 only after its row exists
    expect((await c.post("/v1/shipments/arrange", { orderIds: [ids[1]], method: "dropoff" })).body.items).toEqual([
      { id: ids[1], ok: true },
    ]);
    await drain(tenantId);
    const registry = new JobRegistry(JOB_DEFINITIONS);
    const early = fakeQueues();
    await scanAutoArranges(h.system, early.queues, registry, wib(today(), "12:59"));
    expect(early.added.filter((a) => a.payload.tenantId === tenantId)).toEqual([]);
    const due = fakeQueues();
    const at = wib(today(), "13:00");
    at.setSeconds(30);
    await scanAutoArranges(h.system, due.queues, registry, at);
    const job = due.added.find((a) => a.payload.tenantId === tenantId)!;
    expect(job).toMatchObject({ name: "order.auto_arrange", jobId: expect.stringMatching(/^order\.auto_arrange\|/) });
    // the rule is switched off just before its time: the whole wave stops, o2's own arrange stands
    expect((await c.patch(`/v1/order-rules/${timed.id}`, { active: false })).status).toBe(200);
    await worker.runJob(orderAutoArrangeJob, { slot: job.payload.slot, until: job.payload.until }, tenantId);
    const outcomes = await Promise.all(
      ids.slice(0, 3).map(async (id, i) => {
        const d = await orderBy(c, [o1, o2, o3][i]!.order_sn);
        const e = d.events.find((x) => x.type === "auto_arrange");
        return [id, e?.payload.status, e?.payload.code];
      }),
    );
    expect(outcomes).toEqual([
      [ids[0], "skipped", "auto_arrange.rule_inactive"],
      [ids[1], "skipped", "shipment.already_arranged"],
      [ids[2], "skipped", "auto_arrange.rule_inactive"],
    ]);
    expect(((await c.get("/v1/order-rules")).body.items as { pending: number }[])[0]!.pending).toBe(0);
  });

  it("arranges a waiting order at its time through the store's one request, and tells the order", async () => {
    const { c, tenantId } = await business();
    const shop = await connectShopee(c, tenantId, 723);
    const a = shopeeOrder(723, [{ model: 7231, sku: "KAOS-M", qty: 1 }]);
    const b = shopeeOrder(723, [{ model: 7232, sku: "KAOS-L", qty: 1 }]);
    await arrives(tenantId, shop, a);
    await arrives(tenantId, shop, b);
    const agent = await pairAgent(c, { name: "PC Siang" });
    await rule(c, {
      name: "Pickup siang cetak",
      actions: { arrange: "pickup", arrangeAt: "13:00", print: { deviceId: agent.id } },
    });
    const engine = worker.ctx.get(AutoProcessService, { strict: false });
    const ctx = systemContext(tenantId);
    const ids = [await orderBy(c, a.order_sn), await orderBy(c, b.order_sn)].map((o) => o.id);
    for (const id of ids) {
      expect(await engine.run(ctx, id, wib(today(), "08:30"))).toMatchObject({
        done: ["accept", "schedule", "print"],
      });
    }
    const before = mock.callsTo("POST", "/api/v2/logistics/mass_ship_order").length;
    // a job of an earlier minute claims nothing: the rows are due at 13.00
    await worker.runJob(orderAutoArrangeJob, { slot: "early", until: wib(today(), "12:00").toISOString() }, tenantId);
    for (const o of [a, b]) {
      expect((await orderBy(c, o.order_sn)).events.filter((e) => e.type === "auto_arrange")).toEqual([]);
    }
    expect(((await c.get("/v1/order-rules")).body.items as { pending: number }[])[0]!.pending).toBe(2);
    const at = wib(today(), "13:00");
    await worker.runJob(orderAutoArrangeJob, { slot: "test", until: at.toISOString() }, tenantId);
    const ran = await drain(tenantId);
    expect(ran).toEqual(
      expect.arrayContaining(["shipment.arrange", "label.fetch", "shipment.auto_print", "document.render"]),
    );
    // one marketplace request for both orders
    expect(mock.callsTo("POST", "/api/v2/logistics/mass_ship_order").length).toBe(before + 1);
    for (const o of [a, b]) {
      const d = await orderBy(c, o.order_sn);
      expect(d.status).toBe("ready_to_pack");
      expect(d.events.find((e) => e.type === "auto_arrange")?.payload).toMatchObject({
        status: "arranged",
        method: "pickup",
      });
      expect(d.events.find((e) => e.type === "auto_print")?.payload).toMatchObject({
        status: "queued",
        agent: "PC Siang",
      });
      expect((await c.get(`/v1/orders/${d.id}/shipments`)).body.items[0]).toMatchObject({
        status: "label_ready",
        method: "pickup",
      });
    }
    expect(await printJobsOf(c, agent.id)).toMatchObject([{ title: "Label 2 pesanan (otomatis)", status: "queued" }]);
  });

  it("does not wait for the time when the order could not be accepted", async () => {
    const { c, tenantId, variants } = await business();
    const shop = await connectShopee(c, tenantId, 725);
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
    const counted = await c.post("/v1/inventory/adjustments", {
      lines: variants.map((x) => ({ variantId: x.id, warehouseId: surabaya.body.id, mode: "set", quantity: 0 })),
      reason: "correction",
    });
    expect(counted.status).toBe(200);
    const o = shopeeOrder(725, [{ model: 7252, sku: "KAOS-L", qty: 1 }]);
    await arrives(tenantId, shop, o);
    const id = (await orderBy(c, o.order_sn)).id;
    const timed = await rule(c, {
      name: "Siang dari Surabaya",
      actions: { warehouseId: surabaya.body.id, arrange: "pickup", arrangeAt: "13:00" },
    });
    const engine = worker.ctx.get(AutoProcessService, { strict: false });
    // moved to a warehouse without the stock, the order has a problem and cannot be accepted: nothing waits
    const run = await engine.run(systemContext(tenantId), id, wib(today(), "09:00"));
    expect(run).toMatchObject({
      ruleId: timed.id,
      done: ["warehouse"],
      refused: [{ action: "accept", code: "order.has_problems" }],
    });
    expect(run?.arrangeAt).toBeUndefined();
    expect((await orderBy(c, o.order_sn)).status).toBe("problem");
    expect(((await c.get("/v1/order-rules")).body.items as { pending: number }[])[0]!.pending).toBe(0);
    const due = fakeQueues();
    await scanAutoArranges(h.system, due.queues, new JobRegistry(JOB_DEFINITIONS), wib(today(), "13:00"));
    expect(due.added.filter((x) => x.payload.tenantId === tenantId)).toEqual([]);
  });

  it("refuses the print when the agent no longer serves the order's warehouse", async () => {
    const { c, tenantId, warehouseId } = await business();
    const shop = await connectShopee(c, tenantId, 726);
    const bound = await pairAgent(c, { name: "PC Jakarta", warehouseId });
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
    await rule(c, {
      name: "Dari Jakarta",
      conditions: { warehouseIds: [warehouseId] },
      actions: { arrange: "pickup", print: { deviceId: bound.id } },
    });
    // the agent is moved to Surabaya after the rule was saved
    expect((await c.patch(`/v1/print-agents/${bound.id}`, { warehouseId: surabaya.body.id })).status).toBe(200);
    const o = shopeeOrder(726, [{ model: 7261, sku: "KAOS-M", qty: 1 }]);
    await arrives(tenantId, shop, o);
    const d = await orderBy(c, o.order_sn);
    expect(d.status).toBe("ready_to_pack");
    expect(autoRuns(d)[0]!.payload).toMatchObject({
      done: ["arrange"],
      refused: [
        {
          action: "print",
          code: "print_agent.other_warehouse",
          message: "Agen cetak PC Jakarta melayani gudang lain.",
        },
      ],
    });
    expect(d.events.filter((e) => e.type === "auto_print")).toEqual([]);
    expect(await printJobsOf(c, bound.id)).toEqual([]);
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
    const nobodyAgent = "01JZZZZZZZZZZZZZZZZZZZZZZA";
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
    // a print needs an arrange, a time needs an arrange and the form JJ:MM
    expect(await refused({ name: "Cetak saja", actions: { accept: true, print: { deviceId: nobodyAgent } } })).toEqual([
      422,
      "validation.failed",
      "actions.print",
      "Cetak otomatis butuh Atur pengiriman: label baru ada setelah pengiriman diatur.",
    ]);
    expect((await refused({ name: "Jam", actions: { accept: true, arrangeAt: "13:00" } }))[2]).toBe(
      "actions.arrangeAt",
    );
    expect((await refused({ name: "Jam", actions: { arrange: "pickup", arrangeAt: "1pm" } }))[2]).toBe(
      "actions.arrangeAt",
    );
    expect((await refused({ name: "Agen", actions: { arrange: "pickup", print: { deviceId: nobodyAgent } } }))[2]).toBe(
      "actions.print.deviceId",
    );
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
      [
        1,
        "Tag besar",
        false,
        "",
        "",
        "",
        "",
        "any",
        500_000,
        null,
        false,
        null,
        "Besar",
        false,
        null,
        null,
        null,
        null,
        null,
      ],
      [
        2,
        "Pickup J&T",
        true,
        "Toko Shopee",
        "J&T",
        "",
        "KAOS-M",
        "any",
        null,
        null,
        false,
        null,
        "",
        true,
        "pickup",
        null,
        null,
        null,
        null,
      ],
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

  it("ties a printing rule to the agent's warehouse, this business's agents, and the printing permission", async () => {
    const { c, tenantId, warehouseId } = await business();
    const other = await business();
    const bound = await pairAgent(c, { name: "PC Jakarta", warehouseId });
    const any = await pairAgent(c, { name: "PC Mana Saja" });
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
    const refused = async (client: Client, body: object) => {
      const res = await client.post("/v1/order-rules", body);
      return [res.status, res.body.code, res.body.errors?.[0]?.path ?? null, res.body.errors?.[0]?.message ?? null];
    };
    // an agent of one warehouse: the rule must keep its orders there
    expect(await refused(c, { name: "Lepas", actions: { arrange: "pickup", print: { deviceId: bound.id } } })).toEqual([
      422,
      "validation.failed",
      "actions.print.deviceId",
      "Agen cetak PC Jakarta melayani satu gudang: batasi aturan ke gudang itu, atau pindahkan pesanan ke sana.",
    ]);
    expect(
      (
        await refused(c, {
          name: "Lain",
          conditions: { warehouseIds: [surabaya.body.id] },
          actions: { arrange: "pickup", print: { deviceId: bound.id } },
        })
      )[2],
    ).toBe("actions.print.deviceId");
    expect(
      (
        await c.post("/v1/order-rules", {
          name: "Ke Jakarta",
          actions: { warehouseId, arrange: "pickup", print: { deviceId: bound.id } },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await c.post("/v1/order-rules", {
          name: "Dari Jakarta",
          conditions: { warehouseIds: [warehouseId] },
          actions: { arrange: "pickup", print: { deviceId: bound.id } },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await c.post("/v1/order-rules", {
          name: "Mana saja",
          actions: { arrange: "pickup", print: { deviceId: any.id } },
        })
      ).status,
    ).toBe(201);
    // another business cannot print to this one's agent
    expect(
      await refused(other.c, { name: "Penyusup", actions: { arrange: "pickup", print: { deviceId: any.id } } }),
    ).toEqual([422, "validation.failed", "actions.print.deviceId", expect.any(String)]);
    // arranging without the printing permission
    const arranger = await member(c, tenantId, {
      name: "Pengatur",
      permissions: ["order:read", "order:accept", "shipment:arrange"],
    });
    const held = await arranger.c.post("/v1/order-rules", {
      name: "Cetak",
      actions: { arrange: "pickup", print: { deviceId: any.id } },
    });
    expect([held.status, held.body.code, held.body.detail]).toEqual([
      403,
      "order_rule.permission_not_held",
      'Aturan ini menjalankan "Cetak label dan dokumen", izin yang tidak Anda miliki.',
    ]);
    expect(
      (await arranger.c.post("/v1/order-rules", { name: "Siang", actions: { arrange: "pickup", arrangeAt: "13:00" } }))
        .status,
    ).toBe(201);
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
