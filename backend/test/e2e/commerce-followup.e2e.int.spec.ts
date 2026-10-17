import { createHmac } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { type CommerceInput, type CommerceOperation, parseJsonSafe } from "@omniseller/connector-core";
import { createShopeeConnector, SHOPEE_COMMERCE_OPERATIONS } from "@omniseller/connector-shopee";
import { createTiktokShopConnector, TIKTOK_COMMERCE_OPERATIONS } from "@omniseller/connector-tiktokshop";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { CONNECTORS, type ConnectorRegistry } from "../../src/modules/channel/connector-registry";
import { CredentialService } from "../../src/modules/channel/credential.service";
import { commerceExecuteJob } from "../../src/modules/commerce/commerce.jobs";
import { FilesService } from "../../src/modules/files/files.service";
import { connectorCallObserver, connectorRequestGate } from "../../src/modules/sync/connector-calls";
import {
  type Client,
  fakeIp,
  type MeBody,
  PASSWORD,
  startApi,
  startWorker,
  tokenFrom,
  uniqueEmail,
} from "../setup/app";
import { CommerceTransport } from "../setup/commerce-transport";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace, SHOPEE, TIKTOK } from "../setup/mock-marketplace";

const h = testHandles();
let api: INestApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let mock: MockMarketplace;
let returnsTransport: CommerceTransport;
const restores: (() => void)[] = [];
const grants = new Map<string, string>();
const usersByToken = new Map<string, string>();
const userCalls: { path: string; userId: string; token: string }[] = [];
let shopSequence = 0;
const STREAM_URL = "rtmp://push.shopee.co.id/live/PRIVATE_STREAM_SERVER";
const STREAM_KEY = "PRIVATE_STREAM_OBS_KEY_082121";
const PDF = Buffer.from("%PDF-1.7\nPRIVATE_RETURN_PDF\n%%EOF");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a49sAAAAASUVORK5CYII=",
  "base64",
);
const operation = (path: string, channel: "shopee" | "tiktokshop" = "shopee") => {
  const found = (channel === "shopee" ? SHOPEE_COMMERCE_OPERATIONS : TIKTOK_COMMERCE_OPERATIONS).find(
    (op) => op.path === path,
  );
  if (!found) throw new Error(`Missing reviewed operation ${path}`);
  return found;
};
const liveCount = () => operation("/api/v2/livestream/get_item_count");
const streamCredentials = () => {
  const found = SHOPEE_COMMERCE_OPERATIONS.find((op) => op.id === "shopee.livestream.get_stream_credentials");
  if (!found) throw new Error("Missing private OBS workflow");
  return found;
};
const returnDocuments = () => operation("/return_refund/202405/returns/shipping_documents", "tiktokshop");
const liveInput = { query: { session_id: "9007199254740993" } };

/** The actual connector must sign the user namespace and use the connected creator token. */
const shopeeTransport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  expect(url.origin).toBe("https://commerce-shopee-fixture.invalid");
  const timestamp = url.searchParams.get("timestamp")!;
  expect(url.searchParams.get("partner_id")).toBe(String(SHOPEE.partnerId));
  expect(Math.abs(Date.now() - Number(timestamp) * 1000)).toBeLessThan(300_000);
  const grant = url.pathname === "/api/v2/auth/token/get";
  const token = url.searchParams.get("access_token") ?? "";
  const userId = url.searchParams.get("user_id") ?? "";
  const base = `${SHOPEE.partnerId}${url.pathname}${timestamp}${grant ? "" : token + userId}`;
  expect(url.searchParams.get("sign")).toBe(createHmac("sha256", SHOPEE.partnerKey).update(base).digest("hex"));
  expect(url.searchParams.has("shop_id")).toBe(false);
  if (grant) {
    expect(init?.method).toBe("POST");
    const body = parseJsonSafe(String(init?.body)) as { code: string; partner_id: number };
    const identity = grants.get(body.code);
    expect(identity).toBeTruthy();
    grants.delete(body.code);
    const access = `PRIVATE_SHOPEE_CREATOR_TOKEN_${newId()}`;
    usersByToken.set(access, identity!);
    return Response.json({
      error: "",
      request_id: "usergrant",
      user_id_list: [identity],
      access_token: access,
      refresh_token: `PRIVATE_REFRESH_${newId()}`,
      expire_in: 14_400,
    });
  }
  expect(init?.method).toBe("GET");
  expect(usersByToken.get(token)).toBe(userId);
  expect(userId).not.toBe("");
  expect(url.searchParams.get("session_id")).toBe(liveInput.query.session_id);
  userCalls.push({ path: url.pathname, userId, token });
  const response =
    url.pathname === liveCount().path
      ? { item_count: 2, max_item_count: 500 }
      : {
          session_id: "9007199254740993",
          stream_url_list: {
            push_url: STREAM_URL,
            push_key: STREAM_KEY,
            play_url: "https://play.shopee.co.id/private?a=SECRET_PLAY",
            domain_id: 57,
          },
        };
  return Response.json({ error: "", request_id: "live-read", response });
};
function fileClient() {
  const agent = request.agent(api.getHttpServer());
  const ip = fakeIp();
  const withIp = <T extends { set(key: string, value: string): T }>(test: T) => test.set("CF-Connecting-IP", ip);
  return {
    ip,
    get: (url: string) => withIp(agent.get(url)),
    post: (url: string, body?: object) => withIp(agent.post(url)).send(body ?? {}),
    patch: (url: string, body?: object) => withIp(agent.patch(url)).send(body ?? {}),
    put: (url: string, body?: object) => withIp(agent.put(url)).send(body ?? {}),
    delete: (url: string) => withIp(agent.delete(url)),
    upload: (op: CommerceOperation, principalId: string, fieldName?: string, bytes = PDF, mime = "application/pdf") => {
      let call = withIp(agent.post("/v1/commerce/files")).field("operationId", op.id).field("principalId", principalId);
      if (fieldName !== undefined) call = call.field("fieldName", fieldName);
      return call.attach("file", bytes, { filename: "PRIVATE_BUYER_081212.pdf", contentType: mime });
    },
  };
}
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
      apiBaseUrl: "https://commerce-shopee-fixture.invalid",
      authBaseUrl: "https://open.shopee.com",
      accountRedirectUri: "http://localhost:3000/integrasi/callback/shopee",
      http: { fetch: shopeeTransport, observer: connectorCallObserver, beforeRequest: connectorRequestGate },
    });
    const spy = vi
      .spyOn(registry, "get")
      .mockImplementation((channel) => (channel === "shopee" ? connector : original(channel)));
    restores.push(() => spy.mockRestore());
  }
  returnsTransport = new CommerceTransport(TIKTOK_COMMERCE_OPERATIONS, mock.url);
  worker.ctx.get<ConnectorRegistry>(CONNECTORS).get("tiktokshop").commerce = createTiktokShopConnector({
    appKey: TIKTOK.appKey,
    appSecret: TIKTOK.appSecret,
    serviceId: TIKTOK.serviceId,
    apiBaseUrl: mock.url,
    authBaseUrl: mock.url,
    authorizeUrl: `${mock.url}/open/authorize`,
    http: { fetch: returnsTransport.fetch, observer: connectorCallObserver, beforeRequest: connectorRequestGate },
  }).commerce;
});
afterAll(async () => {
  for (const restore of restores) restore();
  await worker?.close();
  await api?.close();
  await mock?.close();
});
async function drain(tenantId: string) {
  for (let n = 0; n < 15; n++) if (!(await worker.runOutbox(tenantId)).length) return;
}
async function owner() {
  const c = fileClient();
  const created = await c.post("/v1/auth/signup", {
    businessName: "Bisnis Commerce Followup",
    name: "Rina",
    email: uniqueEmail("followup"),
    password: PASSWORD,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return { c, me: created.body as MeBody };
}
async function creator(c: Client, me: MeBody, userId = "9007199254741093") {
  const pending = await c.post("/v1/affiliate/authorizations", { channel: "shopee", kind: "creator", program: "live" });
  expect(pending.status).toBe(201);
  const code = newId();
  grants.set(code, userId);
  expect(
    (
      await c.post("/v1/affiliate/authorizations/callback", {
        channel: "shopee",
        state: new URL(pending.body.authorizeUrl).searchParams.get("state"),
        code,
      })
    ).status,
  ).toBe(201);
  await drain(me.tenant.id);
  const completed = (await c.get(`/v1/affiliate/authorizations/${pending.body.id}`)).body;
  expect(completed.status, JSON.stringify(completed)).toBe("succeeded");
  return completed.accountId as string;
}
async function seller(c: Client, me: MeBody) {
  const scopes = [
    ...new Set([
      "seller.authorization.info",
      ...TIKTOK_COMMERCE_OPERATIONS.filter((op) => op.principalKind === "seller").flatMap((op) => op.scopes),
    ]),
  ];
  const openId = newId();
  const shopId = `74984${String(Date.now()).slice(-10)}${++shopSequence}`;
  const cipher = `PRIVATE_SHOP_${openId}`;
  const principal = mock.addTiktokSeller({
    openId,
    name: "Toko dokumen",
    scopes,
    userType: 0,
    shops: [{ id: shopId, name: "Toko dokumen", region: "ID", cipher, warehouses: [] }],
  });
  const pending = await c.post("/v1/store-authorizations", { channel: "tiktokshop" });
  expect(pending.status).toBe(201);
  expect(
    (
      await c.post("/v1/store-authorizations/callback", {
        channel: "tiktokshop",
        state: new URL(pending.body.authorizeUrl).searchParams.get("state"),
        code: mock.tiktokCode(principal),
      })
    ).status,
  ).toBe(202);
  await drain(me.tenant.id);
  const completed = (await c.get(`/v1/store-authorizations/${pending.body.id}`)).body;
  expect(completed.status, JSON.stringify(completed)).toBe("succeeded");
  const id = completed.result.stores[0].storeId as string;
  expect((await c.patch(`/v1/stores/${id}`, { syncMode: "live" })).status).toBe(200);
  const credentials = await worker.ctx.get(CredentialService).forShop(userCtx(me.tenant.id, me.user.id), id);
  returnsTransport.principals.set(credentials.shop.accessToken, { kind: "seller", shopCipher: cipher });
  return id;
}
async function member(c: Client, tenantId: string, permissions: string[]) {
  const role = (await c.post("/v1/roles", { name: `Followup ${newId().slice(-5)}`, permissions })).body;
  const email = uniqueEmail("followupstaff");
  expect((await c.post("/v1/invitations", { email, roleId: role.id })).status).toBe(201);
  await drain(tenantId);
  const user = fileClient();
  expect(
    (
      await user.post("/v1/auth/invitations/accept", {
        token: tokenFrom(worker.email.lastTo(email)!.text),
        name: "Staf",
        password: PASSWORD,
      })
    ).status,
  ).toBe(201);
  return { c: user, roleId: role.id };
}
function submit(c: Client, op: CommerceOperation, principalId: string, input: CommerceInput) {
  return c
    .post("/v1/commerce/requests", { operationId: op.id, principalId, input, confirmed: op.write })
    .set("Idempotency-Key", newId());
}
async function queue(c: Client, op: CommerceOperation, principalId: string, input: CommerceInput) {
  const response = await submit(c, op, principalId, input);
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  return response.body.id as string;
}
async function result(c: Client, id: string) {
  const response = await c.get(`/v1/commerce/requests/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}
const binary = (test: request.Test) =>
  test.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => callback(null, Buffer.concat(chunks)));
  });
const returnInput = (label: string, qr: string): CommerceInput => ({
  query: { return_ids: ["9223372036854775806"], return_id_type: "RMA" },
  body: {
    return_shipping_label: label,
    return_qr_code: qr,
    tracking_number: "PRIVATE_TRACKING_081212",
    return_provider_id: "42",
  },
});

describe("commerce principal routing, private credentials and per-field documents", () => {
  it("executes an API-queued Shopee creator read using the exact connected user namespace and token", async () => {
    const { c, me } = await owner();
    const principalId = await creator(c, me);
    const catalog = (await c.get("/v1/commerce/principals")).body.items;
    expect(catalog).toContainEqual(expect.objectContaining({ id: principalId, channel: "shopee", kind: "creator" }));
    const before = userCalls.length;
    const id = await queue(c, liveCount(), principalId, liveInput);
    expect(userCalls).toHaveLength(before);
    await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id);
    expect(await result(c, id)).toMatchObject({
      status: "succeeded",
      result: { data: { item_count: 2 }, acknowledgement: "read" },
    });
    expect(userCalls.at(-1)).toMatchObject({ path: liveCount().path, userId: "9007199254741093" });
    const row = await withTenantTx(h.worker, userCtx(me.tenant.id), (tx) =>
      tx.execute(sql`SELECT operation_id,account_id,store_id FROM commerce_operation WHERE id=${id}`),
    );
    expect(row.rows[0]).toMatchObject({ operation_id: liveCount().id, account_id: principalId, store_id: null });
  });

  it("requires creator write permission for OBS credentials and retains secrets only in the expiring private artifact", async () => {
    const { c, me } = await owner();
    const principalId = await creator(c, me, "9007199254741094");
    const reader = await member(c, me.tenant.id, ["commerce:read", "affiliate:read", "affiliate:account_read"]);
    const op = streamCredentials();
    const before = userCalls.length;
    expect((await submit(reader.c, op, principalId, liveInput)).status).toBe(403);
    expect(userCalls).toHaveLength(before);
    const writer = await member(c, me.tenant.id, [
      "commerce:read",
      "affiliate:read",
      "affiliate:write",
      "affiliate:account_read",
    ]);
    const id = await queue(writer.c, op, principalId, liveInput);
    await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id);
    const view = await result(writer.c, id);
    expect(view.status, JSON.stringify(view)).toBe("succeeded");
    expect(view.result.artifact).toMatchObject({
      mime: "text/plain",
      sizeBytes: expect.any(Number),
      fileId: expect.any(String),
    });
    expect(Date.parse(view.result.artifact.expiresAt) - Date.now()).toBeGreaterThan(3_500_000);
    for (const secret of [STREAM_URL, STREAM_KEY, "SECRET_PLAY"]) expect(JSON.stringify(view)).not.toContain(secret);
    const download = await binary(writer.c.get(`/v1/commerce/requests/${id}/download`));
    expect(download.status).toBe(200);
    expect(download.body.toString("utf8")).toContain(STREAM_KEY);
    expect(download.body.toString("utf8")).toContain(STREAM_URL);
    expect((await reader.c.get(`/v1/commerce/requests/${id}/download`)).status).toBe(403);
    const foreign = await owner();
    expect((await foreign.c.get(`/v1/commerce/requests/${id}/download`)).status).toBe(404);
    const normal = await queue(c, operation("/api/v2/livestream/get_session_detail"), principalId, liveInput);
    await worker.runJob(commerceExecuteJob, { requestId: normal }, me.tenant.id);
    const ordinary = JSON.stringify(await result(c, normal));
    for (const secret of [STREAM_URL, STREAM_KEY, "SECRET_PLAY"]) expect(ordinary).not.toContain(secret);
    const logs = await withTenantTx(h.worker, userCtx(me.tenant.id), (tx) =>
      tx.execute(sql`SELECT request_summary,response_summary FROM sync_job`),
    );
    const audit = (await c.get("/v1/audit-logs?entity_type=commerce_operation")).body;
    for (const secret of [STREAM_URL, STREAM_KEY, "SECRET_PLAY", ...usersByToken.keys()]) {
      expect(JSON.stringify(logs.rows)).not.toContain(secret);
      expect(JSON.stringify(audit)).not.toContain(secret);
    }
    const expired = userCtx(me.tenant.id);
    await withTenantTx(h.worker, expired, (tx) =>
      tx.execute(
        sql`UPDATE file_object SET expires_at=now()-interval '1 minute' WHERE id=${view.result.artifact.fileId}`,
      ),
    );
    await worker.ctx.get(FilesService).cleanupExpired(expired);
    expect((await writer.c.get(`/v1/commerce/requests/${id}/download`)).status).toBe(404);
  });

  it("binds uploaded PDFs to their exact return document field and sends both in a signed multipart request", async () => {
    const { c, me } = await owner();
    const principalId = await seller(c, me);
    const op = returnDocuments();
    const label = await c.upload(op, principalId, "body.return_shipping_label");
    const qr = await c.upload(op, principalId, "body.return_qr_code");
    expect(label.status, JSON.stringify(label.body)).toBe(201);
    expect(qr.status, JSON.stringify(qr.body)).toBe(201);
    expect(JSON.stringify([label.body, qr.body])).not.toContain("PRIVATE_BUYER");
    expect((await submit(c, op, principalId, returnInput(qr.body.fileId, label.body.fileId))).status).toBe(404);
    expect((await submit(c, op, principalId, returnInput(label.body.fileId, label.body.fileId))).status).toBe(404);
    expect((await c.upload(op, principalId)).status).toBe(422);
    expect((await c.upload(op, principalId, "body.arbitrary_file")).status).toBe(422);
    const id = await queue(c, op, principalId, returnInput(label.body.fileId, qr.body.fileId));
    await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id);
    expect((await result(c, id)).status).toBe("succeeded");
    const call = returnsTransport.calls.find((entry) => entry.operationId === op.id)!;
    expect(call.form?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "return_shipping_label", mime: "application/pdf" }),
        expect.objectContaining({ field: "return_qr_code", mime: "application/pdf" }),
      ]),
    );
    expect(call.form?.files).toHaveLength(2);
    expect(returnsTransport.violations).toEqual([]);
    const bindings = await withTenantTx(h.worker, userCtx(me.tenant.id), (tx) =>
      tx.execute(sql`SELECT field_name FROM commerce_file ORDER BY field_name`),
    );
    expect(bindings.rows.map((row) => row.field_name)).toEqual(["body.return_qr_code", "body.return_shipping_label"]);
  });

  it("enforces the PDF-only return contract and separate label and QR application size limits", async () => {
    const { c, me } = await owner();
    const principalId = await seller(c, me);
    const op = returnDocuments();
    expect((await c.upload(op, principalId, "body.return_qr_code", PNG, "application/pdf")).status).toBe(422);
    expect((await c.upload(op, principalId, "body.return_shipping_label", PNG, "application/pdf")).status).toBe(422);
    const aboveQr = Buffer.alloc(2_000_001);
    PDF.copy(aboveQr);
    expect((await c.upload(op, principalId, "body.return_qr_code", aboveQr)).status).toBe(422);
    expect((await c.upload(op, principalId, "body.return_shipping_label", aboveQr)).status).toBe(201);
    const aboveLabel = Buffer.alloc(10_000_001);
    PDF.copy(aboveLabel);
    expect((await c.upload(op, principalId, "body.return_shipping_label", aboveLabel)).status).toBe(422);
    expect((await c.upload(op, principalId, "body.return_qr_code", Buffer.alloc(0))).status).toBe(422);
  });
});
