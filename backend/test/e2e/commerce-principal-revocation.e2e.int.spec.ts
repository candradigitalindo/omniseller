import { createHmac } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { createShopeeConnector } from "@omniseller/connector-shopee";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { lockTenantKeys } from "../../src/common/security/token-vault";
import { withTenantTx } from "../../src/db/tenant-tx";
import { AffiliateAccountsRepository } from "../../src/modules/affiliate-accounts/accounts.repository";
import { AffiliateAccountCredentialsService } from "../../src/modules/affiliate-accounts/accounts-credentials.service";
import { CONNECTORS, type ConnectorRegistry } from "../../src/modules/channel/connector-registry";
import { commerceExecuteJob } from "../../src/modules/commerce/commerce.jobs";
import { connectorCallObserver, connectorRequestGate } from "../../src/modules/sync/connector-calls";
import { signup, startApi, startWorker } from "../setup/app";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace, SHOPEE } from "../setup/mock-marketplace";

const h = testHandles();
let api: INestApplication;
let mock: MockMarketplace;
let worker: Awaited<ReturnType<typeof startWorker>>;
let restore: () => void;
let sequence = 0;
const identities = new Map<string, string>();
const revoked = new Set<string>();
const calls: string[] = [];
let onCall: ((token: string) => Promise<void>) | undefined;
const transport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  expect(url.origin).toBe("https://commerce-revocation.invalid");
  expect(url.pathname).toBe("/api/v2/livestream/get_item_count");
  expect(init?.method).toBe("GET");
  const token = url.searchParams.get("access_token")!;
  const user = url.searchParams.get("user_id")!;
  expect(identities.get(token)).toBe(user);
  expect(url.searchParams.has("shop_id")).toBe(false);
  expect(url.searchParams.get("sign")).toBe(
    createHmac("sha256", SHOPEE.partnerKey)
      .update(`${SHOPEE.partnerId}${url.pathname}${url.searchParams.get("timestamp")}${token}${user}`)
      .digest("hex"),
  );
  calls.push(token);
  const action = onCall;
  onCall = undefined;
  await action?.(token);
  return Response.json(
    revoked.has(token)
      ? { error: "user_no_linked", message: "Partner and user has no linked.", request_id: "revoked" }
      : { error: "", request_id: "current", response: { item_count: 2, max_item_count: 500 } },
  );
};

beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  api = await startApi(h.infra, { marketplace: mock });
  worker = await startWorker(h.infra, h.system, { marketplace: mock });
  const registry = worker.ctx.get<ConnectorRegistry>(CONNECTORS);
  const original = registry.get.bind(registry);
  const connector = createShopeeConnector({
    ...SHOPEE,
    apiBaseUrl: "https://commerce-revocation.invalid",
    authBaseUrl: "https://open.shopee.com",
    http: { fetch: transport, observer: connectorCallObserver, beforeRequest: connectorRequestGate },
  });
  const spy = vi
    .spyOn(registry, "get")
    .mockImplementation((channel) => (channel === "shopee" ? connector : original(channel)));
  restore = () => spy.mockRestore();
});
afterAll(async () => {
  restore?.();
  await worker?.close();
  await api?.close();
  await mock?.close();
});

async function fixture() {
  const owner = await signup(api);
  const ctx = userCtx(owner.me.tenant.id, owner.me.user.id);
  const accountId = newId();
  const externalId = String(9007199254741993n + BigInt(++sequence));
  const token = `PRIVATE_CREATOR_ACCESS_${newId()}`;
  const credentials = worker.ctx.get(AffiliateAccountCredentialsService);
  const repo = worker.ctx.get(AffiliateAccountsRepository);
  const dates = {
    accessExpiresAt: new Date(Date.now() + 14_400_000),
    authorizationExpiresAt: new Date(Date.now() + 30 * 86400_000),
    lastRefreshedAt: new Date(),
  };
  const saveGrant = async (accessToken: string, insert = false) => {
    await withTenantTx(h.worker, ctx, async (tx) => {
      await lockTenantKeys(tx, ctx.tenantId);
      if (insert)
        await repo.insert(tx, {
          id: accountId,
          tenantId: ctx.tenantId,
          channel: "shopee",
          program: "live",
          kind: "creator",
          externalPrincipalId: externalId,
          name: "Creator revocation",
          region: "ID",
          regionVerified: false,
          status: "active",
          scopes: [],
          ...dates,
        });
      else {
        await repo.get(tx, accountId, true);
        await repo.update(tx, accountId, { status: "active", ...dates });
      }
      await credentials.saveIn(
        tx,
        ctx,
        accountId,
        {
          kind: "creator",
          externalPrincipalId: externalId,
          tokens: {
            accessToken,
            refreshToken: `PRIVATE_REFRESH_${newId()}`,
            accessExpiresAt: dates.accessExpiresAt,
            refreshExpiresAt: dates.authorizationExpiresAt,
            scopes: [],
          },
        },
        [],
      );
    });
    identities.set(accessToken, externalId);
  };
  await saveGrant(token, true);
  const execute = async () => {
    const response = await owner.c
      .post("/v1/commerce/requests", {
        operationId: "shopee.livestream.get_item_count",
        principalId: accountId,
        input: { query: { session_id: "9007199254740993" } },
        confirmed: false,
      })
      .set("Idempotency-Key", newId());
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    await worker.runJob(commerceExecuteJob, { requestId: response.body.id }, ctx.tenantId);
    return (await owner.c.get(`/v1/commerce/requests/${response.body.id}`)).body;
  };
  const state = () =>
    withTenantTx(h.worker, ctx, async (tx) => ({
      account: await repo.get(tx, accountId),
      credential: await repo.credential(tx, accountId),
    }));
  return { ...owner, ctx, accountId, token, credentials, saveGrant, execute, state };
}

describe("commerce principal revocation fences", () => {
  it("marks the current rejected authorization for reconnect and deletes credentials without repeating the request", async () => {
    const f = await fixture();
    revoked.add(f.token);
    const before = calls.length;
    expect(await f.execute()).toMatchObject({ status: "failed", errorCode: "user_no_linked" });
    expect(calls.length - before).toBe(1);
    const state = await f.state();
    expect(state.account).toMatchObject({ status: "reauth_required", errorCode: "user_no_linked" });
    expect(state.credential).toBeUndefined();
    const blocked = await f.c
      .post("/v1/commerce/requests", {
        operationId: "shopee.livestream.get_item_count",
        principalId: f.accountId,
        input: { query: { session_id: "42" } },
        confirmed: false,
      })
      .set("Idempotency-Key", newId());
    expect(blocked.status).toBe(409);
    expect(calls.length - before).toBe(1);
    const logs = await withTenantTx(h.worker, f.ctx, (tx) =>
      tx.execute(sql`SELECT request_summary,response_summary FROM sync_job`),
    );
    expect(JSON.stringify(logs.rows)).not.toContain(f.token);
  });
  it("preserves a newer grant committed while the old HTTP request receives revocation", async () => {
    const f = await fixture();
    const newer = `PRIVATE_NEW_CREATOR_ACCESS_${newId()}`;
    revoked.add(f.token);
    onCall = async (token) => {
      expect(token).toBe(f.token);
      await f.saveGrant(newer);
    };
    expect(await f.execute()).toMatchObject({ status: "failed", errorCode: "user_no_linked" });
    expect((await f.state()).account?.status).toBe("active");
    expect((await f.state()).credential).toBeDefined();
    expect((await f.credentials.forAccount(f.ctx, f.accountId)).accessToken).toBe(newer);
    expect(await f.execute()).toMatchObject({ status: "succeeded", result: { data: { item_count: 2 } } });
    expect(calls.at(-1)).toBe(newer);
  });
});
