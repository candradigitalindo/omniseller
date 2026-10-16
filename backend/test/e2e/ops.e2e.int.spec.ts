import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { INestApplication } from "@nestjs/common";
import { newId } from "@omniseller/shared";
import { Worker } from "bullmq";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemContext } from "../../src/common/context/request-context";
import { LocalKeyProvider } from "../../src/common/security/key-provider";
import { TokenVault } from "../../src/common/security/token-vault";
import { outboxEvent, store, storeCredential, tenant, tenantKey, webhookInbox } from "../../src/db/schema";
import { withSystemTx, withTenantTx } from "../../src/db/tenant-tx";
import { TOKEN_VAULT } from "../../src/infra/tokens";
import { QueueRegistry } from "../../src/jobs/queues";
import { tenantDekRotateJob } from "../../src/modules/channel/channel.jobs";
import { CredentialService, purposeOf } from "../../src/modules/channel/credential.service";
import { tenantPurgeJob } from "../../src/modules/retention/retention.jobs";
import { executeOps } from "../../src/ops/execute";
import { parseOpsCommand } from "../../src/ops/ops-plan";
import { PASSWORD, signup, startApi, startWorker, TEST_TOKEN_KEY } from "../setup/app";
import { testHandles } from "../setup/handles";
import { MockMarketplace } from "../setup/mock-marketplace";

const h = testHandles();
let api: INestApplication;
let worker: Awaited<ReturnType<typeof startWorker>>;
let queues: QueueRegistry;
let mock: MockMarketplace;
const env = { NODE_ENV: "test" };
beforeAll(async () => {
  mock = new MockMarketplace();
  await mock.start();
  api = await startApi(h.infra, { marketplace: mock });
  worker = await startWorker(h.infra, h.system, { marketplace: mock });
  queues = new QueueRegistry(h.redis, `${h.infra.keyPrefix}_ops`);
});
afterAll(async () => {
  await queues?.close();
  await worker?.close();
  await api?.close();
  await mock?.close();
});
const run = (args: string[], source = env) =>
  executeOps(parseOpsCommand(args), { worker: h.worker, system: h.system, queues }, source);
const rows = (tenantId: string) =>
  withSystemTx(h.system, (tx) =>
    tx
      .select()
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.tenantId, tenantId),
          sql`${outboxEvent.eventType} IN ('webhook.replay_requested', 'stock.push_requested', 'tenant.dek_rotation_requested', 'tenant.purge_requested')`,
        ),
      ),
  );

async function inbox(tenantId: string, overrides: Partial<typeof webhookInbox.$inferInsert> = {}) {
  const id = newId();
  const storeId = newId();
  await withTenantTx(h.worker, systemContext(tenantId), (tx) =>
    tx.insert(store).values({ id: storeId, tenantId, channel: "shopee", externalShopId: newId(), name: "Fixture" }),
  );
  await withTenantTx(h.api, systemContext(tenantId), (tx) =>
    tx.insert(webhookInbox).values({
      id,
      tenantId,
      storeId,
      source: "shopee",
      eventId: newId(),
      signatureValid: true,
      headers: {},
      payload: { code: 999 },
      ...overrides,
    }),
  );
  return id;
}

describe("operational requests through tenant transactions and outbox", () => {
  it("previews, replays processed webhooks only with force, and rejects another tenant or an invalid signature", async () => {
    const a = await signup(api);
    const b = await signup(api);
    const id = await inbox(a.me.tenant.id, { processedAt: new Date() });
    const args = ["webhook:replay", "--tenant", a.me.tenant.id, "--id", id];
    await expect(run(args)).rejects.toThrow("no eligible webhook");
    expect(await run([...args, "--force", "--dry-run"])).toMatchObject({ selected: 1 });
    expect(await rows(a.me.tenant.id)).toHaveLength(0);
    await expect(run(["webhook:replay", "--tenant", b.me.tenant.id, "--id", id, "--force"])).rejects.toThrow();
    for (const overrides of [{ signatureValid: false }, { storeId: null }]) {
      const invalid = await inbox(a.me.tenant.id, overrides);
      await expect(run(["webhook:replay", "--tenant", a.me.tenant.id, "--id", invalid, "--force"])).rejects.toThrow();
    }
    await run([...args, "--force"]);
    const first = (await rows(a.me.tenant.id))[0]!;
    expect(first).toMatchObject({ jobName: "webhook.process", tenantId: a.me.tenant.id, aggregateId: id });
    expect(first.jobId).toContain("|replay|");
    await worker.runOutbox(a.me.tenant.id);
    const processed = await withTenantTx(h.worker, systemContext(a.me.tenant.id), (tx) =>
      tx.select({ at: webhookInbox.processedAt }).from(webhookInbox).where(eq(webhookInbox.id, id)),
    );
    expect(processed[0]?.at).toBeInstanceOf(Date);
    await run([...args, "--force"]);
    expect(new Set((await rows(a.me.tenant.id)).map((r) => r.jobId)).size).toBe(2);
  });

  it("limits source/since replay and leaves a dry run and other tenants unchanged", async () => {
    const a = await signup(api);
    const b = await signup(api);
    await inbox(a.me.tenant.id);
    await inbox(a.me.tenant.id);
    await inbox(b.me.tenant.id);
    await inbox(a.me.tenant.id, { source: "tiktokshop" });
    await inbox(a.me.tenant.id, { receivedAt: new Date("2020-01-01Z") });
    const args = [
      "webhook:replay",
      "--tenant",
      a.me.tenant.id,
      "--source",
      "shopee",
      "--since",
      "2026-01-01T00:00Z",
      "--limit",
      "1",
    ];
    expect(await run([...args, "--dry-run"])).toMatchObject({ selected: 1, more: true });
    expect(await rows(a.me.tenant.id)).toHaveLength(0);
    await run(args);
    expect(await rows(a.me.tenant.id)).toHaveLength(1);
    expect(await rows(b.me.tenant.id)).toHaveLength(0);
  });

  it("requests a stock push only for established own stock and never changes its quantity", async () => {
    const a = await signup(api);
    const b = await signup(api);
    const warehouseId = (await a.c.get("/v1/warehouses")).body.items[0].id as string;
    const product = await a.c.post("/v1/products", {
      sku: "OPS",
      name: "Tas",
      variants: [{ sku: "OPS-1", basePrice: 10_000, costPrice: 1000, weightG: 100 }],
    });
    expect(product.status).toBe(201);
    const variantId = product.body.variants[0].id as string;
    const args = ["stock:push", "--tenant", a.me.tenant.id, "--variant", variantId, "--warehouse", warehouseId];
    await expect(run(args)).rejects.toThrow("stock must be established");
    expect(
      (
        await a.c.post("/v1/inventory/adjustments", {
          lines: [{ variantId, warehouseId, mode: "set", quantity: 12 }],
          reason: "correction",
        })
      ).status,
    ).toBe(200);
    await worker.runOutbox(a.me.tenant.id);
    expect(await run([...args, "--dry-run"])).toMatchObject({ selected: 1 });
    expect(await rows(a.me.tenant.id)).toHaveLength(0);
    await expect(
      run(["stock:push", "--tenant", b.me.tenant.id, "--variant", variantId, "--warehouse", warehouseId]),
    ).rejects.toThrow();
    await run(args);
    expect((await rows(a.me.tenant.id))[0]?.jobName).toBe("stock.force_push");
    expect(await worker.runOutbox(a.me.tenant.id)).toContain("stock.force_push");
    const stock = await withTenantTx(h.worker, systemContext(a.me.tenant.id), (tx) =>
      tx.execute<{ on_hand: number }>(
        sql`SELECT on_hand FROM inventory WHERE variant_id = ${variantId} AND warehouse_id = ${warehouseId}`,
      ),
    );
    expect(stock.rows[0]?.on_hand).toBe(12);
  });

  it("refuses early tenant purge; a due request keeps the existing worker and database guards", async () => {
    const a = await signup(api);
    const id = a.me.tenant.id;
    const args = ["tenant:purge", "--tenant", id];
    await expect(run(args)).rejects.toThrow("past its purge date");
    expect((await a.c.post("/v1/account-closure", { businessName: "Toko Uji Coba", password: PASSWORD })).status).toBe(
      200,
    );
    await expect(run(args)).rejects.toThrow("past its purge date");
    await h.system.db.execute(sql`UPDATE tenant SET purge_after = now() - interval '1 second' WHERE id = ${id}`);
    expect(await run([...args, "--dry-run"])).toMatchObject({ selected: 1 });
    expect(await rows(id)).toHaveLength(0);
    await run(args);
    const job = (await rows(id))[0]!;
    expect(job.jobName).toBe("tenant.purge");
    await worker.runJob(tenantPurgeJob, job.payload, id);
    const [purged] = await h.system.db.select({ purgedAt: tenant.purgedAt }).from(tenant).where(eq(tenant.id, id));
    expect(purged?.purgedAt).toBeInstanceOf(Date);
    await expect(run(args)).rejects.toThrow("already purged");
  });

  it("runs partition maintenance idempotently with the system role", async () => {
    expect(await run(["partition:maintain", "--dry-run"])).toMatchObject({ selected: 1 });
    expect(await run(["partition:maintain"])).toHaveProperty("created");
    expect(await run(["partition:maintain"])).toEqual({ created: 0 });
    await expect(executeOps(parseOpsCommand(["partition:maintain"]), { system: h.worker }, env)).rejects.toThrow(
      "withSystemTx",
    );
    await expect(run(["partition:maintain"], { NODE_ENV: "production" })).rejects.toThrow("OPS_CONFIRM");
  });
});

describe("DEK rotation through the actual worker", () => {
  it("serializes a token writer against a rotation, keeps a newer rotation active on an older retry, and isolates tenants", async () => {
    const a = await signup(api);
    const b = await signup(api);
    const id = a.me.tenant.id;
    const ctx = systemContext(id);
    const vault = new TokenVault(new LocalKeyProvider(TEST_TOKEN_KEY));
    await withTenantTx(h.worker, ctx, (tx) => vault.seal(tx, id, "before", "test"));
    const rotationId = newId();
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const rotation = withTenantTx(h.worker, ctx, async (tx) => {
      const version = await vault.rotateIn(tx, id, rotationId);
      ready();
      await gate;
      return version;
    });
    await started;
    const writing = withTenantTx(h.worker, ctx, (tx) => vault.seal(tx, id, "after", "test"));
    release();
    const [version, sealed] = await Promise.all([rotation, writing]);
    expect(version).toBe(2);
    expect(sealed.dekVersion).toBe(2);
    await expect(
      withTenantTx(h.worker, systemContext(b.me.tenant.id), (tx) =>
        vault.open(tx, b.me.tenant.id, sealed.data, 2, "test"),
      ),
    ).rejects.toThrow("not found");
    await worker.runJob(tenantDekRotateJob, { rotationId: newId() }, id);
    await worker.runJob(tenantDekRotateJob, { rotationId }, id);
    expect((await withTenantTx(h.worker, ctx, (tx) => vault.seal(tx, id, "latest", "test"))).dekVersion).toBe(3);
  });

  it("resumes after a later batch fails, keeps tokens decryptable, and invalidates another process's active cache", async () => {
    const a = await signup(api);
    const id = a.me.tenant.id;
    const ctx = systemContext(id);
    const credentials = worker.ctx.get(CredentialService);
    const oldVault = new TokenVault(new LocalKeyProvider(TEST_TOKEN_KEY));
    const stores = Array.from({ length: 51 }, () => newId()).sort();
    await withTenantTx(h.worker, ctx, async (tx) => {
      for (const storeId of stores) {
        await tx
          .insert(store)
          .values({ id: storeId, tenantId: id, channel: "shopee", externalShopId: newId(), name: "Fixture" });
        await credentials.save(
          tx,
          ctx,
          storeId,
          {
            accessToken: `access-${storeId}`,
            refreshToken: `refresh-${storeId}`,
            accessExpiresAt: new Date(Date.now() + 3600_000),
            refreshExpiresAt: new Date(Date.now() + 86400_000),
            scopes: [],
          },
          null,
        );
      }
    });
    const before = await withTenantTx(h.worker, ctx, (tx) =>
      tx.select().from(storeCredential).orderBy(asc(storeCredential.storeId)),
    );
    await withTenantTx(h.worker, ctx, (tx) =>
      oldVault.open(tx, id, before[0]!.accessTokenEnc, 1, purposeOf(stores[0]!, "access")),
    );
    expect(await run(["crypto:rotate-dek", "--tenant", id, "--dry-run"])).toMatchObject({ selected: 1 });
    expect(await rows(id)).toHaveLength(0);
    const result = await run(["crypto:rotate-dek", "--tenant", id]);
    if (!("rotationId" in result) || typeof result.rotationId !== "string") throw new Error("missing rotation id");
    expect((await rows(id))[0]?.jobName).toBe("tenant.dek_rotate");
    const last = before.at(-1)!;
    await withTenantTx(h.worker, ctx, (tx) =>
      tx
        .update(storeCredential)
        .set({ accessTokenEnc: Buffer.from("bad") })
        .where(eq(storeCredential.id, last.id)),
    );
    await expect(worker.runJob(tenantDekRotateJob, { rotationId: result.rotationId }, id)).rejects.toThrow(
      "unsupported ciphertext",
    );
    const partial = await withTenantTx(h.worker, ctx, (tx) =>
      tx.select().from(storeCredential).orderBy(asc(storeCredential.storeId)),
    );
    expect(partial.filter((r) => r.dekVersion === 2)).toHaveLength(50);
    await withTenantTx(h.worker, ctx, (tx) =>
      tx.update(storeCredential).set({ accessTokenEnc: last.accessTokenEnc }).where(eq(storeCredential.id, last.id)),
    );
    await worker.runJob(tenantDekRotateJob, { rotationId: result.rotationId }, id);
    await worker.runJob(tenantDekRotateJob, { rotationId: result.rotationId }, id);
    await withTenantTx(h.worker, ctx, async (tx) => {
      const after = await tx.select().from(storeCredential).orderBy(asc(storeCredential.storeId));
      expect(after.every((r) => r.dekVersion === 2)).toBe(true);
      for (const row of after) {
        expect(await oldVault.open(tx, id, row.accessTokenEnc, row.dekVersion, purposeOf(row.storeId, "access"))).toBe(
          `access-${row.storeId}`,
        );
        expect(
          await oldVault.open(tx, id, row.refreshTokenEnc!, row.dekVersion, purposeOf(row.storeId, "refresh")),
        ).toBe(`refresh-${row.storeId}`);
      }
      expect((await oldVault.seal(tx, id, "new token", "test")).dekVersion).toBe(2);
      expect(await oldVault.open(tx, id, before[0]!.accessTokenEnc, 1, purposeOf(stores[0]!, "access"))).toBe(
        `access-${stores[0]}`,
      );
      const keys = await tx.select().from(tenantKey);
      expect(keys).toHaveLength(2);
      expect(keys.filter((k) => k.retiredAt === null)).toHaveLength(1);
    });
  });

  it("does not cache a rolled-back key under a reused version and refuses missing or closing tenants", async () => {
    const a = await signup(api);
    const id = a.me.tenant.id;
    const ctx = systemContext(id);
    const vault = worker.ctx.get<TokenVault>(TOKEN_VAULT);
    await expect(
      withTenantTx(h.worker, ctx, async (tx) => {
        await vault.seal(tx, id, "discarded", "test");
        await vault.seal(tx, id, "discarded again", "test");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const sealed = await withTenantTx(h.worker, ctx, (tx) => vault.seal(tx, id, "kept", "test"));
    const reader = new TokenVault(new LocalKeyProvider(TEST_TOKEN_KEY));
    expect(await withTenantTx(h.worker, ctx, (tx) => reader.open(tx, id, sealed.data, sealed.dekVersion, "test"))).toBe(
      "kept",
    );
    await expect(
      withTenantTx(h.worker, ctx, (tx) => reader.open(tx, id, sealed.data, sealed.dekVersion, "wrong-purpose")),
    ).rejects.toThrow();
    await expect(run(["crypto:rotate-dek", "--tenant", newId()])).rejects.toThrow("missing");
    await a.c.post("/v1/account-closure", { businessName: "Toko Uji Coba", password: PASSWORD });
    await expect(run(["crypto:rotate-dek", "--tenant", id])).rejects.toThrow("active tenant");
    await expect(worker.runJob(tenantDekRotateJob, { rotationId: newId() }, id)).rejects.toThrow("active tenant");
  });
});

describe("failed jobs on an isolated real Redis queue", () => {
  it("lists metadata only, previews and retries without deleting jobs or resetting unrelated queues", async () => {
    const queue = queues.get("webhook");
    const consumer = new Worker("webhook", async () => {}, {
      connection: h.redis,
      prefix: queues.prefix,
      autorun: false,
    });
    try {
      const id = `ops-test|${newId()}`;
      await queue.add(
        "webhook.process",
        { inboxId: newId(), tenantId: newId(), secret: "PRIVATE BUYER" },
        { jobId: id, attempts: 1 },
      );
      const job = await consumer.getNextJob("ops-test", { block: false });
      expect(job?.id).toBe(id);
      await job!.moveToFailed(new Error("PRIVATE BUYER"), "ops-test", false);
      const list = await run(["jobs:dlq", "--queue", "webhook"]);
      expect(JSON.stringify(list)).not.toContain("PRIVATE BUYER");
      expect(list).toMatchObject({ total: 1, jobs: [{ id, name: "webhook.process" }] });
      expect(await run(["jobs:retry", "--queue", "webhook", "--id", id, "--dry-run"])).toMatchObject({ retried: 1 });
      expect(await job!.getState()).toBe("failed");
      expect(await run(["jobs:retry", "--queue", "webhook", "--id", id])).toMatchObject({ retried: 1 });
      expect(await job!.getState()).toBe("waiting");
      await expect(run(["jobs:retry", "--queue", "webhook", "--id", id])).rejects.toThrow("not failed");
      await queue.remove(id);
      await queue.add("unregistered.job", { secret: "PRIVATE BUYER" }, { jobId: id, attempts: 1 });
      const invalid = await consumer.getNextJob("ops-test", { block: false });
      await invalid!.moveToFailed(new Error("PRIVATE BUYER"), "ops-test", false);
      expect(await run(["jobs:retry", "--queue", "webhook", "--all"])).toMatchObject({ retried: 0, skipped: 1 });
      expect(await invalid!.getState()).toBe("failed");
      await expect(run(["jobs:retry", "--queue", "webhook", "--id", id])).rejects.toThrow("unregistered");
      await queue.remove(id);
    } finally {
      await consumer.close();
    }
  });
});

describe("pnpm operational CLI smoke", () => {
  it("runs the real entry point, closes its pools, and rejects unsafe roles and production mutations before acting", async () => {
    const a = await signup(api);
    const call = promisify(execFile);
    const childEnv = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL_WORKER: h.infra.urls.worker,
      DATABASE_URL_SYSTEM: h.infra.urls.system,
      REDIS_QUEUE_URL: h.infra.redisUrl,
    };
    const cli = (name: string, args: string[], overrides = {}) =>
      call("pnpm", ["--silent", name, ...args], {
        cwd: process.cwd(),
        env: { ...childEnv, ...overrides },
        timeout: 20_000,
      });
    const rotate = await cli("ops:crypto:rotate-dek", ["--tenant", a.me.tenant.id]);
    expect(JSON.parse(rotate.stdout)).toMatchObject({ command: "crypto:rotate-dek", dryRun: false, selected: 1 });
    expect((await rows(a.me.tenant.id))[0]?.jobName).toBe("tenant.dek_rotate");
    const preview = await cli("ops:partition:maintain", ["--dry-run"]);
    expect(JSON.parse(preview.stdout)).toMatchObject({ dryRun: true, selected: 1 });
    const maintained = await cli("ops:partition:maintain", []);
    expect(JSON.parse(maintained.stdout)).toHaveProperty("created");
    // This Redis instance belongs to this test session; its default prefix has no consumers or data.
    const failed = await cli("jobs:dlq", ["--queue", "notify"]);
    expect(JSON.parse(failed.stdout)).toMatchObject({ total: 0, jobs: [] });
    await expect(cli("ops:partition:maintain", [], { NODE_ENV: "production", OPS_CONFIRM: "0" })).rejects.toMatchObject(
      { stderr: expect.stringContaining("OPS_CONFIRM=1") },
    );
    const wrongRole = cli("ops:crypto:rotate-dek", ["--tenant", a.me.tenant.id], {
      DATABASE_URL_WORKER: h.infra.urls.system,
    });
    await expect(wrongRole).rejects.toMatchObject({ stderr: expect.stringContaining("Operation failed") });
    await expect(wrongRole).rejects.not.toMatchObject({ stderr: expect.stringContaining(h.infra.urls.system) });
  });
});
