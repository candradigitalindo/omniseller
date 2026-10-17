import type { INestApplication } from "@nestjs/common";
import type { CommerceInput, CommerceOperation, CommercePrincipalKind } from "@omniseller/connector-core";
import { createTiktokShopConnector, TIKTOK_COMMERCE_OPERATIONS } from "@omniseller/connector-tiktokshop";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { AffiliateAccountCredentialsService } from "../../src/modules/affiliate-accounts/accounts-credentials.service";
import { CONNECTORS, type ConnectorRegistry } from "../../src/modules/channel/connector-registry";
import { CredentialService } from "../../src/modules/channel/credential.service";
import { commerceCleanupJob, commerceExecuteJob } from "../../src/modules/commerce/commerce.jobs";
import { CommerceService } from "../../src/modules/commerce/commerce.service";
import { connectorCallObserver, connectorRequestGate } from "../../src/modules/sync/connector-calls";
import { COMMERCE_CLEANUP_SCAN_MS, scanCommerceCleanup } from "../../src/scheduler/commerce-scan";
import {
  type Client,
  client,
  type MeBody,
  PASSWORD,
  signup,
  startApi,
  startWorker,
  tokenFrom,
  uniqueEmail,
} from "../setup/app";
import { CommerceTransport } from "../setup/commerce-transport";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace, TIKTOK } from "../setup/mock-marketplace";

const h = testHandles();
let api: INestApplication;
let mock: MockMarketplace;
let worker: Awaited<ReturnType<typeof startWorker>>;
let transport: CommerceTransport;
function operation(path: string, method = "GET") {
  const found = TIKTOK_COMMERCE_OPERATIONS.find((item) => item.path === path && item.method === method);
  if (!found) throw new Error(`Missing reviewed commerce fixture ${method} ${path}`);
  return found;
}
const sellerRead = () => operation("/event/202309/webhooks");
const sellerWrite = () => operation("/promotion/202309/activities/{activity_id}/deactivate", "POST");
const sellerSearch = () => operation("/affiliate_seller/202412/open_collaborations/search", "POST");
const creatorRead = () => operation("/affiliate_creator/202508/profiles");
const creatorWrite = () => operation("/affiliate_creator/202405/showcases/products/add", "POST");
const partnerRead = () => operation("/affiliate_partner/202405/campaigns/{campaign_id}");
const partnerWrite = () => operation("/affiliate_partner/202405/campaigns/{campaign_id}/publish", "POST");
const externalId = "9223372036854775806";
const inputFor = (op: CommerceOperation): CommerceInput =>
  op.id === sellerWrite().id
    ? { path: { activity_id: externalId } }
    : op.id === sellerSearch().id
      ? { query: { page_size: 10 }, body: { keyword_type: "PRODUCT_NAME", keyword: "Produk lokal" } }
      : op.id === creatorWrite().id
        ? { body: { add_type: "PRODUCT_ID", product_ids: [externalId] } }
        : op.categoryAsset
          ? { categoryAssetId: 123, path: { campaign_id: externalId } }
          : {};

beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  api = await startApi(h.infra, { marketplace: mock });
  worker = await startWorker(h.infra, h.system, { marketplace: mock });
  transport = new CommerceTransport(TIKTOK_COMMERCE_OPERATIONS, mock.url);
  // Keep native auth/profile connectors and exercise the real commerce adapter over a strict fetch transport.
  worker.ctx.get<ConnectorRegistry>(CONNECTORS).get("tiktokshop").commerce = createTiktokShopConnector({
    appKey: TIKTOK.appKey,
    appSecret: TIKTOK.appSecret,
    serviceId: TIKTOK.serviceId,
    apiBaseUrl: mock.url,
    authBaseUrl: mock.url,
    authorizeUrl: `${mock.url}/open/authorize`,
    http: { fetch: transport.fetch, observer: connectorCallObserver, beforeRequest: connectorRequestGate },
  }).commerce;
});
afterAll(async () => {
  await worker?.close();
  await api?.close();
  await mock?.close();
});
beforeEach(() => transport.reset());
afterEach(() => expect(transport.violations).toEqual([]));
async function drain(tenantId: string) {
  for (let i = 0; i < 15; i++) if (!(await worker.runOutbox(tenantId)).length) return;
}
async function connect(c: Client, me: MeBody, kind: CommercePrincipalKind) {
  const scopes = [
    ...new Set([
      kind === "seller"
        ? "seller.authorization.info"
        : kind === "creator"
          ? "creator.affiliate.info"
          : "partner.authorization.info",
      ...TIKTOK_COMMERCE_OPERATIONS.filter((item) => item.principalKind === kind).flatMap((item) => item.scopes),
    ]),
  ];
  const id = newId();
  const categoryCipher = `PRIVATE_CATEGORY_${id}`;
  const sellerId = mock.addTiktokSeller({
    openId: id,
    name: `Akun ${kind}`,
    userType: kind === "seller" ? 0 : kind === "creator" ? 1 : 3,
    scopes,
    shops:
      kind === "seller"
        ? [{ id: externalId + id.slice(-3), name: "Toko Indonesia", region: "ID", cipher: `ROW_${id}`, warehouses: [] }]
        : [],
    categoryAssets: [
      { cipher: categoryCipher, target_market: "ID", category: { id: 123, name: "Kategori mitra uji" } },
    ],
  });
  const base = kind === "seller" ? "/v1/store-authorizations" : "/v1/affiliate/authorizations";
  const start = await c.post(base, kind === "seller" ? { channel: "tiktokshop" } : { kind });
  expect(start.status, JSON.stringify(start.body)).toBe(201);
  const callback = await c.post(`${base}/callback`, {
    state: new URL(start.body.authorizeUrl).searchParams.get("state"),
    code: mock.tiktokCode(sellerId),
    ...(kind === "seller" ? { channel: "tiktokshop" } : {}),
  });
  expect(callback.status, JSON.stringify(callback.body)).toBe(kind === "seller" ? 202 : 201);
  await drain(me.tenant.id);
  const completed = (await c.get(`${base}/${start.body.id}`)).body;
  expect(completed.status, JSON.stringify(completed)).toBe("succeeded");
  const principalId = (kind === "seller" ? completed.result.stores[0].storeId : completed.accountId) as string;
  const ctx = userCtx(me.tenant.id, me.user.id);
  if (kind === "seller") {
    const current = await worker.ctx.get(CredentialService).forShop(ctx, principalId);
    transport.principals.set(current.shop.accessToken, { kind, shopCipher: current.shop.shopCipher });
  } else {
    const current = await worker.ctx.get(AffiliateAccountCredentialsService).forAccount(ctx, principalId);
    transport.principals.set(current.accessToken, {
      kind,
      categoryCiphers: current.categoryAssets.map((asset) => asset.cipher),
    });
  }
  return { id: principalId, kind, scopes, categoryCipher };
}
async function fixture(kind: CommercePrincipalKind = "creator") {
  const owner = await signup(api);
  return { ...owner, principal: await connect(owner.c, owner.me, kind) };
}
function submit(
  c: Client,
  op: CommerceOperation,
  id: string,
  options: { input?: CommerceInput; key?: string; confirmed?: boolean } = {},
) {
  return c
    .post("/v1/commerce/requests", {
      operationId: op.id,
      principalId: id,
      input: options.input ?? inputFor(op),
      confirmed: options.confirmed ?? op.write,
    })
    .set("Idempotency-Key", options.key ?? newId());
}
async function result(c: Client, id: string) {
  const response = await c.get(`/v1/commerce/requests/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}
async function request(c: Client, op: CommerceOperation, id: string, options: Parameters<typeof submit>[3] = {}) {
  const response = await submit(c, op, id, options);
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  return response.body.id as string;
}
async function member(c: Client, tenantId: string, permissions: string[]) {
  const role = (await c.post("/v1/roles", { name: `Peran commerce ${newId().slice(-5)}`, permissions })).body;
  const email = uniqueEmail("commerce");
  expect((await c.post("/v1/invitations", { email, roleId: role.id })).status).toBe(201);
  await drain(tenantId);
  const user = client(api);
  expect(
    (
      await user.post("/v1/auth/invitations/accept", {
        token: tokenFrom(worker.email.lastTo(email)!.text),
        name: "Staf commerce",
        password: PASSWORD,
      })
    ).status,
  ).toBe(201);
  return { c: user, roleId: role.id, userId: (await user.get("/v1/me")).body.user.id as string };
}

describe("reviewed commerce through tenant API, outbox worker and signed connectors", () => {
  it.each(["seller", "creator", "affiliate_partner"] as const)(
    "executes %s reads and writes with its own token and private principal routing",
    async (kind) => {
      const { c, me, principal } = await fixture(kind);
      const read = kind === "seller" ? sellerRead() : kind === "creator" ? creatorRead() : partnerRead();
      const write = kind === "seller" ? sellerWrite() : kind === "creator" ? creatorWrite() : partnerWrite();
      const catalog = await c.get("/v1/commerce/operations");
      expect(catalog.status).toBe(200);
      expect(catalog.body.items).toContainEqual(expect.objectContaining({ id: read.id, available: true }));
      expect((await c.get("/v1/commerce/principals")).body.items).toContainEqual(
        expect.objectContaining({
          id: principal.id,
          kind,
          categories: kind === "affiliate_partner" ? [{ id: 123, name: "Kategori mitra uji" }] : [],
        }),
      );
      transport.reply(read, {
        data:
          kind === "seller"
            ? { webhooks: [{ event_type: "NEW_MESSAGE" }], total_count: 1 }
            : kind === "creator"
              ? { username: "Creator publik", selection_region: "ID" }
              : { id: externalId, name: "Kampanye Indonesia", region: "ID" },
      });
      const readId = await request(c, read, principal.id);
      expect(transport.count(read)).toBe(0);
      await drain(me.tenant.id);
      expect(await result(c, readId)).toMatchObject({ status: "succeeded", result: { acknowledgement: "read" } });
      if (kind === "seller")
        expect((await c.patch(`/v1/stores/${principal.id}`, { syncMode: "live" })).status).toBe(200);
      const writeId = await request(c, write, principal.id);
      await drain(me.tenant.id);
      expect(await result(c, writeId)).toMatchObject({ status: "succeeded", result: { acknowledgement: "accepted" } });
      expect(transport.count(read)).toBe(1);
      expect(transport.count(write)).toBe(1);
      const call = transport.calls.find((item) => item.operationId === write.id)!;
      if (kind === "creator") expect(JSON.parse(call.body).product_ids).toEqual([externalId]);
      if (kind === "affiliate_partner") {
        expect(call.url.searchParams.get("category_asset_cipher")).toBe(principal.categoryCipher);
        expect(JSON.stringify(await result(c, writeId))).not.toContain(principal.categoryCipher);
      }
    },
  );

  it("replays an idempotency key, rejects different input and paginates only its tenant's history", async () => {
    const { c, me, principal } = await fixture();
    const foreign = await signup(api);
    const key = newId();
    const id = await request(c, creatorRead(), principal.id, { key });
    expect((await submit(c, creatorRead(), principal.id, { key })).body.id).toBe(id);
    expect((await submit(c, creatorRead(), principal.id, { key, confirmed: true })).status).toBe(422);
    expect((await foreign.c.get(`/v1/commerce/requests/${id}`)).status).toBe(404);
    expect((await submit(foreign.c, creatorRead(), principal.id)).status).toBe(404);
    await drain(me.tenant.id);
    expect(transport.count(creatorRead())).toBe(1);
    const second = await request(c, creatorRead(), principal.id);
    await drain(me.tenant.id);
    const firstPage = (await c.get(`/v1/commerce/requests?limit=1&principalId=${principal.id}`)).body;
    expect(firstPage.items.map((item: { id: string }) => item.id)).toEqual([second]);
    expect(firstPage.nextCursor).toBe(second);
    const next = (await c.get(`/v1/commerce/requests?limit=1&principalId=${principal.id}&cursor=${second}`)).body;
    expect(next.items.map((item: { id: string }) => item.id)).toEqual([id]);
  });

  it("checks confirmation, reviewed fields, account kind, tenant and read-only store before any dispatch", async () => {
    const { c, me, principal } = await fixture("seller");
    const creator = await connect(c, me, "creator");
    const foreign = await signup(api);
    const input = inputFor(creatorWrite());
    expect((await submit(c, creatorWrite(), creator.id, { confirmed: false })).status).toBe(422);
    expect(
      (
        await submit(c, creatorWrite(), creator.id, {
          input: { body: { ...input.body, access_token: "FORBIDDEN_INPUT" } },
        })
      ).status,
    ).toBe(422);
    expect((await submit(c, sellerWrite(), principal.id)).body.code).toBe("commerce.read_only");
    expect((await submit(c, partnerRead(), creator.id)).status).toBe(404);
    expect((await submit(c, creatorRead(), principal.id)).status).toBe(404);
    expect((await submit(foreign.c, sellerRead(), principal.id)).status).toBe(404);
    expect(
      (
        await c
          .post("/v1/commerce/requests", {
            operationId: "https://untrusted.invalid/arbitrary",
            principalId: principal.id,
            input: {},
            confirmed: false,
          })
          .set("Idempotency-Key", newId())
      ).status,
    ).toBe(404);
    expect(transport.calls).toEqual([]);
  });

  it("rechecks dynamic role permissions and marketplace scopes after a request is queued", async () => {
    const { c, me, principal } = await fixture();
    const user = await member(c, me.tenant.id, ["commerce:read", "affiliate:account_read", "affiliate:read"]);
    const revokedRole = await request(user.c, creatorRead(), principal.id);
    expect((await c.patch(`/v1/roles/${user.roleId}`, { permissions: ["commerce:read"] })).status).toBe(200);
    await worker.runJob(commerceExecuteJob, { requestId: revokedRole }, me.tenant.id);
    expect((await result(c, revokedRole)).status).toBe("failed");
    expect(transport.calls).toEqual([]);
    const revokedScope = await request(c, creatorRead(), principal.id);
    await h.system.db.execute(sql`UPDATE affiliate_account SET scopes=ARRAY[]::text[] WHERE id=${principal.id}`);
    await worker.runJob(commerceExecuteJob, { requestId: revokedScope }, me.tenant.id);
    expect((await result(c, revokedScope)).status).toBe("failed");
    expect(transport.calls).toEqual([]);
  });

  it("accepts one documented scope alternative and keeps a business-permission rejection separate from token revocation", async () => {
    const { c, me, principal } = await fixture();
    const op = creatorRead();
    const scope = op.scopes.find((value) => value === "creator.affiliate.info")!;
    await h.system.db.execute(
      sql`UPDATE affiliate_account SET scopes=ARRAY[${scope}]::text[] WHERE id=${principal.id}`,
    );
    transport.reply(
      op,
      { data: { username: "Creator publik" } },
      { code: 105005, message: "Business API access denied" },
    );
    const allowed = await request(c, op, principal.id);
    await worker.runJob(commerceExecuteJob, { requestId: allowed }, me.tenant.id);
    expect((await result(c, allowed)).status).toBe("succeeded");
    const denied = await request(c, op, principal.id);
    await worker.runJob(commerceExecuteJob, { requestId: denied }, me.tenant.id);
    expect(await result(c, denied)).toMatchObject({ status: "failed", errorCode: "105005" });
    expect((await c.get(`/v1/affiliate/accounts/${principal.id}`)).body.status).toBe("active");
    expect(transport.count(op)).toBe(2);
  });

  it("discards a read result when the requester's permission is revoked while HTTP is in flight", async () => {
    const { c, me, principal } = await fixture();
    const user = await member(c, me.tenant.id, ["commerce:read", "affiliate:account_read", "affiliate:read"]);
    const id = await request(user.c, creatorRead(), principal.id);
    let revokedStatus: number | undefined;
    transport.reply(creatorRead(), { data: { username: "REVOKED_RESULT_MUST_NOT_PUBLISH" } });
    transport.onReply = async () => {
      revokedStatus = (await c.patch(`/v1/roles/${user.roleId}`, { permissions: ["commerce:read"] })).status;
    };
    await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id);
    expect(revokedStatus).toBe(200);
    expect(transport.count(creatorRead())).toBe(1);
    expect(await result(c, id)).toMatchObject({ status: "failed", result: null });
  });

  it("enforces store and warehouse scopes while creator access remains independent of seller-store scope", async () => {
    const { c, me, principal } = await fixture("seller");
    const creator = await connect(c, me, "creator");
    const allowed = await connect(c, me, "seller");
    const user = await member(c, me.tenant.id, [
      "commerce:read",
      "settings:store",
      "affiliate:account_read",
      "affiliate:read",
    ]);
    expect(
      (await c.put(`/v1/users/${user.userId}/scopes`, { storeIds: [allowed.id], warehouseIds: null })).status,
    ).toBe(200);
    expect((await submit(user.c, sellerRead(), principal.id)).status).toBe(404);
    const creatorId = await request(user.c, creatorRead(), creator.id);
    await worker.runJob(commerceExecuteJob, { requestId: creatorId }, me.tenant.id);
    expect((await result(c, creatorId)).status).toBe("succeeded");
    const warehouseId = (await c.get("/v1/warehouses")).body.items[0].id as string;
    expect((await c.put(`/v1/users/${user.userId}/scopes`, { warehouseIds: [warehouseId] })).status).toBe(200);
    expect((await submit(user.c, creatorRead(), creator.id)).body.code).toBe("commerce.warehouse_scope");
  });

  it("retries a documented POST search as a read without dispatching a mutation", async () => {
    const { c, me, principal } = await fixture("seller");
    const op = sellerSearch();
    transport.reply(
      op,
      { status: 429, code: 36009002, message: "Throttled" },
      { data: { open_collaborations: [{ id: externalId }], total_count: 1, next_page_token: "cursor-id" } },
    );
    const id = await request(c, op, principal.id);
    await expect(worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id)).rejects.toMatchObject({
      kind: "transient",
    });
    expect(await result(c, id)).toMatchObject({ status: "queued", result: null });
    await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id, 1);
    expect(await result(c, id)).toMatchObject({
      status: "succeeded",
      nextCursor: "cursor-id",
      result: { acknowledgement: "read" },
    });
    expect(transport.count(op)).toBe(2);
    const rows = await h.system.db.execute(sql`SELECT is_write,dispatched_at FROM commerce_operation WHERE id=${id}`);
    expect(rows.rows).toEqual([{ is_write: false, dispatched_at: null }]);
  });

  it("keeps an uncertain mutation outcome and never sends the same write automatically again", async () => {
    const { c, me, principal } = await fixture();
    const op = creatorWrite();
    transport.reply(op, { network: true });
    const id = await request(c, op, principal.id);
    await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id);
    expect(await result(c, id)).toMatchObject({ status: "uncertain", result: null });
    await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id, 1);
    expect(transport.count(op)).toBe(1);
    // A worker crash after dispatch retains the marker even after its lease can be reclaimed.
    const crashed = await request(c, op, principal.id);
    await h.system.db.execute(
      sql`UPDATE commerce_operation SET status='running',claimed_at=now()-interval '10 minutes',claim_id=${newId()},dispatched_at=now() WHERE id=${crashed}`,
    );
    await worker.runJob(commerceExecuteJob, { requestId: crashed }, me.tenant.id, 1);
    expect(await result(c, crashed)).toMatchObject({ status: "uncertain", errorCode: "write_outcome_unknown" });
    expect(transport.count(op)).toBe(1);
  });

  it("strips secrets and buyer fields from response, sync logs, audit and exports", async () => {
    const { c, me, principal } = await fixture("seller");
    const op = sellerSearch();
    const marker = "PRIVATE_BUYER_MARKER";
    const secret = "PRIVATE_SECRET_MARKER";
    transport.reply(op, {
      data: {
        open_collaborations: [
          {
            id: externalId,
            product_name: "Produk lokal",
            buyer_name: marker,
            phone: marker,
            access_token: secret,
            shop_cipher: secret,
          },
        ],
        total_count: 1,
        next_page_token: "next",
        undeclared: secret,
      },
    });
    const id = await request(c, op, principal.id, {
      input: { query: { page_size: 10 }, body: { keyword_type: "PRODUCT_NAME", keyword: marker } },
    });
    await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id);
    const response = await result(c, id);
    expect(response.status).toBe("succeeded");
    expect(response.result.data.open_collaborations).toEqual([{ id: externalId, product_name: "Produk lokal" }]);
    const ctx = userCtx(me.tenant.id, me.user.id);
    const retained = await withTenantTx(h.worker, ctx, async (tx) => {
      const logs = await tx.execute(
        sql`SELECT request_summary,response_summary FROM sync_job WHERE kind='commerce.operation'`,
      );
      const audits = await tx.execute(sql`SELECT before,after FROM audit_log WHERE entity_type='commerce_operation'`);
      const exported: unknown[] = [];
      for (const sheet of worker.ctx.get(CommerceService).exportSheets())
        for await (const page of sheet.pages(tx, {
          storeName: () => null,
          warehouseCode: () => null,
          userName: () => null,
        }))
          exported.push(page);
      return { logs: logs.rows, audits: audits.rows, exported };
    });
    const safe = JSON.stringify({ response, ...retained });
    for (const value of [marker, secret, ...transport.calls.map((call) => call.accessToken)])
      expect(safe).not.toContain(value);
    expect(JSON.stringify(retained.audits)).not.toContain('"input"');
    expect(JSON.stringify(retained.audits)).not.toContain('"result"');
  });

  it("denies API result/status fabrication and expires retained payloads on schedule even for a closing tenant", async () => {
    const { c, me, principal } = await fixture();
    const id = await request(c, creatorRead(), principal.id);
    await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id);
    const fresh = await request(c, creatorRead(), principal.id);
    await worker.runJob(commerceExecuteJob, { requestId: fresh }, me.tenant.id);
    const apiRole = await h.raw("api");
    for (const field of ["result='{}'::jsonb", "status='succeeded'", "claim_id=NULL", "dispatched_at=now()"])
      await expect(apiRole.query(`UPDATE commerce_operation SET ${field}`)).rejects.toMatchObject({ code: "42501" });
    await h.system.db.execute(
      sql`UPDATE commerce_operation SET expires_at=now()-interval '1 minute',input='{"body":{"retained":"PRIVATE_PAYLOAD"}}'::jsonb WHERE id=${id}`,
    );
    expect((await c.get(`/v1/commerce/requests/${id}`)).status).toBe(404);
    expect((await c.post("/v1/account-closure", { businessName: me.tenant.name, password: PASSWORD })).status).toBe(
      200,
    );
    const queues = new QueueRegistry(h.redis, `${h.infra.keyPrefix}_commerce_cleanup`);
    const registry = new JobRegistry(JOB_DEFINITIONS);
    const now = new Date();
    try {
      expect(await scanCommerceCleanup(h.system, queues, registry, now)).toBeGreaterThanOrEqual(1);
      const slot = `s${Math.floor(now.getTime() / COMMERCE_CLEANUP_SCAN_MS)}`;
      const job = await queues.get("mp.poll").getJob(`commerce.cleanup|${me.tenant.id}|${slot}`);
      expect(job?.data.tenantId).toBe(me.tenant.id);
      const before = await queues.get("mp.poll").getJobCounts("waiting");
      await scanCommerceCleanup(h.system, queues, registry, now);
      expect(await queues.get("mp.poll").getJobCounts("waiting")).toEqual(before);
      await worker.runJob(commerceCleanupJob, { slot }, me.tenant.id);
    } finally {
      await queues.close();
    }
    const rows = await h.system.db.execute(
      sql`SELECT id,input,result FROM commerce_operation WHERE id IN (${id},${fresh}) ORDER BY id`,
    );
    expect(rows.rows.find((row) => row.id === id)).toEqual({ id, input: {}, result: null });
    expect(rows.rows.find((row) => row.id === fresh)?.result).not.toBeNull();
    expect(rows.rows).toHaveLength(2);
  });
});
