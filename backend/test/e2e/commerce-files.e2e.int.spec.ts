import type { INestApplication } from "@nestjs/common";
import type { CommerceInput, CommerceOperation } from "@omniseller/connector-core";
import { createTiktokShopConnector, TIKTOK_COMMERCE_OPERATIONS } from "@omniseller/connector-tiktokshop";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTenantTx } from "../../src/db/tenant-tx";
import { AffiliateAccountCredentialsService } from "../../src/modules/affiliate-accounts/accounts-credentials.service";
import { CONNECTORS, type ConnectorRegistry } from "../../src/modules/channel/connector-registry";
import { CredentialService } from "../../src/modules/channel/credential.service";
import { commerceExecuteJob } from "../../src/modules/commerce/commerce.jobs";
import { CommerceService } from "../../src/modules/commerce/commerce.service";
import { CommerceFilesService } from "../../src/modules/commerce/commerce-files.service";
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
import { MockMarketplace, TIKTOK } from "../setup/mock-marketplace";

const h = testHandles();
let api: INestApplication;
let mock: MockMarketplace;
let worker: Awaited<ReturnType<typeof startWorker>>;
let transport: CommerceTransport;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a49sAAAAASUVORK5CYII=",
  "base64",
);
const VIDEO = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypmp42"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("mp42isom"),
  Buffer.from("PRIVATE_VIDEO_BYTES"),
]);
const photoPath = "/affiliate_creator/202511/photos/photo_files";
const videoPath = "/affiliate_creator/202505/videos/video_files";
const downloadPath = "/affiliate_seller/202603/compass/offline_tasks/{task_id}/file";
function op(path: string, method = "POST") {
  const found = TIKTOK_COMMERCE_OPERATIONS.find((operation) => operation.path === path && operation.method === method);
  if (!found) throw new Error(`Missing documented media operation ${path}`);
  return found;
}
const photo = () => op(photoPath);
const video = () => op(videoPath);
const compass = () => op(downloadPath, "GET");
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
    upload: (
      operation: CommerceOperation,
      principalId: string,
      bytes: Buffer = PNG,
      filename = "PRIVATE_CUSTOMER_NAME_08123456789.png",
      mime = "image/png",
    ) =>
      withIp(agent.post("/v1/commerce/files"))
        .field("operationId", operation.id)
        .field("principalId", principalId)
        .attach("file", bytes, { filename, contentType: mime }),
  };
}
type FileClient = ReturnType<typeof fileClient>;
const binary = (test: request.Test) =>
  test.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => callback(null, Buffer.concat(chunks)));
  });
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
async function drain(tenantId: string) {
  for (let i = 0; i < 15; i++) if (!(await worker.runOutbox(tenantId)).length) return;
}
async function owner() {
  const c = fileClient();
  const response = await c.post("/v1/auth/signup", {
    businessName: "Bisnis Media Commerce",
    name: "Rina",
    email: uniqueEmail("media"),
    password: PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { c, me: response.body as MeBody };
}
async function connect(c: Client, me: MeBody, kind: "creator" | "seller" = "creator") {
  const scopes = [
    ...new Set([
      kind === "creator" ? "creator.affiliate.info" : "seller.authorization.info",
      ...TIKTOK_COMMERCE_OPERATIONS.filter((operation) => operation.principalKind === kind).flatMap(
        (operation) => operation.scopes,
      ),
    ]),
  ];
  const id = newId();
  const seller = mock.addTiktokSeller({
    openId: id,
    name: "Akun media",
    userType: kind === "creator" ? 1 : 0,
    scopes,
    shops:
      kind === "creator"
        ? []
        : [{ id: `7495${id}`, name: "Toko media", region: "ID", cipher: `ROW_${id}`, warehouses: [] }],
  });
  const base = kind === "creator" ? "/v1/affiliate/authorizations" : "/v1/store-authorizations";
  const started = await c.post(base, kind === "creator" ? { kind } : { channel: "tiktokshop" });
  expect(started.status).toBe(201);
  const callback = await c.post(`${base}/callback`, {
    state: new URL(started.body.authorizeUrl).searchParams.get("state"),
    code: mock.tiktokCode(seller),
    ...(kind === "seller" ? { channel: "tiktokshop" } : {}),
  });
  expect(callback.status).toBe(kind === "creator" ? 201 : 202);
  await drain(me.tenant.id);
  const completed = (await c.get(`${base}/${started.body.id}`)).body;
  expect(completed.status, JSON.stringify(completed)).toBe("succeeded");
  const principalId = (kind === "creator" ? completed.accountId : completed.result.stores[0].storeId) as string;
  const ctx = userCtx(me.tenant.id, me.user.id);
  if (kind === "creator") {
    const current = await worker.ctx.get(AffiliateAccountCredentialsService).forAccount(ctx, principalId);
    transport.principals.set(current.accessToken, { kind });
  } else {
    const current = await worker.ctx.get(CredentialService).forShop(ctx, principalId);
    transport.principals.set(current.shop.accessToken, { kind, shopCipher: current.shop.shopCipher });
  }
  return principalId;
}
async function fixture(kind: "creator" | "seller" = "creator") {
  const created = await owner();
  return { ...created, principal: await connect(created.c, created.me, kind) };
}
async function uploaded(
  c: FileClient,
  operation: CommerceOperation,
  principal: string,
  bytes = PNG,
  mime = "image/png",
) {
  const response = await c.upload(operation, principal, bytes, undefined, mime);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body as { fileId: string; filename: string; mime: string; sizeBytes: number; expiresAt: string };
}
function submit(c: Client, operation: CommerceOperation, principal: string, input: CommerceInput, key = newId()) {
  return c
    .post("/v1/commerce/requests", {
      operationId: operation.id,
      principalId: principal,
      input,
      confirmed: operation.write,
    })
    .set("Idempotency-Key", key);
}
async function queue(c: Client, operation: CommerceOperation, principal: string, input: CommerceInput) {
  const response = await submit(c, operation, principal, input);
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  return response.body.id as string;
}
async function result(c: Client, id: string) {
  const response = await c.get(`/v1/commerce/requests/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}
async function member(c: Client, tenantId: string, permissions: string[]) {
  const role = (await c.post("/v1/roles", { name: `Media ${newId().slice(-6)}`, permissions })).body;
  const email = uniqueEmail("mediastaff");
  expect((await c.post("/v1/invitations", { email, roleId: role.id })).status).toBe(201);
  await drain(tenantId);
  const user = fileClient();
  expect(
    (
      await user.post("/v1/auth/invitations/accept", {
        token: tokenFrom(worker.email.lastTo(email)!.text),
        name: "Staf media",
        password: PASSWORD,
      })
    ).status,
  ).toBe(201);
  return { c: user, roleId: role.id };
}
async function downloaded() {
  const fixtureData = await fixture("seller");
  const bytes = Buffer.from("PRIVATE_MARKETPLACE_DOWNLOAD_BYTES\n", "utf8");
  transport.reply(compass(), { data: { file: { base64: bytes.toString("base64") } } });
  const id = await queue(fixtureData.c, compass(), fixtureData.principal, { path: { task_id: "9223372036854775806" } });
  await worker.runJob(commerceExecuteJob, { requestId: id }, fixtureData.me.tenant.id);
  const view = await result(fixtureData.c, id);
  expect(view.status, JSON.stringify(view)).toBe("succeeded");
  expect(view.result.artifact).toBeTruthy();
  return {
    ...fixtureData,
    id,
    bytes,
    artifact: view.result.artifact as { fileId: string; expiresAt: string; sizeBytes: number; mime: string },
  };
}

describe("private commerce media and retained downloads", () => {
  it.each(["photo", "video"] as const)(
    "sends creator %s as signed multipart bytes and keeps the browser filename private",
    async (kind) => {
      const { c, me, principal } = await fixture();
      const operation = kind === "photo" ? photo() : video();
      const bytes = kind === "photo" ? PNG : VIDEO;
      const catalog = (await c.get("/v1/commerce/operations")).body.items;
      expect(catalog).toContainEqual(
        expect.objectContaining({ id: operation.id, available: true, transport: "multipart" }),
      );
      transport.reply(operation, {
        data:
          kind === "photo"
            ? { photo_file: { uri: "public-photo-reference" } }
            : { video_file: { id: "public-video-reference" } },
      });
      const file = await uploaded(c, operation, principal, bytes, kind === "photo" ? "image/png" : "video/mp4");
      expect(file).toMatchObject({
        filename: kind === "photo" ? "commerce.png" : "commerce.mp4",
        mime: kind === "photo" ? "image/png" : "video/mp4",
        sizeBytes: bytes.length,
      });
      expect(Date.parse(file.expiresAt) - Date.now()).toBeGreaterThan(3_500_000);
      expect(JSON.stringify(file)).not.toContain("PRIVATE_CUSTOMER_NAME");
      const id = await queue(c, operation, principal, { body: { data: file.fileId } });
      await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id);
      expect(await result(c, id)).toMatchObject({ status: "succeeded", result: { acknowledgement: "accepted" } });
      const call = transport.calls.find((item) => item.operationId === operation.id)!;
      expect(call.body).toBe("");
      expect(call.form?.files).toHaveLength(1);
      expect(call.form?.files[0]).toMatchObject({ field: "data", filename: file.filename, mime: file.mime });
      expect(Buffer.from(call.form!.files[0]!.bytes)).toEqual(bytes);
      expect(call.url.searchParams.has("shop_cipher")).toBe(false);
      const apiRole = await h.raw("api");
      await expect(apiRole.query("UPDATE commerce_file SET operation_id='spoof'")).rejects.toMatchObject({
        code: "42501",
      });
    },
  );

  it("checks actual media bytes and documented limits instead of trusting MIME or filename", async () => {
    const { c, me, principal } = await fixture();
    const before = (await h.system.db.execute(sql`SELECT id FROM commerce_file WHERE tenant_id=${me.tenant.id}`)).rows
      .length;
    expect(
      (await c.upload(photo(), principal, Buffer.from("%PDF-1.7\nnot an image"), "innocent.png", "image/png")).status,
    ).toBe(422);
    expect((await c.upload(photo(), principal, Buffer.alloc(0), "empty.png", "image/png")).status).toBe(422);
    expect((await c.upload(video(), principal, PNG, "fake.mp4", "video/mp4")).status).toBe(422);
    const avif = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypavif"), Buffer.alloc(16)]);
    expect((await c.upload(video(), principal, avif, "spoofed.mp4", "video/mp4")).status).toBe(422);
    const tooLarge = Buffer.alloc(10_485_761);
    PNG.copy(tooLarge);
    expect((await c.upload(photo(), principal, tooLarge, "large.png", "image/png")).status).toBe(422);
    expect(
      (await h.system.db.execute(sql`SELECT id FROM commerce_file WHERE tenant_id=${me.tenant.id}`)).rows,
    ).toHaveLength(before);
    const normalized = await c.upload(photo(), principal, PNG, "PRIVATE_FILENAME.exe", "application/x-msdownload");
    expect(normalized.status, JSON.stringify(normalized.body)).toBe(201);
    expect(normalized.body).toMatchObject({ filename: "commerce.png", mime: "image/png" });
    expect(transport.calls).toEqual([]);
  });

  it("binds an upload to its tenant, account and exact operation and rejects raw objects or remote URLs", async () => {
    const { c, me, principal } = await fixture();
    const other = await connect(c, me);
    const foreign = await fixture();
    const file = await uploaded(c, photo(), principal);
    expect((await submit(c, photo(), other, { body: { data: file.fileId } })).status).toBe(404);
    expect((await submit(c, video(), principal, { body: { data: file.fileId } })).status).toBe(404);
    expect((await submit(foreign.c, photo(), foreign.principal, { body: { data: file.fileId } })).status).toBe(404);
    expect((await foreign.c.upload(photo(), principal)).status).toBe(404);
    const row = await h.system.db.execute<{ file_id: string }>(
      sql`SELECT file_id FROM commerce_file WHERE id=${file.fileId}`,
    );
    expect((await submit(c, photo(), principal, { body: { data: row.rows[0]!.file_id } })).status).toBe(404);
    expect((await submit(c, photo(), principal, { body: { data: "http://127.0.0.1/internal-only" } })).status).toBe(
      422,
    );
    expect(transport.calls).toEqual([]);
  });

  it("lets an authorized business role use media without managing account connections and rechecks its business permission", async () => {
    const { c, me, principal } = await fixture();
    const user = await member(c, me.tenant.id, [
      "commerce:read",
      "commerce:write",
      "affiliate:read",
      "affiliate:write",
      "affiliate:account_read",
    ]);
    const file = await uploaded(user.c, photo(), principal);
    const id = await queue(user.c, photo(), principal, { body: { data: file.fileId } });
    await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id);
    expect((await result(c, id)).status).toBe("succeeded");
    expect(
      (
        await c.patch(`/v1/roles/${user.roleId}`, {
          permissions: ["commerce:read", "commerce:write", "affiliate:read", "affiliate:account_read"],
        })
      ).status,
    ).toBe(200);
    expect((await user.c.upload(photo(), principal)).status).toBe(403);
    expect((await submit(user.c, photo(), principal, { body: { data: file.fileId } })).status).toBe(403);
    expect(transport.calls).toHaveLength(1);
  });

  it("rechecks business permission after storing bytes before publishing a media handle", async () => {
    const { c, me, principal } = await fixture();
    const user = await member(c, me.tenant.id, [
      "commerce:read",
      "commerce:write",
      "affiliate:read",
      "affiliate:write",
      "affiliate:account_read",
    ]);
    const files = api.get(FilesService);
    const save = files.saveFromLocalFile.bind(files);
    let revokedStatus: number | undefined;
    const spy = vi.spyOn(files, "saveFromLocalFile").mockImplementation(async (ctx, input) => {
      const file = await save(ctx, input);
      revokedStatus = (
        await c.patch(`/v1/roles/${user.roleId}`, {
          permissions: ["commerce:read", "commerce:write", "affiliate:read", "affiliate:account_read"],
        })
      ).status;
      return file;
    });
    let response: Awaited<ReturnType<FileClient["upload"]>>;
    try {
      response = await user.c.upload(photo(), principal);
    } finally {
      spy.mockRestore();
    }
    expect(revokedStatus).toBe(200);
    expect(response.status).toBe(403);
    const rows = await h.system.db.execute(sql`SELECT id FROM commerce_file WHERE tenant_id=${me.tenant.id}`);
    expect(rows.rows).toEqual([]);
    expect(transport.calls).toEqual([]);
  });

  it("refuses expired media before API submission and before queued worker dispatch", async () => {
    const { c, me, principal } = await fixture();
    const file = await uploaded(c, photo(), principal);
    const id = await queue(c, photo(), principal, { body: { data: file.fileId } });
    await h.system.db.execute(
      sql`UPDATE commerce_file SET expires_at=now()-interval '1 minute' WHERE id=${file.fileId}`,
    );
    expect((await submit(c, photo(), principal, { body: { data: file.fileId } })).status).toBe(404);
    await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id);
    expect(await result(c, id)).toMatchObject({ status: "failed", result: null });
    expect(transport.calls).toEqual([]);
    const lost = await uploaded(c, photo(), principal);
    await h.system.db.execute(
      sql`UPDATE file_object SET expires_at=now()-interval '1 minute' WHERE id=(SELECT file_id FROM commerce_file WHERE id=${lost.fileId})`,
    );
    await worker.ctx.get(FilesService).cleanupExpired(userCtx(me.tenant.id, me.user.id));
    expect((await submit(c, photo(), principal, { body: { data: lost.fileId } })).status).toBe(404);
  });

  it("returns the same successful receipt after media expiry without repeating the marketplace upload", async () => {
    const { c, me, principal } = await fixture();
    const file = await uploaded(c, photo(), principal);
    const input = { body: { data: file.fileId } };
    const key = newId();
    const original = await submit(c, photo(), principal, input, key);
    expect(original.status, JSON.stringify(original.body)).toBe(202);
    await worker.runJob(commerceExecuteJob, { requestId: original.body.id }, me.tenant.id);
    expect((await result(c, original.body.id)).status).toBe("succeeded");
    expect(transport.calls).toHaveLength(1);
    await h.system.db.execute(
      sql`UPDATE commerce_file SET expires_at=now()-interval '1 minute' WHERE id=${file.fileId}`,
    );
    const replay = await submit(c, photo(), principal, input, key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(202);
    expect(replay.body).toMatchObject({ id: original.body.id, status: "succeeded" });
    expect((await submit(c, photo(), principal, input)).status).toBe(404);
    await worker.runJob(commerceExecuteJob, { requestId: original.body.id }, me.tenant.id);
    expect(transport.calls).toHaveLength(1);
  });

  it("retains a marketplace download privately and enforces the same current tenant and role permissions", async () => {
    const { c, me, id, bytes, artifact } = await downloaded();
    const foreign = await owner();
    const response = await binary(c.get(`/v1/commerce/requests/${id}/download`));
    expect(response.status).toBe(200);
    expect(response.body).toEqual(bytes);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(artifact).toMatchObject({ mime: "application/octet-stream", sizeBytes: bytes.length });
    expect(JSON.stringify(await result(c, id))).not.toContain(bytes.toString("base64"));
    expect((await foreign.c.get(`/v1/commerce/requests/${id}/download`)).status).toBe(404);
    const user = await member(c, me.tenant.id, ["commerce:read", "affiliate:read"]);
    expect((await user.c.get(`/v1/commerce/requests/${id}/download`)).status).toBe(403);
    expect(
      (
        await c.patch(`/v1/roles/${user.roleId}`, {
          permissions: ["commerce:read", "affiliate:read", "finance:read", "finance:export"],
        })
      ).status,
    ).toBe(200);
    expect((await binary(user.c.get(`/v1/commerce/requests/${id}/download`))).status).toBe(200);
    expect(
      (await c.patch(`/v1/roles/${user.roleId}`, { permissions: ["commerce:read", "affiliate:read", "finance:read"] }))
        .status,
    ).toBe(200);
    expect((await user.c.get(`/v1/commerce/requests/${id}/download`)).status).toBe(403);
    expect((await c.get(`/v1/files/${artifact.fileId}/download`)).status).toBe(404);
  });

  it("rejects missing or expired download artifacts and does not fetch marketplace-supplied URLs", async () => {
    const { c, me, principal, id, artifact } = await downloaded();
    await h.system.db.execute(
      sql`UPDATE file_object SET expires_at=now()-interval '1 minute' WHERE id=${artifact.fileId}`,
    );
    expect((await c.get(`/v1/commerce/requests/${id}/download`)).status).toBe(404);
    await worker.ctx.get(FilesService).cleanupExpired(userCtx(me.tenant.id, me.user.id));
    expect((await c.get(`/v1/commerce/requests/${id}/download`)).status).toBe(404);
    transport.reply(compass(), { data: { file: { url: "http://169.254.169.254/latest/meta-data/" } } });
    const remote = await queue(c, compass(), principal, { path: { task_id: "9223372036854775805" } });
    await worker.runJob(commerceExecuteJob, { requestId: remote }, me.tenant.id);
    expect(await result(c, remote)).toMatchObject({ status: "failed", result: null, errorCode: "bad_response" });
    expect((await c.get(`/v1/commerce/requests/${remote}/download`)).status).toBe(404);
    expect(transport.calls).toHaveLength(2);
  });

  it("keeps raw media, download bytes and original filename out of sync logs, audit and metadata exports", async () => {
    const { c, me, principal } = await fixture();
    const marker = "PRIVATE_RAW_MEDIA_AND_FILENAME_08123456789";
    const bytes = Buffer.concat([PNG, Buffer.from(marker)]);
    const file = await uploaded(c, photo(), principal, bytes);
    transport.reply(photo(), { data: { photo_file: { uri: "public-image-reference" } } });
    const id = await queue(c, photo(), principal, { body: { data: file.fileId } });
    await worker.runJob(commerceExecuteJob, { requestId: id }, me.tenant.id);
    expect((await result(c, id)).status).toBe("succeeded");
    const seller = await connect(c, me, "seller");
    transport.reply(compass(), { data: { file: { base64: Buffer.from(marker).toString("base64") } } });
    const downloadId = await queue(c, compass(), seller, { path: { task_id: "9223372036854775806" } });
    await worker.runJob(commerceExecuteJob, { requestId: downloadId }, me.tenant.id);
    expect((await result(c, downloadId)).status).toBe("succeeded");
    const retained = await withTenantTx(h.worker, userCtx(me.tenant.id, me.user.id), async (tx) => {
      const logs = await tx.execute(
        sql`SELECT request_summary,response_summary,error_message FROM sync_job WHERE kind='commerce.operation'`,
      );
      const audits = await tx.execute(sql`SELECT before,after FROM audit_log`);
      const exported: unknown[] = [];
      for (const sheet of [
        ...worker.ctx.get(CommerceFilesService).exportSheets(),
        ...worker.ctx.get(CommerceService).exportSheets(),
      ])
        for await (const page of sheet.pages(tx, {
          storeName: () => null,
          warehouseCode: () => null,
          userName: () => null,
        }))
          exported.push(page);
      return { logs: logs.rows, audits: audits.rows, exported };
    });
    const serialized = JSON.stringify({
      file,
      upload: await result(c, id),
      download: await result(c, downloadId),
      ...retained,
    });
    for (const privateValue of [
      marker,
      bytes.toString("base64"),
      Buffer.from(marker).toString("base64"),
      "PRIVATE_CUSTOMER_NAME_08123456789",
      ...transport.calls.map((call) => call.accessToken),
    ])
      expect(serialized).not.toContain(privateValue);
    expect(retained.logs).toHaveLength(2);
  });
});
