import type { INestApplication } from "@nestjs/common";
import { AuthRevokedError } from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { storeAuthorizationCleanupJob } from "../../src/modules/channel/channel.jobs";
import { CONNECTORS, type ConnectorRegistry } from "../../src/modules/channel/connector-registry";
import { CredentialService } from "../../src/modules/channel/credential.service";
import { KeyRotationService } from "../../src/modules/channel/key-rotation.service";
import { StoreAuthorizationService } from "../../src/modules/channel/store-authorization.service";
import { StoreConnectService } from "../../src/modules/channel/store-connect.service";
import { scanStoreAuthorizations } from "../../src/scheduler/channel-scans";
import { type Client, client, PASSWORD, signup, startApi, startWorker, tokenFrom, uniqueEmail } from "../setup/app";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace } from "../setup/mock-marketplace";

const h = testHandles();
let api: INestApplication;
let mock: MockMarketplace;
let worker: Awaited<ReturnType<typeof startWorker>>;
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
async function begin(c: Client) {
  const shopId = newId();
  const sellerId = mock.addTiktokSeller({
    openId: newId(),
    name: "Seller Indonesia",
    shops: [
      {
        id: shopId,
        name: "Toko integrasi",
        region: "ID",
        cipher: `ROW_${shopId}`,
        warehouses: [],
      },
    ],
  });
  const started = await c.post("/v1/store-authorizations", { channel: "tiktokshop" });
  expect(started.status).toBe(201);
  const state = new URL(started.body.authorizeUrl).searchParams.get("state")!;
  return { authorizationId: started.body.id as string, code: mock.tiktokCode(sellerId), state, sellerId };
}
async function callback(c: Client, input: { state: string; code: string }) {
  expect(
    (await c.post("/v1/store-authorizations/callback", { channel: "tiktokshop", state: input.state, code: input.code }))
      .status,
  ).toBe(202);
}
async function auth(c: Client, id: string) {
  return (await c.get(`/v1/store-authorizations/${id}`)).body;
}
async function drain(tenantId: string) {
  for (let i = 0; i < 5; i++) if (!(await worker.runOutbox(tenantId)).length) return;
}

describe("seller authorization durability and ownership", () => {
  it("requires an interactive user to start OAuth", async () => {
    const { me } = await signup(api);
    const ctx = { ...userCtx(me.tenant.id, me.user.id), actor: { type: "api_key" as const, id: newId() } };
    await expect(api.get(StoreAuthorizationService).start(ctx, { channel: "tiktokshop" })).rejects.toMatchObject({
      code: "store_authorization.user_required",
    });
  });
  it("stages before discovery, rotates the DEK and resumes without re-exchanging a consumed code", async () => {
    const { c, me } = await signup(api);
    const input = await begin(c);
    await callback(c, input);
    const ctx = userCtx(me.tenant.id, me.user.id);
    mock.failNext("GET", "/authorization/202309/shops", 429, { code: 36009002, message: "Throttled" });
    const connect = worker.ctx.get(StoreConnectService);
    const before = mock.callsTo("GET", "/api/v2/token/get").length;
    await expect(connect.complete(ctx, input, true)).rejects.toMatchObject({ kind: "transient" });
    expect((await auth(c, input.authorizationId)).status).toBe("exchanging");
    const staged = await withTenantTx(h.worker, ctx, (tx) =>
      tx.execute<{ grant_enc: Buffer }>(
        sql`SELECT grant_enc FROM store_authorization WHERE id=${input.authorizationId}`,
      ),
    );
    expect(staged.rows[0]!.grant_enc[0]).toBe(1);
    for (const token of mock.issued) expect(staged.rows[0]!.grant_enc.includes(Buffer.from(token))).toBe(false);
    const apiRole = await h.raw("api");
    await expect(apiRole.query("SELECT grant_enc FROM store_authorization")).rejects.toMatchObject({ code: "42501" });
    await expect(apiRole.query("UPDATE store_authorization SET grant_enc=NULL")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(apiRole.query("DELETE FROM store_authorization")).rejects.toMatchObject({ code: "42501" });
    await worker.ctx.get(KeyRotationService).run(ctx, newId());
    await Promise.all([connect.complete(ctx, input, true), connect.complete(ctx, input, true)]);
    expect((await auth(c, input.authorizationId)).status).toBe("succeeded");
    expect(mock.callsTo("GET", "/api/v2/token/get").length - before).toBe(1);
    const completed = await withTenantTx(h.worker, ctx, (tx) =>
      tx.execute(sql`SELECT grant_enc,grant_dek_version FROM store_authorization WHERE id=${input.authorizationId}`),
    );
    expect(completed.rows).toEqual([{ grant_enc: null, grant_dek_version: null }]);
  });

  it("binds callback to its original same-tenant requester and checks live permissions after discovery", async () => {
    const { c, me } = await signup(api);
    const role = (await c.post("/v1/roles", { name: "Pengelola toko", permissions: ["settings:store"] })).body;
    const email = uniqueEmail("seller");
    await c.post("/v1/invitations", { email, roleId: role.id });
    await drain(me.tenant.id);
    const member = client(api);
    await member.post("/v1/auth/invitations/accept", {
      token: tokenFrom(worker.email.lastTo(email)!.text),
      name: "Pengelola",
      password: PASSWORD,
    });
    const memberMe = (await member.get("/v1/me")).body;
    const input = await begin(member);
    expect(
      (
        await c.post("/v1/store-authorizations/callback", {
          channel: "tiktokshop",
          state: input.state,
          code: input.code,
        })
      ).status,
    ).toBe(422);
    await callback(member, input);
    const connector = worker.ctx.get<ConnectorRegistry>(CONNECTORS).get("tiktokshop");
    const describe = connector.shops.describe.bind(connector.shops);
    let patchStatus: number | undefined;
    const spy = vi.spyOn(connector.shops, "describe").mockImplementation(async (grant) => {
      const profiles = await describe(grant);
      patchStatus = (await c.patch(`/v1/roles/${role.id}`, { permissions: ["order:read"] })).status;
      return profiles;
    });
    try {
      await worker.ctx.get(StoreConnectService).complete(userCtx(me.tenant.id, memberMe.user.id), input, true);
    } finally {
      spy.mockRestore();
    }
    expect(patchStatus).toBe(200);
    expect(await auth(c, input.authorizationId)).toMatchObject({ status: "failed", errorCode: "permission_revoked" });
    const rows = await h.system.db.execute(
      sql`SELECT id FROM store WHERE tenant_id=${me.tenant.id} AND channel='tiktokshop'`,
    );
    expect(rows.rows).toEqual([]);
  });

  it("does not recreate credentials when a store is disconnected during refresh", async () => {
    const { c, me } = await signup(api);
    const input = await begin(c);
    await callback(c, input);
    const ctx = userCtx(me.tenant.id, me.user.id);
    await worker.ctx.get(StoreConnectService).complete(ctx, input, true);
    const storeId = (await auth(c, input.authorizationId)).result.stores[0].storeId as string;
    const connector = worker.ctx.get<ConnectorRegistry>(CONNECTORS).get("tiktokshop");
    const refresh = connector.auth.refresh.bind(connector.auth);
    const spy = vi.spyOn(connector.auth, "refresh").mockImplementation(async (grant) => {
      const tokens = await refresh(grant);
      expect((await c.post(`/v1/stores/${storeId}/disconnect`, { keepData: true })).status).toBe(200);
      return tokens;
    });
    try {
      expect(await worker.ctx.get(CredentialService).refresh(ctx, storeId, { force: true })).toBe("not_connected");
    } finally {
      spy.mockRestore();
    }
    const rows = await h.system.db.execute(sql`SELECT id FROM store_credential WHERE store_id=${storeId}`);
    expect(rows.rows).toEqual([]);
    expect((await c.get(`/v1/stores/${storeId}`)).body.status).toBe("disconnected");
  });
  it.each([false, true])(
    "preserves a newer authorization when the old refresh finishes (failure=%s)",
    async (failure) => {
      const { c, me } = await signup(api);
      const input = await begin(c);
      await callback(c, input);
      const ctx = userCtx(me.tenant.id, me.user.id);
      await worker.ctx.get(StoreConnectService).complete(ctx, input, true);
      const storeId = (await auth(c, input.authorizationId)).result.stores[0].storeId as string;
      const connector = worker.ctx.get<ConnectorRegistry>(CONNECTORS).get("tiktokshop");
      const refresh = connector.auth.refresh.bind(connector.auth);
      let reconnected: Buffer | undefined;
      const spy = vi.spyOn(connector.auth, "refresh").mockImplementation(async (grant) => {
        const tokens = await refresh(grant);
        const started = await c.post("/v1/store-authorizations", { channel: "tiktokshop", storeId });
        const next = {
          authorizationId: started.body.id as string,
          code: mock.tiktokCode(input.sellerId),
          state: new URL(started.body.authorizeUrl).searchParams.get("state")!,
        };
        await callback(c, next);
        await worker.ctx.get(StoreConnectService).complete(ctx, next, true);
        const saved = await h.system.db.execute<{ access_token_enc: Buffer }>(
          sql`SELECT access_token_enc FROM store_credential WHERE store_id=${storeId}`,
        );
        reconnected = saved.rows[0]!.access_token_enc;
        if (failure)
          throw new AuthRevokedError({ code: "invalid_refresh_token", message: "Old token no longer accepted" });
        return tokens;
      });
      try {
        if (failure)
          await expect(worker.ctx.get(CredentialService).refresh(ctx, storeId, { force: true })).rejects.toMatchObject({
            kind: "auth_revoked",
          });
        else
          expect(await worker.ctx.get(CredentialService).refresh(ctx, storeId, { force: true })).toBe("not_connected");
      } finally {
        spy.mockRestore();
      }
      const saved = await h.system.db.execute<{ access_token_enc: Buffer }>(
        sql`SELECT access_token_enc FROM store_credential WHERE store_id=${storeId}`,
      );
      expect(saved.rows[0]!.access_token_enc).toEqual(reconnected);
      expect((await c.get(`/v1/stores/${storeId}`)).body.status).toBe("active");
    },
  );
  it("expires abandoned staged grants through an idempotent scan and keeps authorization history", async () => {
    const { c, me } = await signup(api);
    const input = await begin(c);
    await callback(c, input);
    const ctx = userCtx(me.tenant.id, me.user.id);
    mock.failNext("GET", "/authorization/202309/shops", 429, { code: 36009002, message: "Throttled" });
    await expect(worker.ctx.get(StoreConnectService).complete(ctx, input, true)).rejects.toMatchObject({
      kind: "transient",
    });
    await h.system.db.execute(
      sql`UPDATE store_authorization SET expires_at=now()-interval '1 minute' WHERE id=${input.authorizationId}`,
    );
    const queues = new QueueRegistry(h.redis, `${h.infra.keyPrefix}_seller_cleanup`);
    try {
      const registry = new JobRegistry(JOB_DEFINITIONS);
      const now = new Date();
      expect(await scanStoreAuthorizations(h.system, queues, registry, now)).toBeGreaterThanOrEqual(1);
      const before = await queues.get("mp.outbound").getJobCounts("waiting");
      await scanStoreAuthorizations(h.system, queues, registry, now);
      expect(await queues.get("mp.outbound").getJobCounts("waiting")).toEqual(before);
      await worker.runJob(storeAuthorizationCleanupJob, { authorizationId: input.authorizationId }, me.tenant.id);
    } finally {
      await queues.close();
    }
    const rows = await h.system.db.execute(
      sql`SELECT status,grant_enc,grant_dek_version FROM store_authorization WHERE id=${input.authorizationId}`,
    );
    expect(rows.rows).toEqual([{ status: "expired", grant_enc: null, grant_dek_version: null }]);
  });

  it("cancels an in-flight seller authorization when the business closes and clears only its private grant", async () => {
    const { c, me } = await signup(api);
    const input = await begin(c);
    await callback(c, input);
    const ctx = userCtx(me.tenant.id, me.user.id);
    mock.failNext("GET", "/authorization/202309/shops", 429, { code: 36009002, message: "Throttled" });
    await expect(worker.ctx.get(StoreConnectService).complete(ctx, input, true)).rejects.toMatchObject({
      kind: "transient",
    });
    expect((await c.post("/v1/account-closure", { businessName: me.tenant.name, password: PASSWORD })).status).toBe(
      200,
    );
    await worker.runJob(storeAuthorizationCleanupJob, { authorizationId: input.authorizationId }, me.tenant.id);
    const rows = await h.system.db.execute(
      sql`SELECT status,grant_enc FROM store_authorization WHERE id=${input.authorizationId}`,
    );
    expect(rows.rows).toEqual([{ status: "failed", grant_enc: null }]);
    await worker.ctx.get(StoreConnectService).complete(ctx, input, true);
    expect(
      (await h.system.db.execute(sql`SELECT id FROM store WHERE tenant_id=${me.tenant.id} AND channel='tiktokshop'`))
        .rows,
    ).toEqual([]);
  });
  it("requires legacy seller connections without a verified identity to authorize again before refresh", async () => {
    const { c, me } = await signup(api);
    const input = await begin(c);
    await callback(c, input);
    const ctx = userCtx(me.tenant.id, me.user.id);
    await worker.ctx.get(StoreConnectService).complete(ctx, input, true);
    const storeId = (await auth(c, input.authorizationId)).result.stores[0].storeId as string;
    await h.system.db.execute(sql`UPDATE store SET marketplace_info=marketplace_info-'open_id' WHERE id=${storeId}`);
    const before = mock.callsTo("GET", "/api/v2/token/refresh").length;
    await expect(worker.ctx.get(CredentialService).refresh(ctx, storeId, { force: true })).rejects.toMatchObject({
      code: "account_mismatch",
    });
    expect(mock.callsTo("GET", "/api/v2/token/refresh").length).toBe(before);
    expect((await c.get(`/v1/stores/${storeId}`)).body.status).toBe("reauth_required");
  });
});
