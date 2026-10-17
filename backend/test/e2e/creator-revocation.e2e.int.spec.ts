import type { INestApplication } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { JOB_REGISTRY, OUTBOX, QUEUES } from "../../src/infra/tokens";
import { QueueRegistry } from "../../src/jobs/queues";
import { JobRegistry } from "../../src/jobs/registry";
import { affiliateAccountAuthorizeJob } from "../../src/modules/affiliate-accounts/accounts.jobs";
import { AffiliateAccountConnectService } from "../../src/modules/affiliate-accounts/accounts-connect.service";
import { AffiliateAccountCredentialsService } from "../../src/modules/affiliate-accounts/accounts-credentials.service";
import { CONNECTORS, type ConnectorRegistry } from "../../src/modules/channel/connector-registry";
import { webhookProcessJob } from "../../src/modules/sync/sync.jobs";
import { replayWebhooksIn } from "../../src/modules/sync/webhook-replay";
import { Outbox } from "../../src/outbox/outbox";
import { sweepWebhookInbox } from "../../src/scheduler/channel-scans";
import { type Client, signup, startApi, startWebhook, startWorker } from "../setup/app";
import { createStore, userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace } from "../setup/mock-marketplace";

const h = testHandles();
let api: INestApplication;
let hooks: INestApplication;
let mock: MockMarketplace;
let worker: Awaited<ReturnType<typeof startWorker>>;
const base = "/v1/affiliate";
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
async function begin(c: Client, sellerId: string, accountId?: string) {
  const started = await c.post(`${base}/authorizations`, { kind: "creator", ...(accountId ? { accountId } : {}) });
  expect(started.status).toBe(201);
  const state = new URL(started.body.authorizeUrl).searchParams.get("state");
  const code = mock.tiktokCode(sellerId);
  expect((await c.post(`${base}/authorizations/callback`, { state, code })).status).toBe(201);
  return { id: started.body.id as string, code };
}
async function connect(c: Client, tenantId: string, sellerId: string, accountId?: string) {
  const started = await begin(c, sellerId, accountId);
  await worker.runJob(affiliateAccountAuthorizeJob, { authorizationId: started.id, code: started.code }, tenantId);
  const authorization = (await c.get(`${base}/authorizations/${started.id}`)).body;
  expect(authorization.status, JSON.stringify(authorization)).toBe("succeeded");
  return authorization.accountId as string;
}
function principal() {
  const openId = newId();
  const sellerId = mock.addTiktokSeller({
    openId,
    name: "Creator Uji",
    shops: [],
    userType: 1,
    scopes: ["creator.affiliate.info"],
  });
  return { openId, sellerId };
}
async function push(openId: string, cancelTime = Math.floor(Date.now() / 1000), forged = false) {
  const eventId = newId();
  const raw = JSON.stringify({
    type: 20,
    creator_open_id: openId,
    tts_notification_id: eventId,
    timestamp: cancelTime + 60,
    data: { cancel_time: String(cancelTime) },
  });
  const send = () =>
    request(hooks.getHttpServer())
      .post("/webhooks/tiktokshop")
      .set("content-type", "application/json")
      .set("authorization", forged ? "0".repeat(64) : mock.signTiktokWebhook(raw))
      .send(raw);
  const response = await send();
  return { eventId, response, send };
}
async function inbox(eventId: string) {
  return (
    await h.system.db.execute<{
      id: string;
      tenant_id: string | null;
      store_id: string | null;
      account_id: string | null;
      processed_at: Date | null;
      last_error: string | null;
    }>(
      sql`SELECT id,tenant_id,store_id,account_id,processed_at,last_error FROM webhook_inbox WHERE event_id=${eventId}`,
    )
  ).rows[0];
}
async function current(c: Client, id: string) {
  return (await c.get(`${base}/accounts/${id}`)).body;
}

describe("Creator revocation with application roles, signed inbox and worker routing", () => {
  it("routes creator identities independently from seller stores, rejects forged signatures and deduplicates", async () => {
    const a = await signup(api);
    const b = await signup(api);
    const p = principal();
    const id = await connect(a.c, a.me.tenant.id, p.sellerId);
    const otherStore = await withTenantTx(h.api, userCtx(b.me.tenant.id, b.me.user.id), (tx) =>
      createStore(tx, b.me.tenant.id, { channel: "tiktokshop", externalShopId: p.openId }),
    );
    const invalid = await push(p.openId, undefined, true);
    expect(invalid.response.status).toBe(401);
    expect(await inbox(invalid.eventId)).toBeUndefined();
    const received = await push(p.openId);
    expect(received.response.status).toBe(200);
    expect((await received.send()).status).toBe(200);
    const row = (await inbox(received.eventId))!;
    expect(row).toMatchObject({ tenant_id: a.me.tenant.id, account_id: id, store_id: null, processed_at: null });
    expect(
      (await h.system.db.execute(sql`SELECT id FROM webhook_inbox WHERE event_id=${received.eventId}`)).rows,
    ).toHaveLength(1);
    await worker.runJob(webhookProcessJob, { inboxId: row.id }, b.me.tenant.id);
    expect((await current(a.c, id)).status).toBe("active");
    await worker.runJob(webhookProcessJob, { inboxId: row.id }, a.me.tenant.id);
    expect(await current(a.c, id)).toMatchObject({ status: "reauth_required", errorCode: "authorization_revoked" });
    expect((await b.c.get(`/v1/stores/${otherStore}`)).body.status).toBe("active");
    const credentials = await withTenantTx(h.worker, userCtx(a.me.tenant.id), (tx) =>
      tx.execute(sql`SELECT id FROM affiliate_account_credential WHERE account_id=${id}`),
    );
    expect(credentials.rows).toEqual([]);
    const rawApi = await h.raw("api");
    expect(
      (await rawApi.query("SELECT * FROM resolve_affiliate_account('tiktokshop','creator',$1)", [p.openId])).rows,
    ).toEqual([{ tenant_id: a.me.tenant.id, account_id: id }]);
    expect(
      (await rawApi.query("SELECT * FROM resolve_affiliate_account('shopee','creator',$1)", [p.openId])).rows,
    ).toEqual([]);
    expect(
      (await rawApi.query("SELECT * FROM resolve_affiliate_account('tiktokshop','affiliate_partner',$1)", [p.openId]))
        .rows,
    ).toEqual([]);
  });

  it("ignores a delayed cancellation and its forced replay after a newer authorization", async () => {
    const a = await signup(api);
    const p = principal();
    const id = await connect(a.c, a.me.tenant.id, p.sellerId);
    const ctx = userCtx(a.me.tenant.id, a.me.user.id);
    const cancelled = Math.floor(Date.now() / 1000) - 10;
    await withTenantTx(h.worker, ctx, (tx) =>
      tx.execute(sql`UPDATE affiliate_account SET connected_at=now()-interval '20 seconds' WHERE id=${id}`),
    );
    const received = await push(p.openId, cancelled);
    const row = (await inbox(received.eventId))!;
    await worker.runJob(webhookProcessJob, { inboxId: row.id }, a.me.tenant.id);
    expect((await current(a.c, id)).status).toBe("reauth_required");
    await connect(a.c, a.me.tenant.id, p.sellerId, id);
    await withTenantTx(h.worker, ctx, (tx) =>
      replayWebhooksIn(tx, ctx, worker.ctx.get<Outbox>(OUTBOX), { id: row.id, force: true, limit: 1, dryRun: false }),
    );
    await worker.runOutbox(a.me.tenant.id);
    expect((await current(a.c, id)).status).toBe("active");
    expect((await inbox(received.eventId))!.processed_at).not.toBeNull();
    const delayed = await push(p.openId, cancelled);
    await worker.runJob(webhookProcessJob, { inboxId: (await inbox(delayed.eventId))!.id }, a.me.tenant.id);
    expect((await current(a.c, id)).status).toBe("active");
  });

  it.each(["refresh", "describe"] as const)(
    "cannot resurrect credentials when cancellation races %s",
    async (method) => {
      const a = await signup(api);
      const p = principal();
      const id = await connect(a.c, a.me.tenant.id, p.sellerId);
      const connector = worker.ctx.get<ConnectorRegistry>(CONNECTORS).get("tiktokshop").accounts!;
      const revoke = async () => {
        const received = await push(p.openId);
        await worker.runJob(webhookProcessJob, { inboxId: (await inbox(received.eventId))!.id }, a.me.tenant.id);
      };
      const refresh = connector.refresh.bind(connector);
      const describe = connector.describe.bind(connector);
      const spy =
        method === "refresh"
          ? vi.spyOn(connector, "refresh").mockImplementationOnce(async (input) => {
              const result = await refresh(input);
              await revoke();
              return result;
            })
          : vi.spyOn(connector, "describe").mockImplementationOnce(async (input) => {
              const result = await describe(input);
              await revoke();
              return result;
            });
      try {
        await worker.ctx
          .get(AffiliateAccountCredentialsService)
          .refresh(userCtx(a.me.tenant.id, a.me.user.id), id, false, true);
        expect((await current(a.c, id)).status).toBe("reauth_required");
        const rows = await withTenantTx(h.worker, userCtx(a.me.tenant.id), (tx) =>
          tx.execute(sql`SELECT id FROM affiliate_account_credential WHERE account_id=${id}`),
        );
        expect(rows.rows).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("soft-cancels a staged reauthorization and keeps its history when consent is removed", async () => {
    const a = await signup(api);
    const p = principal();
    const id = await connect(a.c, a.me.tenant.id, p.sellerId);
    const started = await begin(a.c, p.sellerId, id);
    const connector = worker.ctx.get<ConnectorRegistry>(CONNECTORS).get("tiktokshop").accounts!;
    const describe = connector.describe.bind(connector);
    const spy = vi.spyOn(connector, "describe").mockImplementationOnce(async (input) => {
      const result = await describe(input);
      const received = await push(p.openId);
      await worker.runJob(webhookProcessJob, { inboxId: (await inbox(received.eventId))!.id }, a.me.tenant.id);
      return result;
    });
    try {
      await worker.ctx
        .get(AffiliateAccountConnectService)
        .complete(userCtx(a.me.tenant.id, a.me.user.id), started.id, started.code, 0);
    } finally {
      spy.mockRestore();
    }
    expect((await current(a.c, id)).status).toBe("reauth_required");
    expect((await a.c.get(`${base}/authorizations/${started.id}`)).body).toMatchObject({
      status: "failed",
      errorCode: "authorization_revoked",
    });
    const rows = await withTenantTx(h.worker, userCtx(a.me.tenant.id), (tx) =>
      tx.execute(sql`SELECT grant_access_token_enc,claim_id FROM affiliate_authorization WHERE id=${started.id}`),
    );
    expect(rows.rows).toEqual([{ grant_access_token_enc: null, claim_id: null }]);
  });

  it("fences cancellation during first authorization before a creator account exists", async () => {
    const a = await signup(api);
    const p = principal();
    const started = await begin(a.c, p.sellerId);
    const connector = worker.ctx.get<ConnectorRegistry>(CONNECTORS).get("tiktokshop").accounts!;
    const describe = connector.describe.bind(connector);
    const spy = vi.spyOn(connector, "describe").mockImplementationOnce(async (input) => {
      const received = await push(p.openId);
      expect((await inbox(received.eventId))!.tenant_id).toBeNull();
      return describe(input);
    });
    try {
      await worker.ctx
        .get(AffiliateAccountConnectService)
        .complete(userCtx(a.me.tenant.id, a.me.user.id), started.id, started.code, 0);
    } finally {
      spy.mockRestore();
    }
    expect((await a.c.get(`${base}/authorizations/${started.id}`)).body).toMatchObject({
      status: "failed",
      errorCode: "authorization_revoked",
    });
    expect((await a.c.get(`${base}/accounts`)).body.items).toEqual([]);
    const rows = await withTenantTx(h.worker, userCtx(a.me.tenant.id), (tx) =>
      tx.execute(
        sql`SELECT grant_access_token_enc,grant_refresh_token_enc FROM affiliate_authorization WHERE id=${started.id}`,
      ),
    );
    expect(rows.rows).toEqual([{ grant_access_token_enc: null, grant_refresh_token_enc: null }]);
  });

  it("routes an earlier unknown-creator push after connection and closes unknown identities after grace", async () => {
    const a = await signup(api);
    const p = principal();
    const received = await push(p.openId, Math.floor(Date.now() / 1000) - 60);
    expect((await inbox(received.eventId))!.tenant_id).toBeNull();
    const id = await connect(a.c, a.me.tenant.id, p.sellerId);
    const unknown = await push(newId());
    await h.system.db.execute(
      sql`UPDATE webhook_inbox SET received_at=now()-interval '20 minutes' WHERE event_id=${unknown.eventId}`,
    );
    await sweepWebhookInbox(h.system, worker.ctx.get<QueueRegistry>(QUEUES), worker.ctx.get<JobRegistry>(JOB_REGISTRY));
    const routed = (await inbox(received.eventId))!;
    expect(routed).toMatchObject({ tenant_id: a.me.tenant.id, account_id: id, store_id: null });
    await worker.runJob(webhookProcessJob, { inboxId: routed.id }, a.me.tenant.id);
    expect((await current(a.c, id)).status).toBe("active");
    expect(await inbox(unknown.eventId)).toMatchObject({ last_error: "unknown_account" });
  });
});
