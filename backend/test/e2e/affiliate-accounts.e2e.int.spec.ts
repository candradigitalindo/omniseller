import type { INestApplication } from "@nestjs/common";
import { PermanentConnectorError } from "@omniseller/connector-core";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { jobKey } from "../../src/jobs/job-id";
import { QueueRegistry } from "../../src/jobs/queues";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { affiliateGrantCleanupJob } from "../../src/modules/affiliate-accounts/accounts.jobs";
import { AffiliateAccountsService } from "../../src/modules/affiliate-accounts/accounts.service";
import { AffiliateAccountConnectService } from "../../src/modules/affiliate-accounts/accounts-connect.service";
import { AffiliateAccountCredentialsService } from "../../src/modules/affiliate-accounts/accounts-credentials.service";
import { CONNECTORS, type ConnectorRegistry } from "../../src/modules/channel/connector-registry";
import { KeyRotationService } from "../../src/modules/channel/key-rotation.service";
import { AFFILIATE_ACCOUNT_SCAN_MS, scanAffiliateAccounts } from "../../src/scheduler/affiliate-account-scan";
import { type Client, client, PASSWORD, signup, startApi, startWorker, tokenFrom, uniqueEmail } from "../setup/app";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace, type MockTiktokPrincipal } from "../setup/mock-marketplace";

const h = testHandles();
let api: INestApplication;
let mock: MockMarketplace;
let worker: Awaited<ReturnType<typeof startWorker>>;
const creatorPath = "/affiliate_creator/202508/profiles";
const assetsPath = "/authorization/202405/category_assets";
const base = "/v1/affiliate";
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
  for (let i = 0; i < 15; i++) if (!(await worker.runOutbox(tenantId)).length) return;
}
function principal(kind: "creator" | "affiliate_partner", patch: Partial<MockTiktokPrincipal> = {}) {
  const input: MockTiktokPrincipal = {
    openId: newId(),
    name: "Mitra uji",
    shops: [],
    userType: kind === "creator" ? 1 : 3,
    scopes: [kind === "creator" ? "creator.affiliate.info" : "partner.authorization.info"],
    categoryAssets: [
      { cipher: "private-category-fixture", target_market: "ID", category: { id: 123, name: "Fixture category" } },
    ],
    ...patch,
  };
  return { input, sellerId: mock.addTiktokSeller(input) };
}
async function begin(c: Client, kind: "creator" | "affiliate_partner", sellerId: string, accountId?: string) {
  const started = await c.post(`${base}/authorizations`, { kind, ...(accountId ? { accountId } : {}) });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const url = new URL(started.body.authorizeUrl);
  expect(url.searchParams.get(kind === "creator" ? "app_key" : "service_id")).toBeTruthy();
  const state = url.searchParams.get("state")!;
  expect(state).toMatch(/^a1_/);
  const code = mock.tiktokCode(sellerId);
  const received = await c.post(`${base}/authorizations/callback`, { state, code });
  expect(received.status, JSON.stringify(received.body)).toBe(201);
  return { id: started.body.id as string, code, state };
}
const auth = async (c: Client, id: string) => (await c.get(`${base}/authorizations/${id}`)).body;
const account = async (c: Client, id: string) => (await c.get(`${base}/accounts/${id}`)).body;

describe("creator and affiliate-partner accounts", () => {
  it("connects both account kinds independently of seller stores, hides private grants and preserves authorization history", async () => {
    const { c, me } = await signup(api);
    for (const kind of ["creator", "affiliate_partner"] as const) {
      const p = principal(kind);
      const started = await begin(c, kind, p.sellerId);
      expect(
        (await c.post(`${base}/authorizations/callback`, { state: started.state, code: started.code })).status,
      ).toBe(409);
      await drain(me.tenant.id);
      const result = await auth(c, started.id);
      expect(result).toMatchObject({ status: "succeeded", kind, accountId: expect.any(String) });
      const view = await account(c, result.accountId);
      expect(view).toMatchObject({ status: "active", kind, region: "ID", externalPrincipalId: p.input.openId });
      expect(JSON.stringify(view)).not.toContain("private-category-fixture");
      const renamed = await c
        .patch(`${base}/accounts/${view.id}`, { name: "Nama lokal" })
        .set("If-Match", String(view.rowVersion));
      expect(renamed.status).toBe(200);
      expect(
        (await c.patch(`${base}/accounts/${view.id}`, { name: "Stale" }).set("If-Match", String(view.rowVersion)))
          .status,
      ).toBe(412);
      const key = newId();
      expect((await c.post(`${base}/accounts/${view.id}/refresh`, {}).set("Idempotency-Key", key)).status).toBe(202);
      expect((await c.post(`${base}/accounts/${view.id}/refresh`, {}).set("Idempotency-Key", key)).status).toBe(202);
      await drain(me.tenant.id);
      expect((await c.post(`${base}/accounts/${view.id}/disconnect`, {})).status).toBe(204);
      expect((await account(c, view.id)).status).toBe("disconnected");
      expect((await auth(c, started.id)).status).toBe("succeeded");
      const ctx = userCtx(me.tenant.id, me.user.id);
      const credentials = await withTenantTx(h.worker, ctx, (tx) =>
        tx.execute(sql`SELECT id FROM affiliate_account_credential WHERE account_id=${view.id}`),
      );
      expect(credentials.rows).toEqual([]);
    }
    expect((await c.get("/v1/stores")).body.items).toEqual([]);
    expect(mock.callsTo("GET", assetsPath).length).toBeGreaterThan(0);
    expect(mock.callsTo("GET", "/authorization/202309/shops")).toHaveLength(0);
    const logs = await withTenantTx(h.worker, userCtx(me.tenant.id), (tx) =>
      tx.execute(sql`SELECT request_summary, response_summary FROM sync_job`),
    );
    const logged = JSON.stringify(logs.rows);
    expect(logged).not.toContain("private-category-fixture");
    for (const token of mock.issued) expect(logged).not.toContain(token);
    const audits = JSON.stringify((await c.get("/v1/audit-logs?entity_type=affiliate_authorization")).body);
    expect(audits).not.toContain("state_hash");
    expect(audits).not.toContain("grant_access_token_enc");
  });

  it("durably stages a grant, rotates its DEK, resumes a throttled verification and does not exchange the single-use code again", async () => {
    const { c, me } = await signup(api);
    const p = principal("creator");
    const started = await begin(c, "creator", p.sellerId);
    mock.failNext("GET", creatorPath, 429, { code: 36009002, message: "Throttled", data: {} });
    const connect = worker.ctx.get(AffiliateAccountConnectService);
    const ctx = userCtx(me.tenant.id, me.user.id);
    const before = mock.callsTo("GET", "/api/v2/token/get").length;
    await expect(connect.complete(ctx, started.id, started.code, 0)).rejects.toMatchObject({ kind: "transient" });
    expect((await auth(c, started.id)).status).toBe("verifying");
    await worker.ctx.get(KeyRotationService).run(ctx, newId());
    const staged = await withTenantTx(h.worker, ctx, (tx) =>
      tx.execute<{ grant_dek_version: number }>(
        sql`SELECT grant_dek_version FROM affiliate_authorization WHERE id=${started.id}`,
      ),
    );
    expect(staged.rows[0]?.grant_dek_version).toBe(2);
    await connect.complete(ctx, started.id, started.code, 1);
    expect((await auth(c, started.id)).status).toBe("succeeded");
    expect(mock.callsTo("GET", "/api/v2/token/get").length - before).toBe(1);
    const id = (await auth(c, started.id)).accountId;
    await worker.ctx.get(KeyRotationService).run(ctx, newId());
    const beforeRefresh = mock.callsTo("GET", "/api/v2/token/refresh").length;
    mock.failNext("GET", creatorPath, 429, { code: 36009002, message: "Throttled", data: {} });
    const credentials = worker.ctx.get(AffiliateAccountCredentialsService);
    await expect(credentials.refresh(ctx, id, true, true)).rejects.toMatchObject({ kind: "transient" });
    expect((await account(c, id)).status).toBe("verifying");
    await worker.ctx.get(KeyRotationService).run(ctx, newId());
    await credentials.refresh(ctx, id, true);
    expect((await account(c, id)).status).toBe("active");
    expect(mock.callsTo("GET", "/api/v2/token/refresh").length - beforeRefresh).toBe(1);
    const stagedAfter = await withTenantTx(h.worker, ctx, (tx) =>
      tx.execute(sql`SELECT grant_access_token_enc FROM affiliate_authorization WHERE id=${started.id}`),
    );
    expect(stagedAfter.rows[0]).toEqual({ grant_access_token_enc: null });
    await drain(me.tenant.id);
  });

  it("refuses seller tokens, missing scopes, non-Indonesia creators and partner assets outside Indonesia", async () => {
    const { c, me } = await signup(api);
    const publicAuth = api.get<ConnectorRegistry>(CONNECTORS).get("tiktokshop").accounts!;
    const urlSpy = vi.spyOn(publicAuth, "authorizeUrl").mockImplementationOnce(() => {
      throw new PermanentConnectorError({ code: "not_configured", message: "Missing public app key" });
    });
    try {
      const unavailable = await c.post(`${base}/authorizations`, { kind: "creator" });
      expect(unavailable.status).toBe(422);
      expect(unavailable.body.code).toBe("affiliate_account.not_configured");
    } finally {
      urlSpy.mockRestore();
    }

    for (const [kind, patch, errorCode] of [
      ["creator", { userType: 0 }, "wrong_user_type"],
      ["creator", { scopes: ["creator.video.write"] }, "missing_scope"],
      ["creator", { selectionRegion: "US" }, "region_not_supported"],
      ["affiliate_partner", { categoryAssets: [] }, "region_not_supported"],
    ] as const) {
      const p = principal(kind, patch as Partial<MockTiktokPrincipal>);
      const started = await begin(c, kind, p.sellerId);
      await drain(me.tenant.id);
      expect(await auth(c, started.id)).toMatchObject({ status: "failed", errorCode, accountId: null });
    }
    expect((await c.get(`${base}/accounts`)).body.items).toEqual([]);
  });

  it("enforces tenant state, reconnect identity and exclusive active ownership across tenants", async () => {
    const a = await signup(api);
    const b = await signup(api);
    const p = principal("creator");
    const pending = await a.c.post(`${base}/authorizations`, { kind: "creator" });
    const state = new URL(pending.body.authorizeUrl).searchParams.get("state");
    expect(
      (await b.c.post(`${base}/authorizations/callback`, { state, code: mock.tiktokCode(p.sellerId) })).status,
    ).toBe(409);
    expect((await b.c.get(`${base}/authorizations/${pending.body.id}`)).status).toBe(404);
    await a.c.post(`${base}/authorizations/callback`, { state, code: mock.tiktokCode(p.sellerId) });
    await drain(a.me.tenant.id);
    const id = (await auth(a.c, pending.body.id)).accountId;
    expect((await b.c.post(`${base}/authorizations`, { kind: "creator", accountId: id })).status).toBe(404);
    const duplicate = await begin(b.c, "creator", p.sellerId);
    await drain(b.me.tenant.id);
    expect(await auth(b.c, duplicate.id)).toMatchObject({ status: "failed", errorCode: "connected_elsewhere" });
    const other = principal("creator");
    const mismatch = await begin(a.c, "creator", other.sellerId, id);
    await drain(a.me.tenant.id);
    expect(await auth(a.c, mismatch.id)).toMatchObject({ status: "failed", errorCode: "account_mismatch" });
    expect((await account(a.c, id)).externalPrincipalId).toBe(p.input.openId);
  });

  it("keeps a new refresh grant when profile probing fails, and never revives an account disconnected during a probe", async () => {
    const { c, me } = await signup(api);
    const p = principal("creator");
    const started = await begin(c, "creator", p.sellerId);
    await drain(me.tenant.id);
    const id = (await auth(c, started.id)).accountId;
    const ctx = userCtx(me.tenant.id, me.user.id);
    const gateway = worker.ctx.get(AffiliateAccountCredentialsService);
    // A permanent profile refusal must stop further business calls until reauthorization.
    mock.failNext("GET", creatorPath, 403, { code: 105005, message: "Permission denied", data: {} });
    await gateway.refresh(ctx, id, false, true);
    expect((await account(c, id)).status).toBe("reauth_required");
    expect((await c.post(`${base}/accounts/${id}/refresh`, {}).set("Idempotency-Key", newId())).status).toBe(409);
    const again = await begin(c, "creator", p.sellerId, id);
    await drain(me.tenant.id);
    expect((await auth(c, again.id)).status).toBe("succeeded");
    await c.post(`${base}/accounts/${id}/disconnect`, {});
    await gateway.refresh(ctx, id, false, true);
    expect((await account(c, id)).status).toBe("disconnected");
  });

  it("survives DEK rotation during refresh/probe and respects disconnect racing the probe", async () => {
    const { c, me } = await signup(api);
    const p = principal("creator");
    const started = await begin(c, "creator", p.sellerId);
    await drain(me.tenant.id);
    const id = (await auth(c, started.id)).accountId;
    const ctx = userCtx(me.tenant.id, me.user.id);
    const connector = worker.ctx.get<ConnectorRegistry>(CONNECTORS).get("tiktokshop").accounts!;
    const refreshOriginal = connector.refresh.bind(connector);
    const describeOriginal = connector.describe.bind(connector);
    const rotation = worker.ctx.get(KeyRotationService);
    const refreshSpy = vi.spyOn(connector, "refresh").mockImplementationOnce(async (input) => {
      const result = await refreshOriginal(input);
      await rotation.run(ctx, newId());
      return result;
    });
    const describeSpy = vi.spyOn(connector, "describe").mockImplementationOnce(async (input) => {
      const result = await describeOriginal(input);
      await rotation.run(ctx, newId());
      return result;
    });
    try {
      await worker.ctx.get(AffiliateAccountCredentialsService).refresh(ctx, id, false, true);
      expect((await account(c, id)).status).toBe("active");
      describeSpy.mockImplementationOnce(async (input) => {
        await describeOriginal(input);
        const again = await begin(c, "creator", p.sellerId, id);
        await worker.ctx.get(AffiliateAccountConnectService).complete(ctx, again.id, again.code, 0);
        throw new PermanentConnectorError({ code: "old_authorization_revoked", message: "Old token revoked" });
      });
      await worker.ctx.get(AffiliateAccountCredentialsService).refresh(ctx, id, false, true);
      expect((await account(c, id)).status).toBe("active");
      describeSpy.mockImplementationOnce(async (input) => {
        const result = await describeOriginal(input);
        await worker.ctx.get(AffiliateAccountsService).disconnect(ctx, id);
        return result;
      });
      await worker.ctx.get(AffiliateAccountCredentialsService).refresh(ctx, id, false, true);
      expect((await account(c, id)).status).toBe("disconnected");
      const rows = await withTenantTx(h.worker, ctx, (tx) =>
        tx.execute(sql`SELECT id FROM affiliate_account_credential WHERE account_id=${id}`),
      );
      expect(rows.rows).toEqual([]);
    } finally {
      refreshSpy.mockRestore();
      describeSpy.mockRestore();
    }
  });

  it("uses dynamic tenant account permissions and rechecks permission revoked after callback", async () => {
    const { c, me } = await signup(api);
    const role = (
      await c.post("/v1/roles", {
        name: "Pengelola creator",
        permissions: ["affiliate:account_read", "affiliate:account_write"],
      })
    ).body;
    const email = uniqueEmail("creator");
    await c.post("/v1/invitations", { email, roleId: role.id });
    await drain(me.tenant.id);
    const member = client(api);
    await member.post("/v1/auth/invitations/accept", {
      token: tokenFrom(worker.email.lastTo(email)!.text),
      name: "Mitra",
      password: PASSWORD,
    });
    const p = principal("creator");
    const user = (await member.get("/v1/me")).body.user;
    expect((await c.put(`/v1/users/${user.id}/scopes`, { storeIds: [], warehouseIds: [] })).status).toBe(200);
    const pending = await member.post(`${base}/authorizations`, { kind: "creator" });
    expect(pending.status).toBe(201);
    const state = new URL(pending.body.authorizeUrl).searchParams.get("state");
    const code = mock.tiktokCode(p.sellerId);
    expect((await c.post(`${base}/authorizations/callback`, { state, code })).status).toBe(409);
    expect((await member.post(`${base}/authorizations/callback`, { state, code })).status).toBe(201);
    const started = { id: pending.body.id };
    expect((await c.patch(`/v1/roles/${role.id}`, { permissions: ["affiliate:account_read"] })).status).toBe(200);
    await drain(me.tenant.id);
    expect(await auth(c, started.id)).toMatchObject({ status: "failed", errorCode: "permission_revoked" });
    expect((await member.get(`${base}/accounts`)).status).toBe(200);
    expect((await member.post(`${base}/authorizations`, { kind: "creator" })).status).toBe(403);
  });

  it("schedules due accounts once per slot and expires abandoned authorization without deleting history", async () => {
    const { c, me } = await signup(api);
    const p = principal("creator");
    const started = await begin(c, "creator", p.sellerId);
    await drain(me.tenant.id);
    const id = (await auth(c, started.id)).accountId;
    const pending = await c.post(`${base}/authorizations`, { kind: "creator" });
    const ctx = userCtx(me.tenant.id, me.user.id);
    await withTenantTx(h.worker, ctx, async (tx) => {
      await tx.execute(sql`UPDATE affiliate_account SET access_expires_at=now()-interval '1 second' WHERE id=${id}`);
      await tx.execute(
        sql`UPDATE affiliate_authorization SET expires_at=now()-interval '1 second' WHERE id=${pending.body.id}`,
      );
    });
    const queues = new QueueRegistry(h.redis, h.infra.keyPrefix);
    const registry = new JobRegistry(JOB_DEFINITIONS);
    const now = new Date();
    const slot = `s${Math.floor(now.getTime() / AFFILIATE_ACCOUNT_SCAN_MS)}`;
    try {
      await scanAffiliateAccounts(h.system, queues, registry, now);
      await scanAffiliateAccounts(h.system, queues, registry, now);
      const job = await queues.get("mp.outbound").getJob(jobKey("affiliate_account.refresh", id, slot));
      expect(job?.data).toMatchObject({ accountId: id, tenantId: me.tenant.id });
      const cleanup = await queues
        .get("mp.outbound")
        .getJob(jobKey("affiliate_account.grant_cleanup", pending.body.id, slot));
      expect(cleanup?.data.authorizationId).toBe(pending.body.id);
      await worker.runJob(affiliateGrantCleanupJob, { authorizationId: pending.body.id }, me.tenant.id);
      expect(await auth(c, pending.body.id)).toMatchObject({ status: "expired" });
      await h.system.db.execute(sql`UPDATE tenant SET status='suspended' WHERE id=${me.tenant.id}`);
      const later = new Date(now.getTime() + AFFILIATE_ACCOUNT_SCAN_MS);
      await scanAffiliateAccounts(h.system, queues, registry, later);
      expect(
        await queues
          .get("mp.outbound")
          .getJob(
            jobKey("affiliate_account.refresh", id, `s${Math.floor(later.getTime() / AFFILIATE_ACCOUNT_SCAN_MS)}`),
          ),
      ).toBeUndefined();
    } finally {
      await h.system.db.execute(sql`UPDATE tenant SET status='active' WHERE id=${me.tenant.id}`);
      await queues.close();
    }
  });

  it("soft-cancels pending connections on closure, retains history, cleans staged grants and exports metadata only", async () => {
    const { c, me } = await signup(api);
    const p = principal("affiliate_partner");
    const started = await begin(c, "affiliate_partner", p.sellerId);
    await drain(me.tenant.id);
    const id = (await auth(c, started.id)).accountId;
    const p2 = principal("creator");
    const pending = await begin(c, "creator", p2.sellerId);
    mock.failNext("GET", creatorPath, 429, { code: 36009002, message: "Throttled", data: {} });
    const ctx = userCtx(me.tenant.id, me.user.id);
    await expect(
      worker.ctx.get(AffiliateAccountConnectService).complete(ctx, pending.id, pending.code, 0),
    ).rejects.toMatchObject({ kind: "transient" });
    expect((await c.post("/v1/account-closure", { businessName: "Toko Uji Coba", password: PASSWORD })).status).toBe(
      200,
    );
    await drain(me.tenant.id);
    expect((await account(c, id)).status).toBe("disconnected");
    expect(await auth(c, pending.id)).toMatchObject({ status: "failed", errorCode: "business_closed" });
    const rows = await withTenantTx(h.worker, ctx, (tx) =>
      tx.execute(sql`SELECT grant_access_token_enc FROM affiliate_authorization WHERE id=${pending.id}`),
    );
    expect(rows.rows).toEqual([{ grant_access_token_enc: null }]);
    const sheets = worker.ctx.get(AffiliateAccountsService).exportSheets();
    const exported: unknown[] = [];
    await withTenantTx(h.worker, ctx, async (tx) => {
      for (const sheet of sheets)
        for await (const page of sheet.pages(tx, {
          storeName: () => null,
          warehouseCode: () => null,
          userName: () => null,
        }))
          exported.push(...page);
    });
    const text = JSON.stringify(exported);
    expect(text).not.toContain("private-category-fixture");
    expect(text).not.toContain(pending.code);
    expect(text).not.toContain(pending.state);
    for (const token of mock.issued) expect(text).not.toContain(token);
  });
});
