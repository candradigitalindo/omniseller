import type { INestApplication } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { AffiliateService } from "../../src/modules/affiliate/affiliate.service";
import { client, PASSWORD, signup, startApi, startWorker, tokenFrom, uniqueEmail } from "../setup/app";
import { createAffiliateQuery, createStore, userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { type MockAmsProduct, MockMarketplace } from "../setup/mock-marketplace";

const h = testHandles();
let api: INestApplication;
let mock: MockMarketplace;
let worker: Awaited<ReturnType<typeof startWorker>>;
let shopSeq = 880000;
beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  api = await startApi(h.infra, { marketplace: mock });
  worker = await startWorker(h.infra, h.system, { marketplace: mock });
});
afterAll(async () => {
  await worker?.close();
  await api?.close();
  await mock?.close();
});
async function drain(tenantId: string) {
  for (let i = 0; i < 10; i++) {
    if (!(await worker.runOutbox(tenantId)).length) break;
  }
}
async function setup(enabled = true) {
  const { c, me } = await signup(api);
  const shopId = String(++shopSeq);
  const products: MockAmsProduct[] = [1, 2, 3].map((i) => ({
    item_id: String(9223372036854775800n + BigInt(i)),
    item_name: `Kaos ${i}`,
    campaign_id: 100 + i,
    campaign_status: i === 3 ? "Terminating" : "Ongoing",
    commission_rate: i + 0.25,
    period_start_time: 1_790_812_800,
    period_end_time: 32_503_651_199,
    commission_protection_list: [{ commission_rate: 5, protection_period_end_time: 1_793_404_800 }],
  }));
  mock.addShopeeShop({
    shopId,
    name: "AMS Test",
    region: "ID",
    warehouses: "not_whitelisted",
    items: [],
    amsProducts: products,
    amsEnabled: enabled,
  });
  const start = await c.post("/v1/store-authorizations", { channel: "shopee" });
  await c.post("/v1/store-authorizations/callback", {
    channel: "shopee",
    state: new URL(start.body.authorizeUrl).searchParams.get("state"),
    code: mock.shopeeCode({ shopId }),
    shopId,
  });
  await drain(me.tenant.id);
  const storeId = (await c.get(`/v1/store-authorizations/${start.body.id}`)).body.result.stores[0].storeId as string;
  return { c, me, storeId, path: `/v1/stores/${storeId}/affiliate/products` };
}
describe("AMS application flow", () => {
  it("queues a signed read, replays its key, follows cursors, filters and sorts without changing a read-only shop", async () => {
    const { c, me, path, storeId } = await setup();
    const key = newId();
    expect((await c.get(path)).body).toEqual({ request: null });
    const first = await c.post(path, { pageSize: 1, sortBy: "-commission_rate" }).set("Idempotency-Key", key);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body.status).toBe("queued");
    expect((await c.post(path, { pageSize: 1, sortBy: "-commission_rate" }).set("Idempotency-Key", key)).body.id).toBe(
      first.body.id,
    );
    expect((await c.post(path, { pageSize: 1 }).set("Idempotency-Key", newId())).status).toBe(409);
    await drain(me.tenant.id);
    const page = (await c.get(path)).body.request;
    expect(page).toMatchObject({
      status: "succeeded",
      total: 3,
      nextCursor: "ams-1",
      items: [
        {
          externalItemId: "9223372036854775803",
          commissionBasisPoints: 325,
          endsAt: null,
          status: "terminating",
          protections: [{ commissionBasisPoints: 500, endsAt: expect.any(String) }],
        },
      ],
    });
    expect((await c.get(`/v1/stores/${storeId}`)).body.syncMode).toBe("read_only");
    const next = await c
      .post(path, { pageSize: 1, cursor: page.nextCursor, sortBy: "-commission_rate" })
      .set("Idempotency-Key", newId());
    await drain(me.tenant.id);
    expect((await c.get(`${path}?requestId=${next.body.id}`)).body.request.items[0].externalItemId).toBe(
      "9223372036854775802",
    );
    const filtered = await c
      .post(path, { search: { by: "id", value: "9223372036854775801" } })
      .set("Idempotency-Key", newId());
    await drain(me.tenant.id);
    expect((await c.get(`${path}?requestId=${filtered.body.id}`)).body.request).toMatchObject({
      status: "succeeded",
      total: 1,
      nextCursor: null,
    });
    const audit = (await c.get("/v1/audit-logs?entity_type=affiliate_product_query")).body.items;
    expect(audit.some((r: { entityId: string }) => r.entityId === first.body.id)).toBe(true);
    const sheets = worker.ctx.get(AffiliateService).exportSheets();
    expect(sheets.map((s) => s.file)).toContain("pencarian_produk_affiliate.csv");
    const sheet = sheets.find((s) => s.file === "pencarian_produk_affiliate.csv")!;
    const rows = await withTenantTx(h.worker, userCtx(me.tenant.id), async (tx) => {
      const out: unknown[][] = [];
      for await (const page of sheet.pages(tx, {
        storeName: () => null,
        warehouseCode: () => null,
        userName: () => null,
      }))
        out.push(...page);
      return out;
    });
    expect(rows.find((r) => r[0] === first.body.id)?.[5]).toContain('"externalItemId":"9223372036854775803"');
    expect(rows.find((r) => r[0] === first.body.id)?.[5]).toContain('"commissionBasisPoints":325');
    const removed = await withTenantTx(h.worker, userCtx(me.tenant.id), (tx) =>
      worker.ctx.get(AffiliateService).deleteStoreQueriesIn(tx, storeId, 100),
    );
    expect(removed).toBe(3);
    expect((await c.get(path)).body.request).toBeNull();
  });
  it("reports entitlement refusal without disconnecting the store or inventing success", async () => {
    const { c, me, path, storeId } = await setup(false);
    const job = await c.post(path, {}).set("Idempotency-Key", newId());
    expect(job.status).toBe(202);
    await drain(me.tenant.id);
    expect((await c.get(path)).body.request).toMatchObject({
      status: "failed",
      errorCode: "error_business",
      errorMessage: expect.stringContaining("persetujuan AMS"),
      total: null,
      items: [],
    });
    expect((await c.get(`/v1/stores/${storeId}`)).body.status).toBe("active");
  });
  it("rejects malformed queries, anonymous users, foreign tenants, foreign store results and expired snapshots", async () => {
    const { c, me, path } = await setup();
    expect((await request(api.getHttpServer()).get(path)).status).toBe(401);
    expect((await c.post(path, {})).status).toBe(422);
    for (const input of [
      { pageSize: 101 },
      { search: { by: "id", value: "1.5" } },
      { search: { by: "id", value: Array(51).fill("1").join(",") } },
      { sortBy: "bad" },
    ])
      expect((await c.post(path, input).set("Idempotency-Key", newId())).status).toBe(422);
    const other = await signup(api);
    expect((await other.c.get(path)).status).toBe(404);
    expect((await other.c.post(path, {}).set("Idempotency-Key", newId())).status).toBe(404);
    const foreign = await withTenantTx(h.api, userCtx(me.tenant.id), async (tx) => {
      const storeId = await createStore(tx, me.tenant.id);
      return createAffiliateQuery(tx, me.tenant.id, storeId);
    });
    expect((await c.get(`${path}?requestId=${foreign}`)).status).toBe(404);
    const made = await c.post(path, {}).set("Idempotency-Key", newId());
    await drain(me.tenant.id);
    await h.system.db.execute(
      sql`UPDATE affiliate_product_query SET expires_at=now()-interval '1 minute' WHERE id=${made.body.id}`,
    );
    expect((await c.get(`${path}?requestId=${made.body.id}`)).status).toBe(404);
    expect((await c.get(path)).body.request).toBeNull();
  });
  it("grants a custom affiliate role dynamically and enforces store scopes and later permission revocation", async () => {
    const { c, me, path, storeId } = await setup();
    const role = (await c.post("/v1/roles", { name: "Analis Affiliate", permissions: ["affiliate:read"] })).body;
    const email = uniqueEmail("ams");
    await c.post("/v1/invitations", { email, roleId: role.id });
    await drain(me.tenant.id);
    const member = client(api);
    await member.post("/v1/auth/invitations/accept", {
      token: tokenFrom(worker.email.lastTo(email)!.text),
      name: "Analis",
      password: PASSWORD,
    });
    expect((await member.get(path)).status).toBe(200);
    const queued = await member.post(path, {}).set("Idempotency-Key", newId());
    expect(queued.status).toBe(202);
    expect((await c.patch(`/v1/roles/${role.id}`, { permissions: ["catalog:read"] })).status).toBe(200);
    expect((await member.get(path)).status).toBe(403);
    await drain(me.tenant.id);
    expect((await c.get(path)).body.request).toMatchObject({ status: "failed", errorCode: "permission_revoked" });
    expect((await c.patch(`/v1/roles/${role.id}`, { permissions: ["affiliate:read"] })).status).toBe(200);
    const user = (await member.get("/v1/me")).body.user;
    const ownOtherStore = await withTenantTx(h.api, userCtx(me.tenant.id), (tx) => createStore(tx, me.tenant.id));
    expect((await c.put(`/v1/users/${user.id}/scopes`, { storeIds: [ownOtherStore], warehouseIds: null })).status).toBe(
      200,
    );
    expect((await member.get(path)).status).toBe(404);
    expect(storeId).toBeTruthy();
  });
});
