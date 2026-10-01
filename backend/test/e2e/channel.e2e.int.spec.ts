import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOB_REGISTRY, QUEUES } from "../../src/infra/tokens";
import { jobKey } from "../../src/jobs/job-id";
import type { QueueRegistry } from "../../src/jobs/queues";
import type { JobRegistry } from "../../src/jobs/registry";
import { storeTokenRefreshJob, storeWarehousesSyncJob } from "../../src/modules/channel/channel.jobs";
import { CredentialService } from "../../src/modules/channel/credential.service";
import { StoresService } from "../../src/modules/channel/stores.service";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
import { scanTokenRefresh, scanWarehousePolls, sweepWebhookInbox } from "../../src/scheduler/channel-scans";
import { type Client, signup, startApi, startWebhook, startWorker, WEB_URL, WEBHOOK_URL } from "../setup/app";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace, SHOPEE, TIKTOK } from "../setup/mock-marketplace";

/**
 * Store connection end to end (PRD 6.1, 6.3.1; backend doc 8.6): api, worker, webhook process, and
 * scheduler scans against a fake marketplace that enforces the documented signatures and token rules.
 */
const h = testHandles();
let mock: MockMarketplace;
let api: INestApplication;
let hooks: NestExpressApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;

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

/** Runs outbox jobs until none are left (a job may emit events that queue more). */
async function drain(tenantId: string): Promise<string[]> {
  const ran: string[] = [];
  for (let i = 0; i < 5; i++) {
    const round = await worker.runOutbox(tenantId);
    if (round.length === 0) break;
    ran.push(...round);
  }
  return ran;
}

function stateOf(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get("state")!;
}

async function connectShopee(c: Client, tenantId: string, shopId: string, storeId?: string) {
  const started = await c.post("/v1/store-authorizations", { channel: "shopee", ...(storeId ? { storeId } : {}) });
  expect(started.status).toBe(201);
  const cb = await c.post("/v1/store-authorizations/callback", {
    channel: "shopee",
    state: stateOf(started.body.authorizeUrl),
    code: mock.shopeeCode({ shopId }),
    shopId,
  });
  expect(cb.status).toBe(202);
  await drain(tenantId);
  return (await c.get(`/v1/store-authorizations/${started.body.id}`)).body;
}

async function sql1<T>(q: ReturnType<typeof sql>): Promise<T | undefined> {
  return (await h.system.db.execute(q)).rows[0] as T | undefined;
}

/** Makes the store's access token due for a refresh (past 80% of its lifetime). */
async function makeDue(storeId: string) {
  await h.system.db.execute(sql`UPDATE store_credential
      SET access_expires_at = now() + interval '1 minute', last_refreshed_at = now() - interval '4 hours'
    WHERE store_id = ${storeId}`);
}

function shopeePush(body: object) {
  const raw = JSON.stringify(body);
  return request(hooks.getHttpServer())
    .post("/webhooks/shopee")
    .set("content-type", "application/json")
    .set("authorization", mock.signShopeePush(`${WEBHOOK_URL}/webhooks/shopee`, raw))
    .send(raw);
}

describe("channels", () => {
  it("lists the marketplaces, shown as sellers know them", async () => {
    const { c } = await signup(api);
    const res = await c.get("/v1/channels");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { id: "shopee", name: "Shopee", available: true, regions: ["ID"] },
      { id: "tiktokshop", name: "Tokopedia & Shop", available: true, regions: ["ID"] },
    ]);
  });
});

describe("connecting a Shopee shop", () => {
  it("authorizes, exchanges the code in the worker, seals the tokens, and imports the warehouse", async () => {
    const { c, me } = await signup(api, { businessName: "Rina Fashion" });
    const tenantId = me.tenant.id;
    mock.addShopeeShop({
      shopId: "500001",
      name: "Rina Fashion Official",
      region: "ID",
      warehouses: "not_whitelisted",
    });

    const started = await c.post("/v1/store-authorizations", { channel: "shopee" });
    expect(started.status).toBe(201);
    const link = new URL(started.body.authorizeUrl);
    expect(link.pathname).toBe("/auth");
    expect(Object.fromEntries(link.searchParams)).toMatchObject({
      partner_id: String(SHOPEE.partnerId),
      auth_type: "seller",
      response_type: "code",
      redirect_uri: `${WEB_URL}/integrasi/callback/shopee`,
    });
    expect(link.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.body.status).toBe("pending");

    const cb = await c.post("/v1/store-authorizations/callback", {
      channel: "shopee",
      state: link.searchParams.get("state"),
      code: mock.shopeeCode({ shopId: "500001" }),
      shopId: "500001",
    });
    expect(cb.status).toBe(202);
    expect(cb.body.status).toBe("exchanging");

    const ran = await drain(tenantId);
    expect(ran).toEqual(
      expect.arrayContaining(["store.authorize", "store.warehouses_sync", "store.webhooks_subscribe"]),
    );

    const done = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body;
    expect(done.status).toBe("succeeded");
    expect(done.result.stores).toHaveLength(1);
    const storeId = done.result.stores[0].storeId as string;

    const store = (await c.get(`/v1/stores/${storeId}`)).body;
    expect(store).toMatchObject({
      channel: "shopee",
      channelName: "Shopee",
      externalShopId: "500001",
      name: "Rina Fashion Official",
      region: "ID",
      status: "active",
      syncMode: "read_only",
      tokenRefreshFailures: 0,
      unmappedWarehouses: 0,
    });
    expect(store.marketplaceInfo.logo).toContain("500001");
    expect(Date.parse(store.accessTokenExpiresAt) - Date.now()).toBeGreaterThan(3.9 * 3600_000);
    expect(store.authorizationExpiresAt).not.toBeNull();

    // One shop-level warehouse, mapped automatically to the business's only warehouse (FR-WHS-03).
    const warehouses = (await c.get("/v1/warehouses")).body.items as { id: string }[];
    const cws = (await c.get(`/v1/stores/${storeId}/channel-warehouses`)).body.items;
    expect(cws).toEqual([
      expect.objectContaining({
        externalWarehouseId: "default",
        kind: "seller",
        mappingStatus: "mapped",
        warehouseId: warehouses[0]!.id,
        address: expect.objectContaining({ city: "Jakarta Barat" }),
      }),
    ]);

    // Tokens are sealed with the tenant's DEK; none of the issued tokens appears in the row.
    const cred = await sql1<{ access_token_enc: Buffer; refresh_token_enc: Buffer; dek_version: number }>(
      sql`SELECT access_token_enc, refresh_token_enc, dek_version FROM store_credential WHERE store_id = ${storeId}`,
    );
    expect(cred!.access_token_enc[0]).toBe(1);
    for (const t of mock.issued) {
      expect(cred!.access_token_enc.includes(Buffer.from(t))).toBe(false);
      expect(cred!.refresh_token_enc.includes(Buffer.from(t))).toBe(false);
    }
    const key = await sql1<{ provider: string; version: number }>(
      sql`SELECT provider, version FROM tenant_key WHERE tenant_id = ${tenantId}`,
    );
    expect(key).toEqual({ provider: "local", version: cred!.dek_version });
    const apiRole = await h.raw("api");
    await expect(apiRole.query("SELECT wrapped_dek FROM tenant_key")).rejects.toMatchObject({ code: "42501" });
    await expect(apiRole.query("SELECT shop_cipher FROM store_credential")).rejects.toMatchObject({ code: "42501" });

    // The sync log shows the warehouse pull with its calls, secrets masked.
    const log = (await c.get(`/v1/stores/${storeId}/sync-jobs`)).body.items as {
      kind: string;
      status: string;
      calls: { path: string }[];
    }[];
    const pull = log.find((j) => j.kind === "warehouses.pull")!;
    expect(pull.status).toBe("succeeded");
    expect(pull.calls.map((x) => x.path.split("?")[0])).toEqual([
      "/api/v2/shop/get_shop_info",
      "/api/v2/shop/get_warehouse_detail",
      "/api/v2/logistics/get_address_list",
    ]);
    for (const call of pull.calls) expect(call.path).toContain("access_token=%5Bredacted%5D");

    // The connection is audited as the user who started it, not as the system.
    const audit = await sql1<{ actor_type: string; actor_id: string }>(
      sql`SELECT actor_type, actor_id FROM audit_log WHERE entity_type = 'store' AND entity_id = ${storeId} AND action = 'insert'`,
    );
    expect(audit).toEqual({ actor_type: "user", actor_id: me.user.id });
  });

  it("connects every Indonesian shop of a main account and skips shops of other regions", async () => {
    const { c, me } = await signup(api);
    mock.addShopeeShop({ shopId: "510001", name: "Toko ID", region: "ID", warehouses: "not_whitelisted" });
    mock.addShopeeShop({ shopId: "510002", name: "Toko MY", region: "MY", warehouses: "not_whitelisted" });
    const started = await c.post("/v1/store-authorizations", { channel: "shopee" });
    await c.post("/v1/store-authorizations/callback", {
      channel: "shopee",
      state: stateOf(started.body.authorizeUrl),
      code: mock.shopeeCode({ mainAccountId: "9001", shopIds: ["510001", "510002"] }),
      mainAccountId: "9001",
    });
    await drain(me.tenant.id);
    const done = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body;
    expect(done.status).toBe("succeeded");
    expect(done.result.stores.map((s: { externalShopId: string }) => s.externalShopId)).toEqual(["510001"]);
    expect(done.result.skipped).toEqual([{ externalShopId: "510002", region: "MY", reason: "region_not_supported" }]);
    expect((await c.get("/v1/stores")).body.items).toHaveLength(1);
  });

  it("refuses a shop already connected to another business", async () => {
    const a = await signup(api);
    mock.addShopeeShop({ shopId: "520001", name: "Toko Rebutan", region: "ID", warehouses: "not_whitelisted" });
    expect((await connectShopee(a.c, a.me.tenant.id, "520001")).status).toBe("succeeded");
    const b = await signup(api);
    const attempt = await connectShopee(b.c, b.me.tenant.id, "520001");
    expect(attempt).toMatchObject({ status: "failed", errorCode: "shop_connected_elsewhere" });
    expect((await b.c.get("/v1/stores")).body.items).toEqual([]);
  });
});

describe("connecting a Tokopedia & Shop shop (TikTok Shop API)", () => {
  it("stores the shop cipher, imports sales and FBT warehouses, and subscribes the shop's webhooks", async () => {
    const { c, me } = await signup(api);
    const sellerId = mock.addTiktokSeller({
      openId: "7010736057180325637",
      name: "Rina Beauty",
      shops: [
        {
          id: "7495000000000000001",
          name: "Rina Beauty",
          region: "ID",
          cipher: "ROW_rinabeauty",
          warehouses: [
            { id: "w-jkt", name: "Gudang Jakarta", type: "SALES_WAREHOUSE", is_default: true },
            { id: "w-sby", name: "Gudang Surabaya", type: "SALES_WAREHOUSE", is_default: false },
            { id: "r-jkt", name: "Retur Jakarta", type: "RETURN_WAREHOUSE", is_default: false },
          ],
          fbt: [{ fbt_warehouse_id: "fbt-ckr", name: "FBT Cikarang", subscribed: true }],
        },
      ],
    });

    const started = await c.post("/v1/store-authorizations", { channel: "tiktokshop" });
    const link = new URL(started.body.authorizeUrl);
    expect(link.pathname).toBe("/open/authorize");
    expect(link.searchParams.get("service_id")).toBe(TIKTOK.serviceId);

    await c.post("/v1/store-authorizations/callback", {
      channel: "tiktokshop",
      state: link.searchParams.get("state"),
      code: mock.tiktokCode(sellerId),
    });
    await drain(me.tenant.id);
    const done = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body;
    expect(done.status).toBe("succeeded");
    const storeId = done.result.stores[0].storeId as string;

    const store = (await c.get(`/v1/stores/${storeId}`)).body;
    expect(store).toMatchObject({
      channelName: "Tokopedia & Shop",
      externalShopId: "7495000000000000001",
      status: "active",
      marketplaceInfo: expect.objectContaining({ seller_type: "LOCAL", open_id: "7010736057180325637" }),
    });
    const cipher = await sql1<{ shop_cipher: string }>(
      sql`SELECT shop_cipher FROM store_credential WHERE store_id = ${storeId}`,
    );
    expect(cipher?.shop_cipher).toBe("ROW_rinabeauty");

    const cws = (await c.get(`/v1/stores/${storeId}/channel-warehouses`)).body.items as {
      externalWarehouseId: string;
      kind: string;
      mappingStatus: string;
      isDefault: boolean;
      address: Record<string, unknown>;
    }[];
    const byId = Object.fromEntries(cws.map((w) => [w.externalWarehouseId, w]));
    expect(Object.keys(byId).sort()).toEqual(["fbt-ckr", "w-jkt", "w-sby"]);
    expect(byId["fbt-ckr"]).toMatchObject({ kind: "fulfillment", mappingStatus: "marketplace_managed" });
    // one OmniSeller warehouse: every seller warehouse maps to it (MVP-1 single-warehouse setup)
    expect(byId["w-jkt"]).toMatchObject({ kind: "seller", mappingStatus: "mapped", isDefault: true });
    expect(byId["w-sby"]).toMatchObject({ mappingStatus: "mapped" });
    expect(byId["w-jkt"]!.address).not.toHaveProperty("contact_person");
    expect(byId["w-jkt"]!.address).not.toHaveProperty("phone_number");

    const topics = mock.tiktokWebhooks.get("ROW_rinabeauty")!;
    expect([...topics.keys()]).toEqual(
      expect.arrayContaining(["SELLER_DEAUTHORIZATION", "UPCOMING_AUTHORIZATION_EXPIRATION", "ORDER_STATUS_CHANGE"]),
    );
    for (const address of topics.values()) expect(address).toBe(`${WEBHOOK_URL}/webhooks/tiktokshop`);
  });

  it("records a declined authorization and refuses reused or foreign states", async () => {
    const { c } = await signup(api);
    const started = await c.post("/v1/store-authorizations", { channel: "tiktokshop" });
    const state = stateOf(started.body.authorizeUrl);
    const declined = await c.post("/v1/store-authorizations/callback", {
      channel: "tiktokshop",
      state,
      error: "auth_denied",
    });
    expect(declined.body).toMatchObject({ status: "failed", errorCode: "denied" });

    const reused = await c.post("/v1/store-authorizations/callback", { channel: "tiktokshop", state, code: "TTP_x" });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe("store_authorization.invalid");

    const other = await signup(api);
    const mine = await c.post("/v1/store-authorizations", { channel: "tiktokshop" });
    const stolen = await other.c.post("/v1/store-authorizations/callback", {
      channel: "tiktokshop",
      state: stateOf(mine.body.authorizeUrl),
      code: "TTP_x",
    });
    expect(stolen.status).toBe(422);
  });
});

describe("tokens", () => {
  it("refreshes once under concurrency, and each Shopee refresh token is used only once", async () => {
    const { c, me } = await signup(api);
    mock.addShopeeShop({ shopId: "530001", name: "Toko Refresh", region: "ID", warehouses: "not_whitelisted" });
    const storeId = (await connectShopee(c, me.tenant.id, "530001")).result.stores[0].storeId as string;
    await makeDue(storeId);
    const before = mock.callsTo("POST", "/api/v2/auth/access_token/get").length;

    await Promise.all([1, 2, 3].map(() => worker.runJob(storeTokenRefreshJob, { storeId }, me.tenant.id)));
    expect(mock.callsTo("POST", "/api/v2/auth/access_token/get").length - before).toBe(1);
    // raw execute returns timestamptz as text
    const cred = await sql1<{ access_expires_at: string }>(
      sql`SELECT access_expires_at FROM store_credential WHERE store_id = ${storeId}`,
    );
    expect(new Date(cred!.access_expires_at).getTime() - Date.now()).toBeGreaterThan(3.9 * 3600_000);

    // A forced refresh uses the new refresh token; the mock rejects any reuse.
    const outcome = await worker.ctx.get(CredentialService).refresh(userCtx(me.tenant.id), storeId, { force: true });
    expect(outcome).toBe("refreshed");
    expect((await c.get(`/v1/stores/${storeId}`)).body.status).toBe("active");
  });

  it("refreshes and retries once when the marketplace says the access token expired", async () => {
    const { c, me } = await signup(api);
    mock.addShopeeShop({ shopId: "540001", name: "Toko Expired", region: "ID", warehouses: "not_whitelisted" });
    const storeId = (await connectShopee(c, me.tenant.id, "540001")).result.stores[0].storeId as string;
    mock.expireShopeeAccessTokens();
    await worker.runJob(storeWarehousesSyncJob, { storeId }, me.tenant.id);
    const log = (await c.get(`/v1/stores/${storeId}/sync-jobs`)).body.items as { kind: string; status: string }[];
    // Newest first by start: the refresh started inside the pull, after it.
    expect(log.slice(0, 2).map((j) => `${j.kind}:${j.status}`)).toEqual([
      "auth.refresh:succeeded",
      "warehouses.pull:succeeded",
    ]);
    expect(mock.callsTo("GET", "/api/v2/shop/get_shop_info").at(-2)?.query.access_token).not.toBe(
      mock.callsTo("GET", "/api/v2/shop/get_shop_info").at(-1)?.query.access_token,
    );
    expect((await c.get(`/v1/stores/${storeId}`)).body.status).toBe("active");
  });

  it("sends the store to reauthorization when the refresh token is no longer accepted", async () => {
    const { c, me } = await signup(api);
    mock.addShopeeShop({ shopId: "550001", name: "Toko Dicabut", region: "ID", warehouses: "not_whitelisted" });
    const storeId = (await connectShopee(c, me.tenant.id, "550001")).result.stores[0].storeId as string;
    mock.revokeShopeeRefreshTokens();
    await makeDue(storeId);
    await expect(worker.runJob(storeTokenRefreshJob, { storeId }, me.tenant.id)).rejects.toMatchObject({
      kind: "auth_revoked",
    });
    const store = (await c.get(`/v1/stores/${storeId}`)).body;
    expect(store).toMatchObject({ status: "reauth_required", statusReason: "authorization_expired" });
    expect(store.statusMessage).toMatch(/izin OmniSeller/);
    expect(await sql1(sql`SELECT 1 FROM store_credential WHERE store_id = ${storeId}`)).toBeUndefined();

    // Reconnecting the same shop brings the same store back, with new tokens.
    const again = await connectShopee(c, me.tenant.id, "550001", storeId);
    expect(again.status).toBe("succeeded");
    expect(again.result.stores[0]).toMatchObject({ storeId, reconnected: true });
    expect((await c.get(`/v1/stores/${storeId}`)).body).toMatchObject({ status: "active", statusReason: null });

    // Reconnecting with another shop's authorization is refused.
    mock.addShopeeShop({ shopId: "550002", name: "Toko Lain", region: "ID", warehouses: "not_whitelisted" });
    const mismatch = await connectShopee(c, me.tenant.id, "550002", storeId);
    expect(mismatch).toMatchObject({ status: "failed", errorCode: "store_mismatch" });
  });

  it("counts transient refresh failures and asks for reauthorization after the third", async () => {
    const { c, me } = await signup(api);
    mock.addShopeeShop({ shopId: "560001", name: "Toko Gangguan", region: "ID", warehouses: "not_whitelisted" });
    const storeId = (await connectShopee(c, me.tenant.id, "560001")).result.stores[0].storeId as string;
    await makeDue(storeId);
    for (let i = 1; i <= 3; i++) {
      mock.failNext("POST", "/api/v2/auth/access_token/get", 500, {
        error: "error_server",
        message: "Something wrong.",
      });
      await expect(worker.runJob(storeTokenRefreshJob, { storeId }, me.tenant.id)).rejects.toMatchObject({
        kind: "transient",
      });
      const s = (await c.get(`/v1/stores/${storeId}`)).body;
      if (i < 3) expect(s).toMatchObject({ status: "active", tokenRefreshFailures: i });
      else expect(s).toMatchObject({ status: "reauth_required", statusReason: "refresh_failed" });
    }
  });
});

describe("webhooks", () => {
  it("verifies Shopee pushes, stores each once, and deauthorizes the store", async () => {
    const { c, me } = await signup(api);
    mock.addShopeeShop({ shopId: "570001", name: "Toko Push", region: "ID", warehouses: "not_whitelisted" });
    const storeId = (await connectShopee(c, me.tenant.id, "570001")).result.stores[0].storeId as string;
    const body = {
      data: {
        authorize_type: "user cancel shop authorization",
        success: 1,
        extra: "shop id 570001 (ID) has been cancelled its authorization",
      },
      code: 2,
      partner_id: SHOPEE.partnerId,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const forged = await request(hooks.getHttpServer())
      .post("/webhooks/shopee")
      .set("content-type", "application/json")
      .set("authorization", "0".repeat(64))
      .send(JSON.stringify(body));
    expect(forged.status).toBe(401);

    const first = await shopeePush(body);
    expect(first.status).toBe(200);
    expect(first.text).toBe("");
    expect((await shopeePush(body)).status).toBe(200);
    const rows = (
      await h.system.db.execute<{ id: string; tenant_id: string; store_id: string; processed_at: Date | null }>(
        sql`SELECT id, tenant_id, store_id, processed_at FROM webhook_inbox WHERE source = 'shopee' AND external_shop_id = '570001'`,
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: me.tenant.id, store_id: storeId, processed_at: null });

    const queue = new Queue("webhook", { connection: h.redis, prefix: h.infra.keyPrefix });
    expect(await queue.getJob(jobKey("webhook.process", rows[0]!.id))).toBeTruthy();
    await queue.close();

    await worker.runJob(webhookProcessJob, { inboxId: rows[0]!.id }, me.tenant.id);
    expect((await c.get(`/v1/stores/${storeId}`)).body).toMatchObject({
      status: "reauth_required",
      statusReason: "authorization_revoked",
    });
    const processed = await sql1<{ processed_at: Date | null }>(
      sql`SELECT processed_at FROM webhook_inbox WHERE id = ${rows[0]!.id}`,
    );
    expect(processed?.processed_at).not.toBeNull();
  });

  it("marks a store token_expiring from TikTok Shop's upcoming-expiration notice", async () => {
    const { c, me } = await signup(api);
    const sellerId = mock.addTiktokSeller({
      openId: "7010000000000000002",
      name: "Toko Kedaluwarsa",
      shops: [{ id: "7495000000000000002", name: "Toko Kedaluwarsa", region: "ID", cipher: "ROW_exp", warehouses: [] }],
    });
    const started = await c.post("/v1/store-authorizations", { channel: "tiktokshop" });
    await c.post("/v1/store-authorizations/callback", {
      channel: "tiktokshop",
      state: stateOf(started.body.authorizeUrl),
      code: mock.tiktokCode(sellerId),
    });
    await drain(me.tenant.id);
    const storeId = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body.result.stores[0].storeId;

    const expiresAt = Math.floor(Date.now() / 1000) + 10 * 86400;
    const raw = JSON.stringify({
      type: 7,
      tts_notification_id: "7327112393057371999",
      shop_id: "7495000000000000002",
      timestamp: Math.floor(Date.now() / 1000),
      data: { message: "Authorization is expiring", expiration_time: String(expiresAt) },
    });
    const res = await request(hooks.getHttpServer())
      .post("/webhooks/tiktokshop")
      .set("content-type", "application/json")
      .set("authorization", mock.signTiktokWebhook(raw))
      .send(raw);
    expect(res.status).toBe(200);
    const row = await sql1<{ id: string }>(sql`SELECT id FROM webhook_inbox WHERE event_id = '7327112393057371999'`);
    await worker.runJob(webhookProcessJob, { inboxId: row!.id }, me.tenant.id);
    const store = (await c.get(`/v1/stores/${storeId}`)).body;
    expect(store).toMatchObject({ status: "token_expiring", statusReason: "authorization_expiring" });
    expect(Date.parse(store.authorizationExpiresAt)).toBe(expiresAt * 1000);
  });

  it("keeps pushes for unknown shops until the store appears, then routes them; old ones are closed", async () => {
    const { c, me } = await signup(api);
    const order = {
      data: { ordersn: "260930ABCDEF", status: "READY_TO_SHIP", update_time: 1 },
      shop_id: 580001,
      code: 3,
      timestamp: 1,
    };
    expect((await shopeePush(order)).status).toBe(200);
    const stale = { ...order, data: { ...order.data, ordersn: "OLD" }, shop_id: 589999 };
    expect((await shopeePush(stale)).status).toBe(200);
    await h.system.db.execute(
      sql`UPDATE webhook_inbox SET received_at = now() - interval '20 minutes' WHERE external_shop_id = '589999'`,
    );

    mock.addShopeeShop({ shopId: "580001", name: "Toko Baru", region: "ID", warehouses: "not_whitelisted" });
    const storeId = (await connectShopee(c, me.tenant.id, "580001")).result.stores[0].storeId as string;
    await h.system.db.execute(
      sql`UPDATE webhook_inbox SET received_at = now() - interval '1 minute' WHERE external_shop_id = '580001'`,
    );

    const queues = worker.ctx.get<QueueRegistry>(QUEUES);
    const registry = worker.ctx.get<JobRegistry>(JOB_REGISTRY);
    await sweepWebhookInbox(h.system, queues, registry);
    const routed = await sql1<{ tenant_id: string; store_id: string }>(
      sql`SELECT tenant_id, store_id FROM webhook_inbox WHERE external_shop_id = '580001'`,
    );
    expect(routed).toEqual({ tenant_id: me.tenant.id, store_id: storeId });
    const closed = await sql1<{ processed_at: Date | null; last_error: string }>(
      sql`SELECT processed_at, last_error FROM webhook_inbox WHERE external_shop_id = '589999'`,
    );
    expect(closed?.last_error).toBe("unknown_shop");
    expect(closed?.processed_at).not.toBeNull();
  });
});

describe("store settings", () => {
  it("needs every marketplace warehouse mapped before live sync, and refuses to unmap a live store", async () => {
    const { c, me } = await signup(api);
    const sellerId = mock.addTiktokSeller({
      openId: "7010000000000000003",
      name: "Toko Gudang",
      shops: [
        {
          id: "7495000000000000003",
          name: "Toko Gudang",
          region: "ID",
          cipher: "ROW_gudang",
          warehouses: [
            { id: "g1", name: "Gudang 1", type: "SALES_WAREHOUSE", is_default: true },
            { id: "g2", name: "Gudang 2", type: "SALES_WAREHOUSE", is_default: false },
          ],
          fbt: [{ fbt_warehouse_id: "fbt1", name: "FBT", subscribed: true }],
        },
      ],
    });
    const started = await c.post("/v1/store-authorizations", { channel: "tiktokshop" });
    await c.post("/v1/store-authorizations/callback", {
      channel: "tiktokshop",
      state: stateOf(started.body.authorizeUrl),
      code: mock.tiktokCode(sellerId),
    });
    await drain(me.tenant.id);
    const storeId = (await c.get(`/v1/store-authorizations/${started.body.id}`)).body.result.stores[0].storeId;
    const cws = (await c.get(`/v1/stores/${storeId}/channel-warehouses`)).body.items as {
      id: string;
      externalWarehouseId: string;
      warehouseId: string;
    }[];
    const g2 = cws.find((w) => w.externalWarehouseId === "g2")!;
    const fbt = cws.find((w) => w.externalWarehouseId === "fbt1")!;

    expect(
      (await c.put(`/v1/stores/${storeId}/channel-warehouses/${g2.id}`, { warehouseId: null })).body.mappingStatus,
    ).toBe("unmapped");
    const refused = await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("store.unmapped_warehouses");

    const target = cws.find((w) => w.externalWarehouseId === "g1")!.warehouseId;
    expect((await c.put(`/v1/stores/${storeId}/channel-warehouses/${g2.id}`, { warehouseId: target })).status).toBe(
      200,
    );
    const etag = (await c.get(`/v1/stores/${storeId}`)).headers.etag as string;
    const live = await c.patch(`/v1/stores/${storeId}`, { syncMode: "live" }).set("If-Match", etag);
    expect(live.status).toBe(200);
    expect(live.body.syncMode).toBe("live");
    expect((await c.patch(`/v1/stores/${storeId}`, { name: "x" }).set("If-Match", etag)).status).toBe(409);

    const unmapLive = await c.put(`/v1/stores/${storeId}/channel-warehouses/${g2.id}`, { warehouseId: null });
    expect(unmapLive.status).toBe(409);
    const managed = await c.put(`/v1/stores/${storeId}/channel-warehouses/${fbt.id}`, { warehouseId: target });
    expect(managed.body.code).toBe("channel_warehouse.marketplace_managed");
  });

  it("disconnects: tokens deleted at once, sync off, Shopee's cancel link returned", async () => {
    const { c, me } = await signup(api);
    mock.addShopeeShop({ shopId: "590001", name: "Toko Putus", region: "ID", warehouses: "not_whitelisted" });
    const storeId = (await connectShopee(c, me.tenant.id, "590001")).result.stores[0].storeId as string;
    const res = await c.post(`/v1/stores/${storeId}/disconnect`);
    expect(res.status).toBe(200);
    expect(res.body.store).toMatchObject({
      status: "disconnected",
      syncMode: "read_only",
      statusReason: "disconnected_by_user",
    });
    expect(new URL(res.body.revokeUrl).pathname).toBe("/cancel_auth");
    expect(await sql1(sql`SELECT 1 FROM store_credential WHERE store_id = ${storeId}`)).toBeUndefined();
    expect((await c.post(`/v1/stores/${storeId}/disconnect`)).status).toBe(409);
    expect((await c.post(`/v1/stores/${storeId}/warehouses/sync`)).status).toBe(409);
  });

  it("hides stores outside the user's store scope", async () => {
    const { c, me } = await signup(api);
    mock.addShopeeShop({ shopId: "600001", name: "Toko A", region: "ID", warehouses: "not_whitelisted" });
    mock.addShopeeShop({ shopId: "600002", name: "Toko B", region: "ID", warehouses: "not_whitelisted" });
    const a = (await connectShopee(c, me.tenant.id, "600001")).result.stores[0].storeId as string;
    const b = (await connectShopee(c, me.tenant.id, "600002")).result.stores[0].storeId as string;
    const scoped = { ...userCtx(me.tenant.id), storeScope: new Set([a]) };
    const stores = worker.ctx.get(StoresService);
    expect((await stores.list(scoped)).map((v) => v.store.id)).toEqual([a]);
    await expect(stores.get(scoped, b)).rejects.toMatchObject({ code: "store.not_found" });
  });
});

describe("scheduler scans", () => {
  it("enqueue token refreshes and warehouse polls with one id per store per slot", async () => {
    const { c, me } = await signup(api);
    mock.addShopeeShop({ shopId: "610001", name: "Toko Jadwal", region: "ID", warehouses: "not_whitelisted" });
    const storeId = (await connectShopee(c, me.tenant.id, "610001")).result.stores[0].storeId as string;
    await makeDue(storeId);
    const queues = worker.ctx.get<QueueRegistry>(QUEUES);
    const registry = worker.ctx.get<JobRegistry>(JOB_REGISTRY);
    const now = new Date();
    await scanTokenRefresh(h.system, queues, registry, now);
    await scanTokenRefresh(h.system, queues, registry, now);
    const slot = Math.floor(now.getTime() / (15 * 60_000));
    const refresh = await queues.get("mp.outbound").getJob(jobKey("store.token_refresh", storeId, `s${slot}`));
    expect(refresh?.data).toEqual({ storeId, tenantId: me.tenant.id });

    await scanWarehousePolls(h.system, queues, registry, now);
    const poll = await queues
      .get("mp.poll")
      .getJob(jobKey("store.warehouses_sync", storeId, `p${Math.floor(now.getTime() / (6 * 3600_000))}`));
    expect(poll?.data).toEqual({ storeId, tenantId: me.tenant.id });
  });
});
