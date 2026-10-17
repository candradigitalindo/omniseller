import { createHmac } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { affiliateAccountAuthorizeJob } from "../../src/modules/affiliate-accounts/accounts.jobs";
import { storeAuthorizeJob, storeInstallationConnectJob } from "../../src/modules/channel/channel.jobs";
import { CONNECTORS, type ConnectorRegistry } from "../../src/modules/channel/connector-registry";
import { CredentialService } from "../../src/modules/channel/credential.service";
import { MarketplaceApplicationsService } from "../../src/modules/channel/marketplace-applications.service";
import { signup, startApi, startWebhook, startWorker, WEBHOOK_URL } from "../setup/app";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";

const h = testHandles();
let api: INestApplication;
let hooks: Awaited<ReturnType<typeof startWebhook>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let sequence = 0;
type Owner = Awaited<ReturnType<typeof signup>>;
const apps = new Map<string, { secret: string; shopId: string; token: string }>();
const calls: { app: string; path: string }[] = [];

/** No app credentials exist in the process environment. Real clients must use the tenant's row. */
const transport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const appId = url.searchParams.get(url.hostname.includes("shopee") ? "partner_id" : "app_key")!;
  const app = apps.get(appId);
  expect(app, `unregistered fixture application ${appId}`).toBeTruthy();
  calls.push({ app: appId, path: url.pathname });
  if (url.hostname.includes("shopee")) {
    const path = url.pathname;
    const auth = path.includes("/auth/");
    const base = `${appId}${path}${url.searchParams.get("timestamp")}${auth ? "" : (url.searchParams.get("access_token") ?? "") + (url.searchParams.get("shop_id") ?? "")}`;
    expect(url.searchParams.get("sign")).toBe(createHmac("sha256", app!.secret).update(base).digest("hex"));
    if (auth) {
      const body = JSON.parse(String(init?.body));
      expect(String(body.partner_id)).toBe(appId);
      if (body.code === `creator-${appId}`)
        return Response.json({
          error: "",
          request_id: "tenant-creator",
          user_id_list: [app!.shopId],
          access_token: app!.token,
          refresh_token: `refresh-${appId}`,
          expire_in: 14400,
        });
      expect(String(body.shop_id)).toBe(app!.shopId);
      if (path.endsWith("access_token/get")) expect(body.refresh_token).toBe(`refresh-${appId}`);
      else expect(body.code).toBe(`code-${appId}`);
      return Response.json({
        error: "",
        request_id: "tenant-token",
        access_token: app!.token,
        refresh_token: `refresh-${appId}`,
        expire_in: 14400,
      });
    }
    expect(url.searchParams.get("access_token")).toBe(app!.token);
    expect(url.searchParams.get("shop_id")).toBe(app!.shopId);
    if (path.endsWith("get_shop_info"))
      return Response.json({
        error: "",
        request_id: "tenant-shop",
        shop_name: `Shop ${appId}`,
        region: "ID",
        status: "NORMAL",
        is_cb: false,
      });
    if (path.endsWith("get_profile")) return Response.json({ error: "", request_id: "tenant-profile", response: {} });
  } else {
    if (url.hostname === "auth.tiktok-shops.com") {
      expect(url.searchParams.get("app_secret")).toBe(app!.secret);
      if (url.pathname.endsWith("/refresh")) expect(url.searchParams.get("refresh_token")).toBe(`refresh-${appId}`);
      else expect(url.searchParams.get("auth_code")).toBe(`code-${appId}`);
      return Response.json({
        code: 0,
        request_id: "tenant-token",
        data: {
          user_type: 0,
          open_id: `seller-${appId}`,
          access_token: app!.token,
          refresh_token: `refresh-${appId}`,
          access_token_expire_in: Math.floor(Date.now() / 1000) + 14400,
          refresh_token_expire_in: Math.floor(Date.now() / 1000) + 86400,
          granted_scopes: ["seller.authorization.info"],
        },
      });
    }
    const params = [...url.searchParams]
      .filter(([key]) => !["sign", "access_token"].includes(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => key + value)
      .join("");
    const base = `${app!.secret}${url.pathname}${params}${init?.body ?? ""}${app!.secret}`;
    expect(url.searchParams.get("sign")).toBe(createHmac("sha256", app!.secret).update(base).digest("hex"));
    expect(new Headers(init?.headers).get("x-tts-access-token")).toBe(app!.token);
    if (url.pathname === "/authorization/202309/shops")
      return Response.json({
        code: 0,
        request_id: "tenant-shops",
        data: {
          shops: [
            { id: app!.shopId, cipher: `cipher-${appId}`, name: `Shop ${appId}`, region: "ID", seller_type: "LOCAL" },
          ],
        },
      });
  }
  throw new Error(`Unreviewed fixture request ${url.hostname}${url.pathname}`);
};

beforeAll(async () => {
  api = await startApi(h.infra);
  hooks = await startWebhook(h.infra);
  worker = await startWorker(h.infra, h.system);
  vi.stubGlobal("fetch", transport);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await worker?.close();
  await hooks?.close();
  await api?.close();
});

async function configure(owner: Owner, channel: "shopee" | "tiktokshop") {
  const id = channel === "shopee" ? String(4100000 + ++sequence) : `tenant-app-${++sequence}`;
  const secret = `PRIVATE_APP_SECRET_${id}`;
  const shopId = String(7400000010000000n + BigInt(sequence));
  apps.set(id, { secret, shopId, token: `PRIVATE_ACCESS_${id}` });
  const response = await owner.c.put(`/v1/marketplace-applications/${channel}`, {
    secret,
    ...(channel === "shopee" ? { partnerId: id } : { appKey: id, serviceId: `service-${id}` }),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return { id, secret, shopId, application: response.body };
}
async function connect(owner: Owner, channel: "shopee" | "tiktokshop", app: Awaited<ReturnType<typeof configure>>) {
  const started = await owner.c.post("/v1/store-authorizations", { channel });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const url = new URL(started.body.authorizeUrl);
  expect(url.searchParams.get(channel === "shopee" ? "partner_id" : "service_id")).toBe(
    channel === "shopee" ? app.id : `service-${app.id}`,
  );
  const code = `code-${app.id}`;
  const callback = await owner.c.post("/v1/store-authorizations/callback", {
    channel,
    state: url.searchParams.get("state"),
    code,
    ...(channel === "shopee" ? { shopId: app.shopId } : {}),
  });
  expect(callback.status).toBe(202);
  await worker.runJob(
    storeAuthorizeJob,
    { authorizationId: started.body.id, code, ...(channel === "shopee" ? { shopId: app.shopId } : {}) },
    owner.me.tenant.id,
  );
  const result = await owner.c.get(`/v1/store-authorizations/${started.body.id}`);
  expect(result.body.status, JSON.stringify(result.body)).toBe("succeeded");
  return result.body.result.stores[0].storeId as string;
}

describe("tenant-owned marketplace applications", () => {
  it("enables only the configuring tenant and never returns or audits its secret", async () => {
    const a = await signup(api);
    const b = await signup(api);
    expect((await a.c.get("/v1/channels")).body.items.every((item: { available: boolean }) => !item.available)).toBe(
      true,
    );
    const app = await configure(a, "shopee");
    expect(
      (await a.c.get("/v1/channels")).body.items.find((item: { id: string }) => item.id === "shopee").available,
    ).toBe(true);
    expect((await b.c.get("/v1/channels")).body.items.every((item: { available: boolean }) => !item.available)).toBe(
      true,
    );
    const settings = await a.c.get("/v1/marketplace-applications");
    expect(settings.body.items[0]).toMatchObject({ source: "tenant", partnerId: app.id, secretConfigured: true });
    expect(JSON.stringify(settings.body)).not.toContain(app.secret);
    expect(JSON.stringify(settings.body)).not.toContain("secretEnc");
    const encrypted = await withTenantTx(h.worker, userCtx(a.me.tenant.id, a.me.user.id), (tx) =>
      tx.execute<{ secret_enc: Buffer }>(sql`SELECT secret_enc FROM marketplace_application`),
    );
    expect(encrypted.rows[0]!.secret_enc.toString()).not.toContain(app.secret);
    const invisible = await withTenantTx(h.worker, userCtx(b.me.tenant.id, b.me.user.id), (tx) =>
      tx.execute(sql`SELECT id FROM marketplace_application WHERE id=${app.application.applicationId}`),
    );
    expect(invisible.rows).toHaveLength(0);
    const audit = await withTenantTx(h.worker, userCtx(a.me.tenant.id, a.me.user.id), (tx) =>
      tx.execute(sql`SELECT before,after FROM audit_log WHERE entity_type='marketplace_application'`),
    );
    expect(JSON.stringify(audit.rows)).not.toContain(app.secret);
    expect(JSON.stringify(audit.rows)).not.toContain("secret_enc");
    expect(JSON.stringify(audit.rows)).not.toContain(app.id);
  });

  it("uses each tenant's Shopee identity and HMAC for code exchange, discovery and refresh", async () => {
    const a = await signup(api);
    const b = await signup(api);
    const aa = await configure(a, "shopee");
    const bb = await configure(b, "shopee");
    const [sa, sb] = await Promise.all([connect(a, "shopee", aa), connect(b, "shopee", bb)]);
    const credentials = worker.ctx.get(CredentialService);
    expect(await credentials.refresh(userCtx(a.me.tenant.id, a.me.user.id), sa, { force: true })).toBe("refreshed");
    expect(await credentials.refresh(userCtx(b.me.tenant.id, b.me.user.id), sb, { force: true })).toBe("refreshed");
    expect(calls.filter((call) => call.app === aa.id).map((call) => call.path)).toContain(
      "/api/v2/auth/access_token/get",
    );
    expect(calls.filter((call) => call.app === bb.id).map((call) => call.path)).toContain(
      "/api/v2/auth/access_token/get",
    );
  });

  it("connects Tokopedia & Shop with a tenant's Service ID, App Key and App Secret", async () => {
    const owner = await signup(api);
    const app = await configure(owner, "tiktokshop");
    const storeId = await connect(owner, "tiktokshop", app);
    expect(
      await worker.ctx
        .get(CredentialService)
        .refresh(userCtx(owner.me.tenant.id, owner.me.user.id), storeId, { force: true }),
    ).toBe("refreshed");
    expect(calls.filter((call) => call.app === app.id).map((call) => call.path)).toEqual([
      "/api/v2/token/get",
      "/authorization/202309/shops",
      "/api/v2/token/refresh",
    ]);
    expect(app.application.redirectUrl).toContain(`application_id=${app.application.applicationId}`);
  });

  it("uses tenant credentials for the separate Shopee creator authorization flow", async () => {
    const owner = await signup(api);
    const app = await configure(owner, "shopee");
    const started = await owner.c.post("/v1/affiliate/authorizations", {
      channel: "shopee",
      kind: "creator",
      program: "live",
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const url = new URL(started.body.authorizeUrl);
    expect(url.searchParams.get("partner_id")).toBe(app.id);
    expect(url.searchParams.get("auth_type")).toBe("user");
    const code = `creator-${app.id}`;
    const callback = await owner.c.post("/v1/affiliate/authorizations/callback", {
      channel: "shopee",
      state: url.searchParams.get("state"),
      code,
    });
    expect(callback.status).toBe(201);
    await worker.runJob(affiliateAccountAuthorizeJob, { authorizationId: started.body.id, code }, owner.me.tenant.id);
    const accounts = await owner.c.get("/v1/affiliate/accounts");
    expect(accounts.body.items).toHaveLength(1);
    expect(accounts.body.items[0]).toMatchObject({
      channel: "shopee",
      program: "live",
      status: "active",
      externalPrincipalId: app.shopId,
    });
  });

  it("cannot decrypt an application secret copied into another tenant's row", async () => {
    const a = await signup(api);
    const b = await signup(api);
    const aa = await configure(a, "shopee");
    const bb = await configure(b, "shopee");
    const encrypted = await withTenantTx(h.worker, userCtx(a.me.tenant.id, a.me.user.id), (tx) =>
      tx.execute<{ secret_enc: Buffer }>(
        sql`SELECT secret_enc FROM marketplace_application WHERE id=${aa.application.applicationId}`,
      ),
    );
    await withTenantTx(h.worker, userCtx(b.me.tenant.id, b.me.user.id), (tx) =>
      tx.execute(
        sql`UPDATE marketplace_application SET secret_enc=${encrypted.rows[0]!.secret_enc} WHERE id=${bb.application.applicationId}`,
      ),
    );
    const registry = worker.ctx.get<ConnectorRegistry>(CONNECTORS);
    await expect(registry.forTenant(userCtx(b.me.tenant.id, b.me.user.id))).rejects.toMatchObject({
      code: "marketplace_application.key_unavailable",
    });
  });

  it("rejects key replacement while authorization or connected stores still depend on it", async () => {
    const owner = await signup(api);
    const app = await configure(owner, "shopee");
    const started = await owner.c.post("/v1/store-authorizations", { channel: "shopee" });
    expect(started.status).toBe(201);
    const changed = await owner.c.put("/v1/marketplace-applications/shopee", {
      partnerId: app.id,
      secret: "replacement-secret",
      expectedVersion: app.application.rowVersion,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("marketplace_application.in_use");
    const callback = await owner.c.post("/v1/store-authorizations/callback", {
      channel: "shopee",
      state: new URL(started.body.authorizeUrl).searchParams.get("state"),
      code: `code-${app.id}`,
      shopId: app.shopId,
    });
    expect(callback.status).toBe(202);
    await worker.runJob(
      storeAuthorizeJob,
      { authorizationId: started.body.id, code: `code-${app.id}`, shopId: app.shopId },
      owner.me.tenant.id,
    );
    const removed = await owner.c
      .delete("/v1/marketplace-applications/shopee")
      .set("If-Match", `"${app.application.rowVersion}"`);
    expect(removed.status).toBe(409);
    expect(removed.body.code).toBe("marketplace_application.in_use");
  });

  it("requires current revision for edits and deletion, and leaves a disabled tenant setting", async () => {
    const owner = await signup(api);
    const app = await configure(owner, "shopee");
    const stale = await owner.c.put("/v1/marketplace-applications/shopee", {
      partnerId: app.id,
      secret: "new-private-secret",
    });
    expect(stale.status).toBe(409);
    const changed = await owner.c.put("/v1/marketplace-applications/shopee", {
      partnerId: app.id,
      secret: "new-private-secret",
      expectedVersion: app.application.rowVersion,
    });
    expect(changed.status).toBe(200);
    expect(
      (await owner.c.delete("/v1/marketplace-applications/shopee").set("If-Match", `"${app.application.rowVersion}"`))
        .status,
    ).toBe(409);
    const removed = await owner.c
      .delete("/v1/marketplace-applications/shopee")
      .set("If-Match", `"${changed.body.rowVersion}"`);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({
      source: "tenant",
      configured: false,
      secretConfigured: false,
      partnerId: null,
    });
    expect((await owner.c.post("/v1/store-authorizations", { channel: "shopee" })).status).toBe(422);
  });

  it("requires whole-business settings permission and rejects incompatible input", async () => {
    const owner = await signup(api);
    const service = api.get(MarketplaceApplicationsService);
    const ctx = userCtx(owner.me.tenant.id, owner.me.user.id);
    await expect(service.list({ ...ctx, permissions: new Set() })).rejects.toMatchObject({
      code: "marketplace_application.permission_required",
    });
    await expect(service.list({ ...ctx, storeScope: new Set() })).rejects.toMatchObject({
      code: "marketplace_application.permission_required",
    });
    expect(
      (
        await owner.c.put("/v1/marketplace-applications/tiktokshop", {
          partnerId: "123",
          secret: "private-test-secret",
        })
      ).status,
    ).toBe(422);
    const sandbox = await owner.c.put("/v1/marketplace-applications/shopee", {
      partnerId: "198188",
      secret: "private-test-secret",
      environment: "sandbox",
    });
    expect(sandbox.status).toBe(200);
    const start = await owner.c.post("/v1/store-authorizations", { channel: "shopee" });
    expect(new URL(start.body.authorizeUrl).origin).toBe("https://open.sandbox.test-stable.shopee.com");
  });

  it("verifies app-specific webhooks and refuses a correctly signed event naming another tenant's shop", async () => {
    const a = await signup(api);
    const b = await signup(api);
    const aa = await configure(a, "shopee");
    const bb = await configure(b, "shopee");
    await connect(a, "shopee", aa);
    await connect(b, "shopee", bb);
    const body = JSON.stringify({
      code: 3,
      shop_id: Number(aa.shopId),
      timestamp: Math.floor(Date.now() / 1000),
      data: { ordersn: "TENANT_APP_TEST_ORDER", status: "READY_TO_SHIP" },
    });
    const send = (app: typeof aa, secret: string) => {
      const path = `/webhooks/shopee/apps/${app.application.applicationId}`;
      const signature = createHmac("sha256", secret).update(`${WEBHOOK_URL}${path}|${body}`).digest("hex");
      return request(hooks.getHttpServer())
        .post(path)
        .set("content-type", "application/json")
        .set("authorization", signature)
        .send(body);
    };
    expect((await send(aa, bb.secret)).status).toBe(401);
    expect((await send(bb, bb.secret)).status).toBe(401);
    expect((await send(aa, aa.secret)).status).toBe(200);
    const inbox = await h.system.db.execute<{ tenant_id: string; application_id: string }>(
      sql`SELECT tenant_id,application_id FROM webhook_inbox WHERE application_id=${aa.application.applicationId}`,
    );
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0]).toEqual({ tenant_id: a.me.tenant.id, application_id: aa.application.applicationId });
  });

  it("keeps application-ID App Store handoffs bound to their tenant", async () => {
    const a = await signup(api);
    const b = await signup(api);
    const app = await configure(a, "tiktokshop");
    const capture = await a.c
      .post("/v1/store-installations/tiktokshop/capture", {
        code: `code-${app.id}`,
        applicationId: app.application.applicationId,
      })
      .set("Origin", "http://localhost:3100");
    expect(capture.status).toBe(201);
    const cookie = (capture.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
    const challenge = await a.c.get("/v1/store-installations/tiktokshop").set("Cookie", cookie);
    expect(challenge.status).toBe(200);
    expect((await b.c.get("/v1/store-installations/tiktokshop").set("Cookie", cookie)).status).toBe(422);
    const confirmation = await a.c
      .post("/v1/store-installations/tiktokshop/confirm", {
        confirmed: true,
        confirmationToken: challenge.body.confirmationToken,
      })
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3100");
    expect(confirmation.status, JSON.stringify(confirmation.body)).toBe(202);
    await worker.runJob(
      storeAuthorizeJob,
      { authorizationId: confirmation.body.id, code: `code-${app.id}` },
      a.me.tenant.id,
    );
    const preview = await a.c.get(`/v1/store-authorizations/${confirmation.body.id}`);
    expect(preview.body.installation.awaitingShopSelection).toBe(true);
    expect((await a.c.get("/v1/stores")).body.items).toHaveLength(0);
    const selected = await a.c
      .post("/v1/store-installations/tiktokshop/select-shops", {
        authorizationId: confirmation.body.id,
        confirmationToken: challenge.body.confirmationToken,
        confirmed: true,
        shopIds: [app.shopId],
      })
      .set("Cookie", cookie)
      .set("Origin", "http://localhost:3100");
    expect(selected.status, JSON.stringify(selected.body)).toBe(202);
    await worker.runJob(storeInstallationConnectJob, { authorizationId: confirmation.body.id }, a.me.tenant.id);
    expect((await a.c.get("/v1/stores")).body.items).toHaveLength(1);
    expect(calls.filter((call) => call.app === app.id && call.path === "/api/v2/token/get")).toHaveLength(1);
  });

  it("verifies Tokopedia & Shop notification signatures with the tenant's app credentials", async () => {
    const owner = await signup(api);
    const app = await configure(owner, "tiktokshop");
    await connect(owner, "tiktokshop", app);
    const body = JSON.stringify({
      type: 1,
      shop_id: app.shopId,
      timestamp: Math.floor(Date.now() / 1000),
      data: { order_id: "7488888888888888888", order_status: "AWAITING_SHIPMENT" },
    });
    const path = `/webhooks/tiktokshop/apps/${app.application.applicationId}`;
    const signature = createHmac("sha256", app.secret).update(`${app.id}${body}`).digest("hex");
    expect(
      (
        await request(hooks.getHttpServer())
          .post(path)
          .set("content-type", "application/json")
          .set("authorization", signature)
          .send(body)
      ).status,
    ).toBe(200);
    const inbox = await h.system.db.execute<{ tenant_id: string; application_id: string }>(
      sql`SELECT tenant_id,application_id FROM webhook_inbox WHERE application_id=${app.application.applicationId}`,
    );
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0]?.tenant_id).toBe(owner.me.tenant.id);
  });
});
