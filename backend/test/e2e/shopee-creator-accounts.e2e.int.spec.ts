import { createHmac } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { parseJsonSafe } from "@omniseller/connector-core";
import { createShopeeConnector } from "@omniseller/connector-shopee";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { AffiliateAccountCredentialsService } from "../../src/modules/affiliate-accounts/accounts-credentials.service";
import { CONNECTORS, type ConnectorRegistry } from "../../src/modules/channel/connector-registry";
import { connectorCallObserver, connectorRequestGate } from "../../src/modules/sync/connector-calls";
import { type Client, signup, startApi, startWorker } from "../setup/app";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace, SHOPEE } from "../setup/mock-marketplace";

const h = testHandles();
let api: INestApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let mock: MockMarketplace;
const restores: (() => void)[] = [];
const base = "/v1/affiliate";
let seq = 100;
const codes = new Map<string, string>();
const refreshTokens = new Map<string, string>();
const calls: { path: string; body: Record<string, unknown> }[] = [];
let onExchange: (() => Promise<void>) | undefined;

/** Validates actual wire HMAC and token rotation without granting seller authorization. */
const userTransport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  expect(url.origin).toBe("https://shopee-creator-fixture.invalid");
  expect(init?.method).toBe("POST");
  const timestamp = url.searchParams.get("timestamp")!;
  expect(Math.abs(Date.now() - Number(timestamp) * 1000)).toBeLessThan(300_000);
  const expected = createHmac("sha256", SHOPEE.partnerKey)
    .update(`${SHOPEE.partnerId}${url.pathname}${timestamp}`)
    .digest("hex");
  expect(url.searchParams.get("sign")).toBe(expected);
  expect(url.searchParams.get("shop_id")).toBeNull();
  expect(url.searchParams.get("user_id")).toBeNull();
  const body = parseJsonSafe(String(init?.body)) as Record<string, unknown>;
  expect(body.partner_id).toBe(SHOPEE.partnerId);
  calls.push({ path: url.pathname, body });
  let id: string | undefined;
  if (url.pathname === "/api/v2/auth/token/get") {
    id = codes.get(String(body.code));
    codes.delete(String(body.code));
    await onExchange?.();
  } else {
    expect(url.pathname).toBe("/api/v2/auth/access_token/get");
    id = refreshTokens.get(String(body.refresh_token));
    refreshTokens.delete(String(body.refresh_token));
    expect(String(body.user_id)).toBe(id);
    expect(String(init?.body)).toContain(`"user_id":${id}`);
  }
  if (!id) return Response.json({ error: "invalid_code", message: "Invalid single-use grant" });
  const token = `creator-private-access-${++seq}`;
  const refresh = `creator-private-refresh-${seq}`;
  refreshTokens.set(refresh, id);
  return Response.json({
    error: "",
    request_id: `creator-grant-${seq}`,
    access_token: token,
    refresh_token: refresh,
    expire_in: 14_400,
    ...(url.pathname.endsWith("/access_token/get") ? { user_id: id } : { user_id_list: [id] }),
  });
};

beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  api = await startApi(h.infra, { marketplace: mock });
  worker = await startWorker(h.infra, h.system, { marketplace: mock });
  for (const app of [api, worker.ctx]) {
    const registry = app.get<ConnectorRegistry>(CONNECTORS);
    const original = registry.get.bind(registry);
    const connector = createShopeeConnector({
      ...SHOPEE,
      apiBaseUrl: "https://shopee-creator-fixture.invalid",
      authBaseUrl: "https://open.shopee.com",
      accountRedirectUri: "http://localhost:3000/integrasi/callback/shopee",
      http: { fetch: userTransport, observer: connectorCallObserver, beforeRequest: connectorRequestGate },
    });
    const spy = vi
      .spyOn(registry, "get")
      .mockImplementation((channel) => (channel === "shopee" ? connector : original(channel)));
    restores.push(() => spy.mockRestore());
  }
});
afterAll(async () => {
  for (const restore of restores) restore();
  await worker?.close();
  await api?.close();
  await mock?.close();
});
async function drain(tenantId: string) {
  for (let n = 0; n < 12; n++) if (!(await worker.runOutbox(tenantId)).length) return;
}
async function begin(c: Client, id: string, program: "video" | "live" = "video", accountId?: string) {
  const result = await c.post(`${base}/authorizations`, {
    channel: "shopee",
    kind: "creator",
    program,
    ...(accountId ? { accountId } : {}),
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const url = new URL(result.body.authorizeUrl);
  expect(url.pathname).toBe("/auth");
  expect(url.searchParams.get("auth_type")).toBe("user");
  expect(url.searchParams.get("redirect_uri")).toContain("/integrasi/callback/shopee");
  const state = url.searchParams.get("state")!;
  const code = newId();
  codes.set(code, id);
  return { id: result.body.id as string, state, code };
}
const status = async (c: Client, id: string) => (await c.get(`${base}/authorizations/${id}`)).body;
async function receive(c: Client, pending: Awaited<ReturnType<typeof begin>>, channel = "shopee") {
  return c.post(`${base}/authorizations/callback`, { channel, state: pending.state, code: pending.code });
}

describe("Shopee Video/LIVE creator authorization", () => {
  it("connects through the outbox with exact user identity and explicit unverified account country", async () => {
    const { c, me } = await signup(api);
    const id = "9007199254740993";
    const pending = await begin(c, id);
    const before = calls.length;
    expect((await receive(c, pending)).status).toBe(201);
    expect(calls).toHaveLength(before);
    expect((await receive(c, pending)).status).toBe(409);
    await drain(me.tenant.id);
    const result = await status(c, pending.id);
    expect(result).toMatchObject({ status: "succeeded", channel: "shopee", program: "video" });
    const account = (await c.get(`${base}/accounts/${result.accountId}`)).body;
    expect(account).toMatchObject({
      channel: "shopee",
      kind: "creator",
      externalPrincipalId: id,
      status: "active",
      region: "ID",
      regionVerified: false,
      scopes: [],
    });
    expect(account.profile).toMatchObject({ regionVerification: "unverified", appEligibility: "unverified" });
    expect((await c.get("/v1/stores")).body.items).toEqual([]);
    const ctx = userCtx(me.tenant.id, me.user.id);
    const routing = await withTenantTx(h.api, ctx, (tx) =>
      tx.execute(sql`SELECT * FROM resolve_affiliate_account('tiktokshop','creator',${id})`),
    );
    expect(routing.rows).toEqual([]);
    const logs = await withTenantTx(h.worker, ctx, (tx) =>
      tx.execute(sql`SELECT request_summary,response_summary FROM sync_job`),
    );
    expect(JSON.stringify(logs.rows)).not.toContain("creator-private-");
    expect(JSON.stringify(logs.rows)).not.toContain(pending.code);
    const rawApi = await h.raw("api");
    await expect(rawApi.query("SELECT grant_access_token_enc FROM affiliate_authorization")).rejects.toMatchObject({
      code: "42501",
    });
    await worker.ctx.get(AffiliateAccountCredentialsService).refresh(ctx, result.accountId, true, true);
    expect(calls.at(-1)?.body.user_id).toBe(id);
    expect((await c.get(`${base}/accounts/${result.accountId}`)).body).toMatchObject({
      status: "active",
      regionVerified: false,
    });
    expect((await c.post(`${base}/accounts/${result.accountId}/disconnect`, {})).status).toBe(204);
    expect((await status(c, pending.id)).status).toBe("succeeded");
  });

  it("binds callback to the requested marketplace, user and tenant and rejects unavailable account programs", async () => {
    const a = await signup(api);
    const b = await signup(api);
    const pending = await begin(a.c, "9901001", "live");
    expect((await receive(b.c, pending)).status).toBe(409);
    expect((await receive(a.c, pending, "tiktokshop")).status).toBe(409);
    expect(
      (await a.c.post(`${base}/authorizations`, { channel: "shopee", kind: "affiliate_partner", program: "live" }))
        .status,
    ).toBe(422);
    expect((await a.c.post(`${base}/authorizations`, { channel: "shopee", kind: "creator" })).status).toBe(422);
    expect((await receive(a.c, pending)).status).toBe(201);
    await drain(a.me.tenant.id);
    expect(await status(a.c, pending.id)).toMatchObject({ status: "succeeded", program: "live" });
  });

  it("keeps platform namespaces separate and rejects duplicate tenant ownership or swapped reauthorization identities", async () => {
    const a = await signup(api);
    const b = await signup(api);
    const id = "9902001";
    await withTenantTx(h.worker, userCtx(a.me.tenant.id), (tx) =>
      tx.execute(
        sql`INSERT INTO affiliate_account(id,tenant_id,kind,external_principal_id,name) VALUES(${newId()},${a.me.tenant.id},'creator',${id},'TikTok namespace fixture')`,
      ),
    );
    const first = await begin(a.c, id);
    await receive(a.c, first);
    await drain(a.me.tenant.id);
    const accountId = (await status(a.c, first.id)).accountId;
    expect(accountId).toBeTruthy();
    const duplicate = await begin(b.c, id);
    await receive(b.c, duplicate);
    await drain(b.me.tenant.id);
    expect(await status(b.c, duplicate.id)).toMatchObject({ status: "failed", errorCode: "connected_elsewhere" });
    const swapped = await begin(a.c, "9902002", "live", accountId);
    await receive(a.c, swapped);
    await drain(a.me.tenant.id);
    expect(await status(a.c, swapped.id)).toMatchObject({ status: "failed", errorCode: "account_mismatch" });
    expect((await a.c.get(`${base}/accounts/${accountId}`)).body.externalPrincipalId).toBe(id);
  });

  it("does not restore an account disconnected while an unbound grant is being exchanged", async () => {
    const { c, me } = await signup(api);
    const first = await begin(c, "9902501");
    await receive(c, first);
    await drain(me.tenant.id);
    const accountId = (await status(c, first.id)).accountId;
    const pending = await begin(c, "9902501", "live");
    await receive(c, pending);
    onExchange = async () => {
      expect((await c.post(`${base}/accounts/${accountId}/disconnect`, {})).status).toBe(204);
    };
    try {
      await drain(me.tenant.id);
    } finally {
      onExchange = undefined;
    }
    expect(await status(c, pending.id)).toMatchObject({ status: "failed", errorCode: "stale_authorization" });
    expect((await c.get(`${base}/accounts/${accountId}`)).body.status).toBe("disconnected");
    const credentials = await withTenantTx(h.worker, userCtx(me.tenant.id), (tx) =>
      tx.execute(sql`SELECT id FROM affiliate_account_credential WHERE account_id=${accountId}`),
    );
    expect(credentials.rows).toEqual([]);
  });

  it("does not commit a creator grant when the requesting user is disabled during exchange", async () => {
    const { c, me } = await signup(api);
    const pending = await begin(c, "9903001");
    await receive(c, pending);
    onExchange = async () => {
      await withTenantTx(h.worker, userCtx(me.tenant.id), (tx) =>
        tx.execute(sql`UPDATE "user" SET status='disabled' WHERE id=${me.user.id}`),
      );
    };
    try {
      await drain(me.tenant.id);
    } finally {
      onExchange = undefined;
    }
    const row = await withTenantTx(h.worker, userCtx(me.tenant.id), (tx) =>
      tx.execute(
        sql`SELECT status,error_code,grant_access_token_enc FROM affiliate_authorization WHERE id=${pending.id}`,
      ),
    );
    expect(row.rows[0]).toMatchObject({
      status: "failed",
      error_code: "permission_revoked",
      grant_access_token_enc: null,
    });
  });
});
