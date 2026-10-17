import type { INestApplication } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../../src/common/security/tokens";
import { StoreConnectService } from "../../src/modules/channel/store-connect.service";
import { INSTALLATION_COOKIE } from "../../src/modules/channel/store-installation.controller";
import {
  type Client,
  client,
  PASSWORD,
  signup,
  startApi,
  startWorker,
  tokenFrom,
  uniqueEmail,
  WEB_URL,
} from "../setup/app";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace } from "../setup/mock-marketplace";

const h = testHandles();
let api: INestApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let mock: MockMarketplace;
const rootPath = "/v1/store-installations/tiktokshop";

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

function code(shopCount = 1): string {
  const sellerId = mock.addTiktokSeller({
    openId: newId(),
    name: "Seller pemasangan",
    shops: Array.from({ length: shopCount }, (_, index) => {
      const id = newId();
      return {
        id,
        name: index === 0 ? "Toko App Store" : `Toko pilihan ${index + 1}`,
        region: "ID",
        cipher: `ROW_${id}`,
        warehouses: [],
      };
    }),
  });
  return mock.tiktokCode(sellerId);
}
async function capture(c: Client, value = code()) {
  const response = await c.post(`${rootPath}/capture`, { code: value }).set("Origin", WEB_URL);
  expect(response.status).toBe(201);
  const cookie = (response.headers["set-cookie"] as unknown as string[])[0]!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain("Path=/v1/store-installations");
  expect(cookie).not.toContain(value);
  expect(Object.keys(response.body)).toEqual(["expiresAt"]);
  return {
    code: value,
    cookie: cookie.split(";")[0]!,
    token: cookie.split(";")[0]!.slice(INSTALLATION_COOKIE.length + 1),
  };
}
async function inspect(c: Client) {
  const response = await c.get(rootPath);
  expect(response.status).toBe(200);
  return response.body.confirmationToken as string;
}
function confirm(c: Client, confirmationToken: string) {
  return c.post(`${rootPath}/confirm`, { confirmationToken, confirmed: true }).set("Origin", WEB_URL);
}

describe("TikTok App Store seller installation", () => {
  it("captures privately before login and never exchanges until an authenticated explicit confirmation", async () => {
    const c = client(api);
    const captured = await capture(c);
    const raw = await h.redis.get(`store-install:tiktokshop:receipt:${hashToken(captured.token)}`);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(captured.code);
    expect(await h.redis.ttl(`store-install:tiktokshop:receipt:${hashToken(captured.token)}`)).toBeLessThanOrEqual(600);
    expect((await c.get(rootPath)).status).toBe(401);
    const before = mock.callsTo("GET", "/api/v2/token/get").length;
    const email = uniqueEmail("install");
    const signedUp = await c.post("/v1/auth/signup", {
      businessName: "Bisnis pemasangan",
      name: "Rina",
      email,
      password: PASSWORD,
    });
    expect(signedUp.status).toBe(201);
    const me = signedUp.body;
    const nonce = await inspect(c);
    expect(mock.callsTo("GET", "/api/v2/token/get").length).toBe(before);
    expect(
      (await c.post(`${rootPath}/confirm`, { confirmationToken: nonce, confirmed: false }).set("Origin", WEB_URL))
        .status,
    ).toBe(422);
    const [first, retry] = await Promise.all([confirm(c, nonce), confirm(c, nonce)]);
    expect([first.status, retry.status]).toEqual([202, 202]);
    expect(first.body.id).toBe(retry.body.id);
    expect(first.body.status).toBe("exchanging");
    expect(JSON.stringify(first.body)).not.toContain(captured.code);
    const rows = await h.system.db.execute(
      sql`SELECT count(*)::int AS count FROM store_authorization WHERE tenant_id=${me.tenant.id}`,
    );
    expect(rows.rows).toEqual([{ count: 1 }]);
    const queued = await h.system.db.execute(
      sql`SELECT count(*)::int AS count FROM outbox_event
          WHERE tenant_id=${me.tenant.id} AND event_type='store.authorization_received'`,
    );
    expect(queued.rows).toEqual([{ count: 1 }]);
    const saved = await h.redis.get(`store-install:tiktokshop:receipt:${hashToken(captured.token)}`);
    expect(saved).not.toContain("sealedCode");
    const input = { authorizationId: first.body.id, code: captured.code };
    await Promise.all([
      worker.ctx.get(StoreConnectService).complete(userCtx(me.tenant.id, me.user.id), input, true),
      worker.ctx.get(StoreConnectService).complete(userCtx(me.tenant.id, me.user.id), input, true),
    ]);
    expect(mock.callsTo("GET", "/api/v2/token/get").length - before).toBe(1);
    const preview = (await c.get(`/v1/store-authorizations/${first.body.id}`)).body;
    expect(preview).toMatchObject({
      status: "exchanging",
      installation: { awaitingShopSelection: true, shops: [{ name: "Toko App Store", region: "ID" }] },
    });
    expect(JSON.stringify(preview)).not.toContain("ROW_");
    const beforeSelection = await h.system.db.execute(
      sql`SELECT id FROM store WHERE tenant_id=${me.tenant.id} AND channel='tiktokshop'`,
    );
    expect(beforeSelection.rows).toEqual([]);
    const selectionBody = {
      authorizationId: first.body.id,
      confirmationToken: nonce,
      confirmed: true,
      shopIds: [preview.installation.shops[0].externalShopId],
    };
    expect(
      (
        await c
          .post(`${rootPath}/select-shops`, { ...selectionBody, shopIds: ["not-a-verified-shop"] })
          .set("Origin", WEB_URL)
      ).status,
    ).toBe(422);
    const selected = await Promise.all([
      c.post(`${rootPath}/select-shops`, selectionBody).set("Origin", WEB_URL),
      c.post(`${rootPath}/select-shops`, selectionBody).set("Origin", WEB_URL),
    ]);
    expect(selected.map((value) => value.status)).toEqual([202, 202]);
    const selections = await h.system.db.execute(
      sql`SELECT count(*)::int AS count FROM outbox_event WHERE tenant_id=${me.tenant.id} AND event_type='store.installation_selected'`,
    );
    expect(selections.rows).toEqual([{ count: 1 }]);
    await worker.ctx
      .get(StoreConnectService)
      .complete(userCtx(me.tenant.id, me.user.id), { authorizationId: first.body.id, code: "" }, true);
    expect(mock.callsTo("GET", "/api/v2/token/get").length - before).toBe(1);
    expect(await h.redis.exists(`rl:mp:authorization:${first.body.id}`)).toBe(1);
    expect((await c.get(`/v1/store-authorizations/${first.body.id}`)).body).toMatchObject({
      status: "succeeded",
      result: { stores: [{ name: "Toko App Store" }] },
    });
    expect((await confirm(c, nonce)).body.id).toBe(first.body.id);
    expect((await c.post(`${rootPath}/select-shops`, selectionBody).set("Origin", WEB_URL)).status).toBe(202);
  });

  it("rejects cross-origin capture/confirmation and requires a matching same-session challenge", async () => {
    const { c, email } = await signup(api);
    expect((await c.post(`${rootPath}/capture`, { code: code() }).set("Origin", "https://other.example")).status).toBe(
      403,
    );
    expect((await c.post(`${rootPath}/capture`, { code: code() })).status).toBe(403);
    const captured = await capture(c);
    const nonce = await inspect(c);
    expect(
      (
        await c
          .post(`${rootPath}/confirm`, { confirmationToken: nonce, confirmed: true })
          .set("Origin", "https://other.example")
      ).status,
    ).toBe(403);
    expect((await c.post(`${rootPath}/confirm`, { confirmationToken: nonce, confirmed: true })).status).toBe(403);
    const otherSession = client(api);
    expect((await otherSession.post("/v1/auth/login", { email, password: PASSWORD })).status).toBe(200);
    const replay = await otherSession
      .post(`${rootPath}/confirm`, { confirmationToken: nonce, confirmed: true })
      .set("Origin", WEB_URL)
      .set("Cookie", captured.cookie);
    expect(replay.status).toBe(422);
    const changedNonce = await inspect(c);
    expect((await confirm(c, nonce)).status).toBe(422);
    expect((await confirm(c, changedNonce)).status).toBe(202);
  });

  it("globally claims duplicate captured codes for only one tenant and only one session", async () => {
    const a = await signup(api);
    const b = await signup(api);
    const value = code();
    await capture(a.c, value);
    await capture(b.c, value);
    const [nonceA, nonceB] = await Promise.all([inspect(a.c), inspect(b.c)]);
    expect((await confirm(a.c, nonceA)).status).toBe(202);
    expect((await confirm(b.c, nonceB)).status).toBe(422);
    const foreign = await h.system.db.execute(
      sql`SELECT id FROM store_authorization WHERE tenant_id=${b.me.tenant.id}`,
    );
    expect(foreign.rows).toEqual([]);
  });

  it("expires a capture and does not permit the ordinary state callback to bypass the handoff", async () => {
    const { c } = await signup(api);
    const captured = await capture(c);
    const nonce = await inspect(c);
    await h.redis.del(`store-install:tiktokshop:receipt:${hashToken(captured.token)}`);
    expect((await confirm(c, nonce)).status).toBe(422);
    expect(
      (await c.post("/v1/store-authorizations/callback", { channel: "tiktokshop", code: captured.code })).status,
    ).toBe(422);
  });

  it("reloads the caller's role between inspection and confirmation", async () => {
    const owner = await signup(api);
    const role = (await owner.c.post("/v1/roles", { name: "Pengelola pemasangan", permissions: ["settings:store"] }))
      .body;
    const email = uniqueEmail("manager-install");
    await owner.c.post("/v1/invitations", { email, roleId: role.id });
    for (let i = 0; i < 5; i++) if (!(await worker.runOutbox(owner.me.tenant.id)).length) break;
    const member = client(api);
    expect(
      (
        await member.post("/v1/auth/invitations/accept", {
          token: tokenFrom(worker.email.lastTo(email)!.text),
          name: "Pengelola",
          password: PASSWORD,
        })
      ).status,
    ).toBe(201);
    const captured = await capture(member);
    const nonce = await inspect(member);
    expect((await owner.c.patch(`/v1/roles/${role.id}`, { permissions: ["order:read"] })).status).toBe(200);
    expect((await confirm(member, nonce)).status).toBe(403);
    const rows = await h.system.db.execute(
      sql`SELECT id FROM store_authorization WHERE tenant_id=${owner.me.tenant.id}`,
    );
    expect(rows.rows).toEqual([]);
    await owner.c.patch(`/v1/roles/${role.id}`, { permissions: ["settings:store"] });
    const verification = await confirm(member, nonce);
    expect(verification.status).toBe(202);
    const memberMe = (await member.get("/v1/me")).body;
    const ctx = userCtx(owner.me.tenant.id, memberMe.user.id);
    await worker.ctx
      .get(StoreConnectService)
      .complete(ctx, { authorizationId: verification.body.id, code: captured.code }, true);
    const preview = (await member.get(`/v1/store-authorizations/${verification.body.id}`)).body;
    const body = {
      authorizationId: verification.body.id,
      confirmationToken: nonce,
      confirmed: true,
      shopIds: [preview.installation.shops[0].externalShopId],
    };
    await owner.c.patch(`/v1/roles/${role.id}`, { permissions: ["order:read"] });
    expect((await member.post(`${rootPath}/select-shops`, body).set("Origin", WEB_URL)).status).toBe(403);
    await owner.c.patch(`/v1/roles/${role.id}`, { permissions: ["settings:store"] });
    expect((await member.post(`${rootPath}/select-shops`, body).set("Origin", WEB_URL)).status).toBe(202);
    await owner.c.patch(`/v1/roles/${role.id}`, { permissions: ["order:read"] });
    await worker.ctx.get(StoreConnectService).complete(ctx, { authorizationId: verification.body.id, code: "" }, true);
    expect((await owner.c.get(`/v1/store-authorizations/${verification.body.id}`)).body).toMatchObject({
      status: "failed",
      errorCode: "permission_revoked",
    });
    const stores = await h.system.db.execute(
      sql`SELECT id FROM store WHERE tenant_id=${owner.me.tenant.id} AND channel='tiktokshop'`,
    );
    expect(stores.rows).toEqual([]);
  });

  it("checks the live quota under concurrent multi-shop grants and permits reconnecting at the limit", async () => {
    const { c, me } = await signup(api);
    const ctx = userCtx(me.tenant.id, me.user.id);
    async function verifiedAndSelected(value: string) {
      const captured = await capture(c, value);
      const nonce = await inspect(c);
      const request = await confirm(c, nonce);
      expect(request.status).toBe(202);
      await worker.ctx
        .get(StoreConnectService)
        .complete(ctx, { authorizationId: request.body.id, code: captured.code }, true);
      const preview = (await c.get(`/v1/store-authorizations/${request.body.id}`)).body;
      expect(preview.installation.awaitingShopSelection).toBe(true);
      const body = {
        authorizationId: request.body.id,
        confirmationToken: nonce,
        confirmed: true,
        shopIds: preview.installation.shops.map((shop: { externalShopId: string }) => shop.externalShopId),
      };
      expect((await c.post(`${rootPath}/select-shops`, body).set("Origin", WEB_URL)).status).toBe(202);
      return request.body.id as string;
    }
    const first = await verifiedAndSelected(code(6));
    const second = await verifiedAndSelected(code(6));
    await Promise.all(
      [first, second].map((authorizationId) =>
        worker.ctx.get(StoreConnectService).complete(ctx, { authorizationId, code: "" }, true),
      ),
    );
    const rows = await h.system.db.execute<{ external_shop_id: string }>(
      sql`SELECT external_shop_id FROM store WHERE tenant_id=${me.tenant.id} AND channel='tiktokshop'`,
    );
    expect(rows.rows).toHaveLength(10);
    const firstResult = (await c.get(`/v1/store-authorizations/${first}`)).body;
    const secondResult = (await c.get(`/v1/store-authorizations/${second}`)).body;
    expect([...firstResult.result.failed, ...secondResult.result.failed]).toHaveLength(2);
    expect(
      [...firstResult.result.failed, ...secondResult.result.failed].every(
        (item) => item.reason === "billing_limit_reached",
      ),
    ).toBe(true);
    const existingId = rows.rows[0]!.external_shop_id;
    const seller = mock.addTiktokSeller({
      openId: newId(),
      name: "Seller tersambung",
      shops: [
        { id: existingId, name: "Nama dari marketplace", region: "ID", cipher: `ROW_${existingId}`, warehouses: [] },
      ],
    });
    const reconnect = await verifiedAndSelected(mock.tiktokCode(seller));
    await worker.ctx.get(StoreConnectService).complete(ctx, { authorizationId: reconnect, code: "" }, true);
    expect((await c.get(`/v1/store-authorizations/${reconnect}`)).body).toMatchObject({
      status: "succeeded",
      result: { stores: [{ externalShopId: existingId, reconnected: true }] },
    });
    const total = await h.system.db.execute(
      sql`SELECT count(*)::int AS count FROM store WHERE tenant_id=${me.tenant.id} AND channel='tiktokshop'`,
    );
    expect(total.rows).toEqual([{ count: 10 }]);
  });
});
