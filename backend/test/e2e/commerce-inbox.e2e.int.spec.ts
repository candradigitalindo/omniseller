import type { INestApplication } from "@nestjs/common";
import { createTiktokShopConnector, TIKTOK_COMMERCE_OPERATIONS } from "@omniseller/connector-tiktokshop";
import { newId } from "@omniseller/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONNECTORS, type ConnectorRegistry } from "../../src/modules/channel/connector-registry";
import { CredentialService } from "../../src/modules/channel/credential.service";
import { INBOX_OPERATIONS } from "../../src/modules/commerce-inbox/commerce-inbox-projection";
import { connectorCallObserver, connectorRequestGate } from "../../src/modules/sync/connector-calls";
import { signup, startApi, startWorker } from "../setup/app";
import { CommerceTransport } from "../setup/commerce-transport";
import { userCtx } from "../setup/factories";
import { testHandles } from "../setup/handles";
import { MockMarketplace, TIKTOK } from "../setup/mock-marketplace";

const h = testHandles();
let api: INestApplication;
let mock: MockMarketplace;
let worker: Awaited<ReturnType<typeof startWorker>>;
let transport: CommerceTransport;
const op = (kind: keyof typeof INBOX_OPERATIONS) =>
  TIKTOK_COMMERCE_OPERATIONS.find((item) => item.id === INBOX_OPERATIONS[kind])!;
async function drain(tenantId: string) {
  for (let i = 0; i < 15; i++) if (!(await worker.runOutbox(tenantId)).length) return;
}
beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  api = await startApi(h.infra, { marketplace: mock });
  worker = await startWorker(h.infra, h.system, { marketplace: mock });
  transport = new CommerceTransport(TIKTOK_COMMERCE_OPERATIONS, mock.url);
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
async function fixture() {
  const owner = await signup(api);
  const external = newId();
  const sellerId = mock.addTiktokSeller({
    openId: external,
    name: "Seller pesan",
    userType: 0,
    scopes: [
      "seller.authorization.info",
      "seller.customer_service",
      "seller.logistics",
      "seller.fulfillment.basic",
      "seller.fulfillment.package.write",
      "seller.order.info",
      "seller.product.basic",
      "seller.product.write",
      "seller.return_refund.basic",
    ],
    shops: [
      { id: `inbox-${external}`, name: "Toko Pesan", region: "ID", cipher: `ROW_INBOX_${external}`, warehouses: [] },
    ],
  });
  const start = await owner.c.post("/v1/store-authorizations", { channel: "tiktokshop" });
  expect(start.status).toBe(201);
  expect(
    (
      await owner.c.post("/v1/store-authorizations/callback", {
        channel: "tiktokshop",
        state: new URL(start.body.authorizeUrl).searchParams.get("state"),
        code: mock.tiktokCode(sellerId),
      })
    ).status,
  ).toBe(202);
  await drain(owner.me.tenant.id);
  const completed = (await owner.c.get(`/v1/store-authorizations/${start.body.id}`)).body;
  expect(completed.status).toBe("succeeded");
  const principalId = completed.result.stores[0].storeId as string;
  expect((await owner.c.patch(`/v1/stores/${principalId}`, { syncMode: "live" })).status).toBe(200);
  const token = await worker.ctx
    .get(CredentialService)
    .forShop(userCtx(owner.me.tenant.id, owner.me.user.id), principalId);
  transport.principals.set(token.shop.accessToken, { kind: "seller", shopCipher: token.shop.shopCipher });
  return { ...owner, principalId };
}
const conversationId = "7494560109732334261";
const visibleMessage = {
  id: "7494560109732334263",
  type: "TEXT",
  is_visible: true,
  content: '{"content":"Halo toko"}',
  sender: { role: "BUYER", nickname: "Ayu" },
  create_time: 1792200000,
};
describe("commerce inbox over real tenant API and signed worker transport", () => {
  it("retrieves paged conversations and messages while excluding invisible marketplace messages", async () => {
    const { c, me, principalId } = await fixture();
    transport.reply(op("conversations"), {
      data: {
        next_page_token: "cursor-next",
        conversations: [
          {
            id: conversationId,
            can_send_message: true,
            unread_count: 1,
            participants: [{ role: "BUYER", nickname: "Ayu" }],
            latest_message: visibleMessage,
          },
        ],
      },
    });
    const request = await c
      .post("/v1/commerce-inbox/conversations/search", { principalId })
      .set("Idempotency-Key", newId());
    expect(request.status, JSON.stringify(request.body)).toBe(202);
    await drain(me.tenant.id);
    const receipt = await c.get(`/v1/commerce-inbox/requests/${request.body.id}`);
    expect(receipt.status).toBe(200);
    expect(receipt.body).toMatchObject({
      status: "succeeded",
      kind: "conversations",
      nextCursor: "cursor-next",
      conversations: [{ id: conversationId, name: "Ayu", preview: "Halo toko", unread: 1, canReply: true }],
    });
    expect(transport.calls[0]?.url.searchParams.get("locale")).toBe("id-ID");
    transport.reply(op("messages"), {
      data: {
        messages: [
          visibleMessage,
          { ...visibleMessage, id: "hidden", is_visible: false, content: '{"content":"BUYER_ONLY_RATING"}' },
        ],
      },
    });
    const messages = await c
      .post("/v1/commerce-inbox/messages/search", { principalId, conversationId })
      .set("Idempotency-Key", newId());
    expect(messages.status).toBe(202);
    await drain(me.tenant.id);
    const page = await c.get(`/v1/commerce-inbox/requests/${messages.body.id}`);
    expect(page.body.messages).toHaveLength(1);
    expect(page.body.messages[0]).toMatchObject({ id: visibleMessage.id, text: "Halo toko", incoming: true });
    expect(JSON.stringify(page.body)).not.toContain("BUYER_ONLY_RATING");
    expect(transport.count(op("read"))).toBe(0);
    transport.reply(op("create"), { data: { conversation_id: conversationId } });
    const created = await c
      .post("/v1/commerce-inbox/conversations", { principalId, buyerUserId: "7494560109732334262" })
      .set("Idempotency-Key", newId());
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    await drain(me.tenant.id);
    expect((await c.get(`/v1/commerce-inbox/requests/${created.body.id}`)).body).toMatchObject({
      kind: "create",
      status: "succeeded",
      conversationId,
    });
    expect(JSON.parse(transport.calls.find((call) => call.operationId === op("create").id)!.body)).toEqual({
      buyer_user_id: "7494560109732334262",
    });
  });
  it("sends one documented text request for a repeated idempotency key and never resends an uncertain write", async () => {
    const { c, me, principalId } = await fixture();
    transport.reply(op("send"), { data: { message_id: "7494560109732334299" } });
    const body = { principalId, conversationId, type: "TEXT", text: "Selamat siang" };
    const key = newId();
    const first = await c.post("/v1/commerce-inbox/messages/send", body).set("Idempotency-Key", key);
    const repeated = await c.post("/v1/commerce-inbox/messages/send", body).set("Idempotency-Key", key);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(repeated.body.id).toBe(first.body.id);
    await drain(me.tenant.id);
    expect(transport.count(op("send"))).toBe(1);
    expect(JSON.parse(transport.calls[0]!.body)).toEqual({
      type: "TEXT",
      content: '{"content":"Selamat siang"}',
      sender_role: "CUSTOMER_SERVICE",
    });
    expect((await c.get(`/v1/commerce-inbox/requests/${first.body.id}`)).body).toMatchObject({
      status: "succeeded",
      messageId: "7494560109732334299",
    });
    transport.reply(op("send"), { network: true });
    const unknown = await c.post("/v1/commerce-inbox/messages/send", body).set("Idempotency-Key", newId());
    await drain(me.tenant.id);
    expect((await c.get(`/v1/commerce-inbox/requests/${unknown.body.id}`)).body.status).toBe("uncertain");
    await drain(me.tenant.id);
    expect(transport.count(op("send"))).toBe(2);
  });
  it("rejects foreign tenants, unsupported image URL input and mismatched reply fields before dispatch", async () => {
    const { c, me, principalId } = await fixture();
    const foreign = await signup(api);
    const own = await c
      .post("/v1/commerce-inbox/conversations/search", { principalId })
      .set("Idempotency-Key", newId());
    expect((await foreign.c.get(`/v1/commerce-inbox/requests/${own.body.id}`)).status).toBe(404);
    expect(
      (await foreign.c.post("/v1/commerce-inbox/conversations/search", { principalId }).set("Idempotency-Key", newId()))
        .status,
    ).toBe(404);
    for (const invalid of [
      { principalId, conversationId, type: "IMAGE", url: "https://example.test/not-uploaded" },
      { principalId, conversationId, type: "TEXT", text: "Halo", orderId: "123" },
      { principalId, conversationId, type: "TEXT", text: " " },
    ])
      expect((await c.post("/v1/commerce-inbox/messages/send", invalid).set("Idempotency-Key", newId())).status).toBe(
        422,
      );
    await drain(me.tenant.id);
    expect(transport.count(op("send"))).toBe(0);
  });
  it("allows paged reads in read-only mode and refuses sending or marking read before dispatch", async () => {
    const { c, me, principalId } = await fixture();
    expect((await c.patch(`/v1/stores/${principalId}`, { syncMode: "read_only" })).status).toBe(200);
    const read = await c
      .post("/v1/commerce-inbox/messages/search", { principalId, conversationId })
      .set("Idempotency-Key", newId());
    expect(read.status).toBe(202);
    const send = await c
      .post("/v1/commerce-inbox/messages/send", { principalId, conversationId, type: "TEXT", text: "Halo" })
      .set("Idempotency-Key", newId());
    expect(send.status).toBe(409);
    expect(send.body.code).toBe("commerce.read_only");
    expect(
      (
        await c
          .post("/v1/commerce-inbox/messages/read", { principalId, conversationId })
          .set("Idempotency-Key", newId())
      ).status,
    ).toBe(409);
    await drain(me.tenant.id);
    expect(transport.count(op("messages"))).toBe(1);
    expect(transport.count(op("send"))).toBe(0);
    expect(transport.count(op("read"))).toBe(0);
  });
});
