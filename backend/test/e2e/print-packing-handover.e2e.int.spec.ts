import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { io, type Socket } from "socket.io-client";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDate } from "../../src/common/time-zone";
import { ExportRenderService } from "../../src/modules/exports/export-render.service";
import { A4_PAGE, THERMAL_PAGE } from "../../src/modules/fulfillment/shipping-plan";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
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
import { testHandles } from "../setup/handles";
import { MockMarketplace, type MockShopeeItem, type MockShopeeOrder } from "../setup/mock-marketplace";

/**
 * Print agents and scan to print, packing by scan, courier handover with a manifest, and who sees cost
 * prices, end to end (backend doc 8.24; PRD FR-SHP-17, FR-SHP-04, FR-SHP-05).
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 999000;
let snSeq = 1;
const nowSec = () => Math.floor(Date.now() / 1000);
const sockets: Socket[] = [];

beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  api = await startApi(h.infra, { marketplace: mock });
  hooks = await startWebhook(h.infra, { marketplace: mock });
  worker = await startWorker(h.infra, h.system, { marketplace: mock });
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
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

/** Waits for a condition that another process makes true (a push over Redis), up to 5 seconds. */
async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function business() {
  const { c, me } = await signup(api);
  const warehouseId = (await c.get("/v1/warehouses")).body.items[0].id as string;
  return { c, me, tenantId: me.tenant.id, warehouseId };
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

async function product(c: Client, sku: string, variants: { sku: string; barcode?: string }[]) {
  const res = await c.post("/v1/products", {
    sku,
    name: `Produk ${sku}`,
    variants: variants.map((v) => ({ ...v, basePrice: 50_000, costPrice: 20_000, weightG: 200 })),
  });
  expect(res.status).toBe(201);
  return Object.fromEntries((res.body.variants as { id: string; sku: string }[]).map((v) => [v.sku, v.id]));
}

async function stock(c: Client, warehouseId: string, lines: Record<string, number>) {
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

function shopeeOrder(itemId: number, lines: { model: number; sku: string; qty: number }[]): MockShopeeOrder {
  const t = nowSec();
  return {
    order_sn: `2610040${String(snSeq++).padStart(6, "0")}`,
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
  };
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

async function orderBy(c: Client, externalOrderId: string) {
  const list = (await c.get(`/v1/orders?q=${externalOrderId}`)).body.items as { id: string; externalOrderId: string }[];
  const found = list.find((o) => o.externalOrderId === externalOrderId);
  expect(found, `order ${externalOrderId}`).toBeDefined();
  return (await c.get(`/v1/orders/${found!.id}`)).body;
}

/** Shopee orders accepted and arranged, labels fetched: `label_ready`, with their tracking numbers. */
async function arranged(
  c: Client,
  tenantId: string,
  shopId: string,
  orders: MockShopeeOrder[],
  list: MockShopeeOrder[],
) {
  for (const o of list) {
    orders.push(o);
    await pushOrder(tenantId, shopId, o);
  }
  const ids: string[] = [];
  for (const o of list) ids.push((await orderBy(c, o.order_sn)).id);
  expect((await c.post("/v1/shipments/arrange", { orderIds: ids, method: "pickup" })).status).toBe(200);
  await drain(tenantId);
  const out: { id: string; sn: string; tracking: string }[] = [];
  for (const [k, o] of list.entries()) {
    const s = (await c.get(`/v1/orders/${ids[k]}/shipments`)).body.items[0];
    expect(s).toMatchObject({ status: "label_ready", labelReady: true });
    out.push({ id: ids[k]!, sn: o.order_sn, tracking: s.trackingNumber });
  }
  return out;
}

/** A print agent's REST client: its device token, not a session. */
function agentClient(token: string) {
  const ip = fakeIp();
  const auth = <T extends { set(k: string, v: string): T }>(r: T) =>
    r.set("authorization", `Bearer ${token}`).set("CF-Connecting-IP", ip);
  const server = api.getHttpServer();
  return {
    get: (url: string) => auth(request(server).get(url)),
    post: (url: string, body?: object) => auth(request(server).post(url)).send(body ?? {}),
    put: (url: string, body?: object) => auth(request(server).put(url)).send(body ?? {}),
  };
}

/** The agent's Socket.IO connection, with every event it hears. */
async function connectAgent(token: string) {
  const { port } = api.getHttpServer().address() as AddressInfo;
  const socket = io(`http://127.0.0.1:${port}`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { token },
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  const events: { event: string; payload: Record<string, unknown> }[] = [];
  socket.onAny((event: string, payload: Record<string, unknown>) => events.push({ event, payload }));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  return { socket, events };
}

async function refusedHandshake(token: string): Promise<string> {
  const { port } = api.getHttpServer().address() as AddressInfo;
  const socket = io(`http://127.0.0.1:${port}`, {
    path: "/socket.io",
    transports: ["websocket"],
    auth: { token },
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("connect", () => reject(new Error("connected")));
    socket.once("connect_error", (err: Error) => resolve(err.message));
  });
}

async function pdf(res: request.Response): Promise<PDFDocument> {
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("application/pdf");
  return PDFDocument.load(res.body as Buffer);
}
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (d: Buffer) => chunks.push(d));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

async function pairAgent(c: Client, body: object = { name: "PC Gudang Jakarta" }) {
  const paired = await c.post("/v1/print-agents", body);
  expect(paired.status).toBe(201);
  return { id: paired.body.agent.id as string, token: paired.body.token as string, agent: paired.body.agent };
}

describe("print agents (FR-SHP-17)", () => {
  it("pairs an agent, takes its printers, pushes jobs over Socket.IO, and follows each job to the end", async () => {
    const { c, tenantId } = await business();
    const gudang = await addMember(c, tenantId, "Gudang");

    // pairing needs settings:warehouse; the token is shown once
    expect((await gudang.post("/v1/print-agents", { name: "PC Gudang" })).body.code).toBe("auth.permission_denied");
    const { id, token, agent } = await pairAgent(c);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(agent).toMatchObject({ name: "PC Gudang Jakarta", connected: false, printers: [], warehouseId: null });
    // the audit log has the pairing, never the token's hash
    const audit = await h.system.db.execute<{ action: string; after: Record<string, unknown> }>(
      sql`SELECT action, after FROM audit_log WHERE entity_type = 'device' AND entity_id = ${id}`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.after).not.toHaveProperty("token_hash");

    // the agent signs in with its token; sessions and devices never cross
    const agentApi = agentClient(token);
    expect((await c.get("/v1/agent/print-jobs")).body.code).toBe("auth.device_invalid");
    expect((await agentClient("x".repeat(43)).get("/v1/agent/print-jobs")).status).toBe(401);
    expect((await agentApi.get("/v1/print-agents")).body.code).toBe("auth.required");
    expect(await refusedHandshake("y".repeat(43))).toBe("auth.device_invalid");
    const reported = await agentApi.put("/v1/agent/status", {
      appVersion: "1.0.3",
      printers: [{ name: "Zebra GK420", isDefault: true }, { name: "EPSON L3110" }],
    });
    expect(reported.status).toBe(200);
    expect(reported.body).toEqual({ id, name: "PC Gudang Jakarta", labelPrinter: null, documentPrinter: null });
    const listed = (await gudang.get("/v1/print-agents")).body.items;
    expect(listed).toEqual([
      expect.objectContaining({
        id,
        connected: true,
        appVersion: "1.0.3",
        printers: [
          { name: "Zebra GK420", isDefault: true },
          { name: "EPSON L3110", isDefault: false },
        ],
      }),
    ]);
    expect(
      (await c.patch(`/v1/print-agents/${id}`, { labelPrinter: "Zebra GK420", documentPrinter: "EPSON L3110" })).body,
    ).toMatchObject({ labelPrinter: "Zebra GK420", documentPrinter: "EPSON L3110" });

    const { events } = await connectAgent(token);

    // "Cetak percobaan": queued until the worker renders it, then pushed with the label printer
    const test = await gudang.post(`/v1/print-agents/${id}/test-print`, {});
    expect(test.status).toBe(201);
    expect(test.body).toMatchObject({
      kind: "test",
      title: "Cetak percobaan",
      status: "queued",
      waitingForDocument: true,
      printer: "Zebra GK420",
    });
    expect((await agentApi.get("/v1/agent/print-jobs")).body.items).toEqual([]);
    expect((await agentApi.get(`/v1/agent/print-jobs/${test.body.id}/file`)).body.code).toBe("print_job.not_ready");
    expect(await drain(tenantId)).toContain("document.render");
    await until(() => events.some((e) => e.event === "print.job"), "print.job");
    expect(events).toEqual([
      {
        event: "print.job",
        payload: expect.objectContaining({ id: test.body.id, kind: "test", printer: "Zebra GK420", copies: 1 }),
      },
    ]);
    expect((await agentApi.get("/v1/agent/print-jobs")).body.items.map((j: { id: string }) => j.id)).toEqual([
      test.body.id,
    ]);

    // the agent takes the file (sent), prints, and reports
    const page = await pdf(await binary(agentApi.get(`/v1/agent/print-jobs/${test.body.id}/file`)));
    expect(page.getPage(0).getSize()).toEqual({ width: THERMAL_PAGE.width, height: THERMAL_PAGE.height });
    expect((await c.get(`/v1/print-jobs/${test.body.id}`)).body).toMatchObject({ status: "sent", attempts: 1 });
    // taken again after a restart: still sent, not counted twice
    expect((await binary(agentApi.get(`/v1/agent/print-jobs/${test.body.id}/file`))).status).toBe(200);
    const printed = await agentApi.post(`/v1/agent/print-jobs/${test.body.id}/result`, { status: "printed" });
    expect(printed.body).toEqual({ id: test.body.id, status: "printed" });
    expect((await agentApi.post(`/v1/agent/print-jobs/${test.body.id}/result`, { status: "printed" })).status).toBe(
      200,
    );
    expect((await agentApi.post(`/v1/agent/print-jobs/${test.body.id}/result`, { status: "failed" })).body.code).toBe(
      "print_job.not_pending",
    );
    expect((await c.get(`/v1/print-jobs/${test.body.id}`)).body).toMatchObject({
      status: "printed",
      attempts: 1,
      error: null,
    });
    expect((await agentApi.get(`/v1/agent/print-jobs/${test.body.id}/file`)).body.code).toBe("print_job.not_pending");

    // a printer jam: failed with the printer's words, then "Cetak ulang" sends it again
    const again = (await gudang.post(`/v1/print-agents/${id}/test-print`, { printer: "EPSON L3110" })).body;
    await drain(tenantId);
    await until(() => events.filter((e) => e.event === "print.job").length === 2, "second print.job");
    await binary(agentApi.get(`/v1/agent/print-jobs/${again.id}/file`));
    await agentApi.post(`/v1/agent/print-jobs/${again.id}/result`, { status: "failed", error: "Kertas habis" });
    expect((await c.get("/v1/print-jobs?status=failed")).body.items).toEqual([
      expect.objectContaining({ id: again.id, printer: "EPSON L3110", error: "Kertas habis" }),
    ]);
    expect((await c.post(`/v1/print-jobs/${test.body.id}/retry`)).body.code).toBe("print_job.not_retryable");
    expect((await gudang.post(`/v1/print-jobs/${again.id}/retry`)).body).toMatchObject({
      status: "queued",
      error: null,
    });
    await until(() => events.filter((e) => e.event === "print.job").length === 3, "retried print.job");
    await binary(agentApi.get(`/v1/agent/print-jobs/${again.id}/file`));
    expect((await c.get(`/v1/print-jobs/${again.id}`)).body).toMatchObject({ status: "sent", attempts: 2 });

    // cancelled before it printed: the agent hears it and can no longer take the file
    expect((await c.post(`/v1/print-jobs/${again.id}/cancel`)).body).toMatchObject({ status: "cancelled" });
    await until(() => events.some((e) => e.event === "print.cancelled"), "print.cancelled");
    expect((await agentApi.post(`/v1/agent/print-jobs/${again.id}/result`, { status: "printed" })).body.code).toBe(
      "print_job.not_pending",
    );

    // revoked: open jobs are cancelled, the token stops working, the connection closes
    const pending = (await gudang.post(`/v1/print-agents/${id}/test-print`, {})).body;
    const revokedSocket = (await connectAgent(token)).socket;
    expect((await gudang.delete(`/v1/print-agents/${id}`)).body.code).toBe("auth.permission_denied");
    expect((await c.delete(`/v1/print-agents/${id}`)).status).toBe(204);
    expect((await c.get(`/v1/print-jobs/${pending.id}`)).body).toMatchObject({
      status: "cancelled",
      error: "Agen cetak dicabut.",
    });
    await until(() => !revokedSocket.connected, "revoked socket closed");
    expect((await agentApi.put("/v1/agent/status", { appVersion: "1.0.3", printers: [] })).status).toBe(401);
    expect(await refusedHandshake(token)).toBe("auth.device_invalid");
    expect((await c.get("/v1/print-agents")).body.items).toEqual([]);
    expect((await c.get(`/v1/print-agents/${id}`)).body.code).toBe("print_agent.not_found");
    // the worker renders the cancelled job's document without pushing it anywhere
    await drain(tenantId);
    expect((await c.get(`/v1/print-jobs/${pending.id}`)).body.status).toBe("cancelled");
  });

  it("keeps agents to their warehouse and to their business", async () => {
    const { c, tenantId, warehouseId } = await business();
    const other = (await c.post("/v1/warehouses", { code: "SBY", name: "Gudang Surabaya" })).body.id as string;
    const jakarta = await pairAgent(c, { name: "PC Jakarta", warehouseId });
    const surabaya = await pairAgent(c, { name: "PC Surabaya", warehouseId: other });
    const shared = await pairAgent(c, { name: "Laptop Kasir" });
    const gudang = await addMember(c, tenantId, "Gudang");
    const me = (await gudang.get("/v1/me")).body.user.id as string;
    expect((await c.put(`/v1/users/${me}/scopes`, { warehouseIds: [warehouseId] })).status).toBe(200);
    expect(((await gudang.get("/v1/print-agents")).body.items as { id: string }[]).map((a) => a.id).sort()).toEqual(
      [jakarta.id, shared.id].sort(),
    );
    expect((await gudang.post(`/v1/print-agents/${surabaya.id}/test-print`, {})).body.code).toBe(
      "print_agent.not_found",
    );
    const mine = (await gudang.post(`/v1/print-agents/${jakarta.id}/test-print`, {})).body;
    expect(
      (await gudang.post("/v1/print-jobs", { documentId: mine.documentId, deviceId: surabaya.id })).body,
    ).toMatchObject({
      code: "validation.failed",
      errors: [{ path: "deviceId" }],
    });
    expect((await c.post("/v1/print-agents", { name: "X", warehouseId: "01K6Z0000000000000000000ZZ" })).status).toBe(
      422,
    );

    // a suspended business's agents are refused like its users
    await h.system.db.execute(sql`UPDATE tenant SET status = 'suspended' WHERE id = ${tenantId}`);
    expect((await agentClient(shared.token).get("/v1/agent/print-jobs")).body.code).toBe("tenant.inactive");
    expect(await refusedHandshake(shared.token)).toBe("tenant.inactive");
    await h.system.db.execute(sql`UPDATE tenant SET status = 'active' WHERE id = ${tenantId}`);

    // another business's agent sees nothing of this one
    const b = await business();
    const theirs = await pairAgent(b.c);
    const job = (await c.post(`/v1/print-agents/${jakarta.id}/test-print`, {})).body;
    await drain(tenantId);
    // a user limited to a warehouse sees their own print requests only, like documents
    const own = (await gudang.post(`/v1/print-agents/${jakarta.id}/test-print`, {})).body;
    expect(((await gudang.get("/v1/print-jobs")).body.items as { id: string }[]).map((j) => j.id)).toEqual([
      own.id,
      mine.id,
    ]);
    expect((await gudang.get(`/v1/print-jobs/${job.id}`)).body.code).toBe("print_job.not_found");
    expect(((await c.get("/v1/print-jobs")).body.items as { id: string }[]).map((j) => j.id)).toEqual([
      own.id,
      job.id,
      mine.id,
    ]);
    const stranger = agentClient(theirs.token);
    expect((await stranger.get("/v1/agent/print-jobs")).body.items).toEqual([]);
    expect((await stranger.get(`/v1/agent/print-jobs/${job.id}/file`)).body.code).toBe("print_job.not_found");
    expect((await stranger.post(`/v1/agent/print-jobs/${job.id}/result`, { status: "printed" })).status).toBe(404);
    expect((await b.c.post("/v1/print-jobs", { documentId: job.documentId, deviceId: theirs.id })).status).toBe(404);
  });
});

describe("scan to print (FR-SHP-17)", () => {
  it("prints the label of a scanned tracking number or order number on the agent, without a dialog", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", [{ sku: "KAOS-M" }, { sku: "KAOS-L" }]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 10, [v["KAOS-L"]!]: 10 });
    const { shopId, orders } = await connectShopee(c, tenantId, 801);
    const [a] = await arranged(c, tenantId, shopId, orders, [
      shopeeOrder(801, [{ model: 8011, sku: "KAOS-M", qty: 1 }]),
    ]);
    const { id: agentId, token } = await pairAgent(c);
    await c.patch(`/v1/print-agents/${agentId}`, { labelPrinter: "Zebra GK420", documentPrinter: "EPSON L3110" });
    const gudang = await addMember(c, tenantId, "Gudang");
    const { events } = await connectAgent(token);

    const scanned = await gudang.post("/v1/print-jobs/scan", {
      code: ` ${a!.tracking.toLowerCase()} `,
      deviceId: agentId,
    });
    expect(scanned.status).toBe(201);
    expect(scanned.body).toMatchObject({
      order: { id: a!.id, number: a!.sn, status: "ready_to_pack", courier: "SPX Standard" },
      printJob: { kind: "label", title: `Label ${a!.sn}`, status: "queued", printer: "Zebra GK420" },
    });
    await drain(tenantId);
    await until(() => events.length === 1, "label pushed");
    expect(events[0]).toMatchObject({ event: "print.job", payload: { id: scanned.body.printJob.id } });
    const label = await pdf(
      await binary(agentClient(token).get(`/v1/agent/print-jobs/${scanned.body.printJob.id}/file`)),
    );
    expect(label.getPageCount()).toBe(1);
    // the document behind the job is the usual labels document, with its print job
    expect((await c.get(`/v1/documents/${scanned.body.documentId}`)).body).toMatchObject({
      kind: "labels",
      status: "ready",
      printJob: { id: scanned.body.printJob.id, status: "sent" },
    });

    // by order number too; A4 labels go to the document printer
    const byNumber = await gudang.post("/v1/print-jobs/scan", { code: a!.sn, deviceId: agentId, format: "a4" });
    expect(byNumber.body.printJob).toMatchObject({ printer: "EPSON L3110" });

    // what cannot print says why
    expect((await gudang.post("/v1/print-jobs/scan", { code: "TIDAKADA123", deviceId: agentId })).body.code).toBe(
      "scan.not_found",
    );
    const fresh = shopeeOrder(801, [{ model: 8012, sku: "KAOS-L", qty: 1 }]);
    orders.push(fresh);
    await pushOrder(tenantId, shopId, fresh);
    const notArranged = await gudang.post("/v1/print-jobs/scan", { code: fresh.order_sn, deviceId: agentId });
    expect(notArranged.status).toBe(409);
    expect(notArranged.body).toMatchObject({ code: "shipment.not_arranged", detail: "Pengiriman belum diatur." });
    // a code that fits two orders asks for the parcel's own number
    const freshId = (await orderBy(c, fresh.order_sn)).id as string;
    await h.system.db.execute(sql`UPDATE "order" SET tracking_number = 'KEMBAR123' WHERE id IN (${a!.id}, ${freshId})`);
    expect((await gudang.post("/v1/print-jobs/scan", { code: "KEMBAR123", deviceId: agentId })).body.code).toBe(
      "scan.ambiguous",
    );
    await h.system.db.execute(sql`UPDATE "order" SET tracking_number = NULL WHERE id = ${freshId}`);
    expect(
      (await gudang.post("/v1/print-jobs/scan", { code: a!.sn, deviceId: "01K6Z0000000000000000000ZZ" })).body,
    ).toMatchObject({ code: "validation.failed", errors: [{ path: "deviceId" }] });

    // L07: a pick list printed on the agent's A4 printer as soon as the worker makes it
    const doc = await gudang.post("/v1/documents", {
      kind: "pick_list",
      orderIds: [a!.id],
      print: { deviceId: agentId, copies: 2 },
    });
    expect(doc.status).toBe(202);
    expect(doc.body.printJob).toMatchObject({
      kind: "pick_list",
      title: "Daftar ambil 1 pesanan",
      printer: "EPSON L3110",
      copies: 2,
      waitingForDocument: true,
    });
    await drain(tenantId);
    await until(() => events.filter((e) => e.event === "print.job").length === 3, "pick list pushed");
    const reprint = await gudang.post("/v1/print-jobs", { documentId: doc.body.id, deviceId: agentId });
    expect(reprint.body).toMatchObject({
      status: "queued",
      waitingForDocument: false,
      title: "Daftar ambil 1 pesanan",
    });
    await until(() => events.filter((e) => e.event === "print.job").length === 4, "reprint pushed");
  });
});

describe("packing by scan (FR-SHP-04)", () => {
  it("checks every item against the order, refuses a wrong SKU or quantity, then packs and prints the label", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", [{ sku: "KAOS-M", barcode: "8991234567891" }, { sku: "KAOS-L" }]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 10, [v["KAOS-L"]!]: 10 });
    const { shopId, orders } = await connectShopee(c, tenantId, 802);
    const [a] = await arranged(c, tenantId, shopId, orders, [
      shopeeOrder(802, [
        { model: 8021, sku: "KAOS-M", qty: 2 },
        { model: 8022, sku: "KAOS-L", qty: 1 },
      ]),
    ]);
    const { id: agentId, token } = await pairAgent(c);
    const { events } = await connectAgent(token);
    const gudang = await addMember(c, tenantId, "Gudang");

    const view = (await gudang.get(`/v1/packing/lookup?code=${a!.tracking}`)).body;
    expect(view).toMatchObject({
      order: { id: a!.id, number: a!.sn, status: "ready_to_pack", note: null },
      packable: true,
      packRefusal: null,
      labelRefusal: null,
    });
    expect(view.lines).toEqual([
      expect.objectContaining({ key: v["KAOS-M"], sku: "KAOS-M", barcode: "8991234567891", qty: 2 }),
      expect.objectContaining({ key: v["KAOS-L"], sku: "KAOS-L", barcode: null, qty: 1 }),
    ]);

    // a wrong item and a missing one: refused with what differs, nothing packed
    const wrong = await gudang.post(`/v1/packing/orders/${a!.id}/complete`, {
      scans: [
        { code: "8991234567891", qty: 2 },
        { code: "TOPI-01", qty: 1 },
      ],
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body).toMatchObject({
      code: "packing.mismatch",
      unknown: ["TOPI-01"],
      lines: [{ key: v["KAOS-L"], expected: 1, scanned: 0 }],
    });
    const over = await gudang.post(`/v1/packing/orders/${a!.id}/complete`, {
      scans: [{ code: "8991234567891", qty: 3 }, { code: "kaos-l" }],
    });
    expect(over.body).toMatchObject({ code: "packing.mismatch", detail: "Jumlah barang belum cocok dengan pesanan." });
    expect((await orderBy(c, a!.sn)).status).toBe("ready_to_pack");

    // everything matches: packed, and "Cetak label dan lanjut" sends the label to the station's agent
    const done = await gudang.post(`/v1/packing/orders/${a!.id}/complete`, {
      scans: [{ code: "8991234567891" }, { code: "KAOS-M" }, { code: "kaos-l" }],
      print: { deviceId: agentId },
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      order: { id: a!.id, status: "packed" },
      printJob: { kind: "label", title: `Label ${a!.sn}` },
      printRefusal: null,
    });
    await drain(tenantId);
    await until(() => events.length === 1, "label pushed");
    const order = await orderBy(c, a!.sn);
    expect(order.status).toBe("ready_to_ship");
    expect(order.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toStatus: "packed", payload: { verified: "scan", units: 3 } }),
      ]),
    );
    expect((await c.get(`/v1/orders/${a!.id}/shipments`)).body.items[0].status).toBe("packed");

    // scanned again: not packable any more, and the station says why before any item is scanned
    expect((await gudang.get(`/v1/packing/lookup?code=${a!.sn}`)).body).toMatchObject({
      packable: false,
      packRefusal: { code: "order.status_invalid" },
    });
    expect(
      (
        await gudang.post(`/v1/packing/orders/${a!.id}/complete`, {
          scans: [{ code: "KAOS-M", qty: 2 }, { code: "KAOS-L" }],
        })
      ).body.code,
    ).toBe("order.status_invalid");
    expect((await gudang.get("/v1/packing/lookup?code=TIDAKADA")).body.code).toBe("scan.not_found");

    // packed before the label exists: the order is packed, the label waits
    const late = shopeeOrder(802, [{ model: 8021, sku: "KAOS-M", qty: 1 }]);
    orders.push(late);
    await pushOrder(tenantId, shopId, late);
    const lateId = (await orderBy(c, late.order_sn)).id;
    await c.post("/v1/orders/accept", { orderIds: [lateId] });
    expect((await gudang.get(`/v1/packing/lookup?code=${late.order_sn}`)).body).toMatchObject({
      packable: true,
      labelRefusal: { code: "shipment.not_arranged" },
    });
    const noLabel = await gudang.post(`/v1/packing/orders/${lateId}/complete`, {
      scans: [{ code: v["KAOS-M"]! }],
      print: { deviceId: agentId },
    });
    expect(noLabel.body).toMatchObject({
      order: { status: "packed" },
      printJob: null,
      printRefusal: { code: "shipment.not_arranged" },
    });
  });
});

describe("courier handover (FR-SHP-05)", () => {
  it("scans parcels into the courier's manifest, refuses what may not go, hands them over, and prints the manifest", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", [{ sku: "KAOS-M" }, { sku: "KAOS-L" }]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 20, [v["KAOS-L"]!]: 20 });
    const { shopId, orders } = await connectShopee(c, tenantId, 803);
    const parcels = await arranged(c, tenantId, shopId, orders, [
      shopeeOrder(803, [{ model: 8031, sku: "KAOS-M", qty: 1 }]),
      shopeeOrder(803, [{ model: 8032, sku: "KAOS-L", qty: 1 }]),
      shopeeOrder(803, [{ model: 8031, sku: "KAOS-M", qty: 1 }]),
      shopeeOrder(803, [{ model: 8031, sku: "KAOS-M", qty: 1 }]),
    ]);
    const [p1, p2, p3, unpacked] = parcels as [
      (typeof parcels)[0],
      (typeof parcels)[0],
      (typeof parcels)[0],
      (typeof parcels)[0],
    ];
    expect(
      (await c.post("/v1/orders/pack", { orderIds: [p1.id, p2.id, p3.id] })).body.items.every(
        (r: { ok: boolean }) => r.ok,
      ),
    ).toBe(true);
    await drain(tenantId);
    // a manual order packed for the same courier
    const manual = await c.post("/v1/orders/manual", {
      buyer: { name: "Rudi", phone: "081234567890" },
      shippingAddress: { line1: "Jl. Melati 2", city: "Jakarta Selatan", province: "DKI JAKARTA" },
      items: [{ variantId: v["KAOS-L"], qty: 2 }],
      paymentMethod: "cash",
      shippingProvider: "SPX Standard",
    });
    expect(manual.status).toBe(201);
    await c.post("/v1/orders/accept", { orderIds: [manual.body.id] });
    await c.post("/v1/orders/pack", { orderIds: [manual.body.id] });
    const handoverMember = await addMember(c, tenantId, "Gudang");

    expect((await handoverMember.get(`/v1/handovers/couriers?warehouseId=${warehouseId}`)).body.items).toEqual([
      { courier: "SPX Standard", parcels: 4 },
    ]);

    // one open manifest per warehouse and courier: two stations share it
    const opened = await handoverMember.post("/v1/handovers", { warehouseId, courier: "SPX Standard" });
    expect(opened.status).toBe(201);
    const period = localDate("Asia/Jakarta", new Date()).slice(2, 7).replace("-", "");
    expect(opened.body).toMatchObject({ number: `MNF-${period}-0001`, status: "open", parcels: 0 });
    const hid = opened.body.id as string;
    expect((await c.post("/v1/handovers", { warehouseId, courier: "spx standard" })).body.id).toBe(hid);

    const scan = (code: string) => handoverMember.post(`/v1/handovers/${hid}/scan`, { code });
    expect((await scan(p1.tracking)).body).toMatchObject({
      parcels: 1,
      duplicate: false,
      item: { trackingNumber: p1.tracking, orderNumber: p1.sn },
    });
    expect((await scan(p1.tracking)).body).toMatchObject({ parcels: 1, duplicate: true });
    // by order number, the parcel's tracking number goes on the manifest
    expect((await scan(p2.sn)).body).toMatchObject({ parcels: 2, item: { trackingNumber: p2.tracking } });
    expect((await scan(manual.body.externalOrderId)).body).toMatchObject({ parcels: 3 });
    const third = await scan(p3.tracking);
    expect(third.body.parcels).toBe(4);

    // what may not go is refused with the reason
    expect((await scan(unpacked.tracking)).body).toMatchObject({
      code: "handover.not_packed",
      detail: "Pesanan ini belum dikemas.",
    });
    expect((await scan("TIDAKADA")).body.code).toBe("scan.not_found");
    const jnt = (await handoverMember.post("/v1/handovers", { warehouseId, courier: "J&T Express" })).body;
    expect(jnt.id).not.toBe(hid);
    expect((await handoverMember.post(`/v1/handovers/${jnt.id}/scan`, { code: p1.tracking })).body).toMatchObject({
      code: "handover.scanned_elsewhere",
      detail: `Paket ini sudah dipindai di manifest ${opened.body.number}.`,
    });

    // a parcel scanned by mistake comes out, and can go to the right courier's manifest... which it does not match
    expect((await handoverMember.delete(`/v1/handovers/${hid}/items/${third.body.item.id}`)).body).toMatchObject({
      parcels: 3,
    });
    expect((await handoverMember.post(`/v1/handovers/${jnt.id}/scan`, { code: p3.tracking })).body).toMatchObject({
      code: "handover.courier_mismatch",
      detail: "Paket ini untuk SPX Standard, bukan J&T Express.",
    });
    expect((await handoverMember.post(`/v1/handovers/${jnt.id}/cancel`)).body.status).toBe("cancelled");
    expect((await handoverMember.post(`/v1/handovers/${jnt.id}/scan`, { code: p3.tracking })).body.code).toBe(
      "handover.not_open",
    );

    // the buyer cancels one parcel after its scan: completing refuses until it comes out
    const cancelled = orders.find((o) => o.order_sn === p2.sn)!;
    cancelled.order_status = "CANCELLED";
    // strictly newer than what the marketplace last said, even within the same second
    cancelled.update_time = Math.max(nowSec(), cancelled.update_time + 1);
    await pushOrder(tenantId, shopId, cancelled);
    const refused = await handoverMember.post(`/v1/handovers/${hid}/complete`, { receivedBy: "Andi" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: "handover.items_invalid",
      items: [{ trackingNumber: p2.tracking, code: "handover.cancelled" }],
    });
    const detail = (await handoverMember.get(`/v1/handovers/${hid}`)).body;
    const p2Item = detail.items.find((i: { orderNumber: string }) => i.orderNumber === p2.sn);
    await handoverMember.delete(`/v1/handovers/${hid}/items/${p2Item.id}`);

    // completed: marketplace parcels handed over, the manual order shipped, the manifest printed
    const { id: agentId, token } = await pairAgent(c);
    const { events } = await connectAgent(token);
    const done = await handoverMember.post(`/v1/handovers/${hid}/complete`, {
      receivedBy: "Andi",
      print: { deviceId: agentId },
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      handover: { id: hid, status: "completed", parcels: 2, receivedBy: "Andi" },
      document: { kind: "handover_manifest", status: "queued" },
      printJob: { kind: "manifest", title: `Manifest ${opened.body.number}` },
    });
    expect((await c.get(`/v1/orders/${p1.id}/shipments`)).body.items[0].status).toBe("handed_over");
    expect((await orderBy(c, p1.sn)).events.map((e: { type: string }) => e.type)).toContain("handed_over");
    const shipped = (await c.get(`/v1/orders/${manual.body.id}`)).body;
    expect(shipped).toMatchObject({ status: "shipped", shippingProvider: "SPX Standard" });
    expect((await handoverMember.post(`/v1/handovers/${hid}/scan`, { code: p3.tracking })).body.code).toBe(
      "handover.not_open",
    );

    await drain(tenantId);
    await until(() => events.length === 1, "manifest pushed");
    const manifest = await pdf(
      await binary(agentClient(token).get(`/v1/agent/print-jobs/${done.body.printJob.id}/file`)),
    );
    expect(manifest.getPage(0).getSize()).toEqual({ width: A4_PAGE.width, height: A4_PAGE.height });
    expect(manifest.getTitle()).toBe(`Manifest ${opened.body.number}`);
    const again = await c.post(`/v1/handovers/${hid}/manifest`, {});
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ document: { kind: "handover_manifest" }, printJob: null });

    // history, newest first; the courier's scan at pickup moves the parcel on
    expect((await handoverMember.get("/v1/handovers?status=completed")).body.items).toEqual([
      expect.objectContaining({ id: hid, parcels: 2, receivedBy: "Andi" }),
    ]);
    const picked = orders.find((o) => o.order_sn === p1.sn)!;
    picked.order_status = "SHIPPED";
    picked.update_time = Math.max(nowSec(), picked.update_time + 1);
    await pushOrder(tenantId, shopId, picked);
    expect((await orderBy(c, p1.sn)).status).toBe("shipped");
    expect((await c.get(`/v1/orders/${p1.id}/shipments`)).body.items[0].status).toBe("in_transit");

    // the full data export carries the manifests
    expect(
      worker.ctx
        .get(ExportRenderService, { strict: false })
        .sheets()
        .map((s) => s.file),
    ).toContain("serah_terima.csv");
  });
});

describe("cost prices (UI L41)", () => {
  it("hides HPP and what reveals it from roles without finance:read", async () => {
    const { c, tenantId, warehouseId } = await business();
    const v = await product(c, "KAOS", [{ sku: "KAOS-M" }]);
    await stock(c, warehouseId, { [v["KAOS-M"]!]: 10 });
    const productId = (await c.get("/v1/products?q=KAOS")).body.items[0].id as string;
    await c.patch(`/v1/products/${productId}/variants/${v["KAOS-M"]}`, { costPrice: 22_000, basePrice: 55_000 });
    const gudang = await addMember(c, tenantId, "Gudang");
    const finance = await addMember(c, tenantId, "Finance");

    expect((await c.get(`/v1/products/${productId}`)).body.variants[0].costPrice).toBe(22_000);
    expect((await finance.get(`/v1/products/${productId}`)).body.variants[0].costPrice).toBe(22_000);
    const seen = (await gudang.get(`/v1/products/${productId}`)).body.variants[0];
    expect(seen).toMatchObject({ costPrice: null, basePrice: 55_000 });
    expect((await gudang.get("/v1/products")).body.items[0].variants[0].costPrice).toBeNull();

    // the history keeps the change of HPP but not its values
    const history = (await gudang.get(`/v1/products/${productId}/history`)).body.items[0];
    expect(history.changes).toEqual([
      { field: "costPrice", label: "HPP", before: null, after: null, hidden: true },
      { field: "basePrice", label: "Harga dasar", before: 50_000, after: 55_000 },
    ]);
    expect((await c.get(`/v1/products/${productId}/history`)).body.items[0].changes[0]).toMatchObject({
      before: 20_000,
      after: 22_000,
    });

    // the CSV export leaves the column empty (importing it again keeps the HPP), and the stock value goes
    const csv = (await gudang.get("/v1/products/export")).text.split("\r\n");
    const header = csv[0]!.replace("﻿", "").split(";");
    const row = csv[1]!.split(";");
    expect(row[header.indexOf("hpp")]).toBe("");
    expect((await c.get("/v1/products/export")).text.split("\r\n")[1]!.split(";")[header.indexOf("hpp")]).toBe("22000");
    expect((await gudang.get("/v1/inventory/summary")).body).toMatchObject({ skus: 1, value: null });
    expect((await c.get("/v1/inventory/summary")).body).toMatchObject({ skus: 1, value: 220_000 });
  });
});
