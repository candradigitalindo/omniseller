import { randomInt } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { configureApiApp } from "../../src/common/http/api-app";
import { ConfigModule } from "../../src/config/config.module";
import { parseEnv } from "../../src/config/env.schema";
import type { DbHandle } from "../../src/db/client";
import { InfraModule } from "../../src/infra/infra.module";
import { STOCK_DIRTY } from "../../src/infra/tokens";
import type { JobDef } from "../../src/jobs/define";
import { jobContext } from "../../src/jobs/job-context";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import type { StockDirtySet } from "../../src/jobs/stock-dirty";
import { AffiliateWorkerModule } from "../../src/modules/affiliate/affiliate.module";
import { AffiliateAccountsWorkerModule } from "../../src/modules/affiliate-accounts/accounts.module";
import { AuthModule } from "../../src/modules/auth/auth.module";
import { AutomationModule } from "../../src/modules/automation/automation.module";
import { BillingModule, BillingWorkerModule } from "../../src/modules/billing/billing.module";
import { CatalogModule, CatalogWorkerModule } from "../../src/modules/catalog/catalog.module";
import { ChannelModule, ChannelWorkerModule, ConnectorsModule } from "../../src/modules/channel/channel.module";
import { ClosureModule } from "../../src/modules/closure/closure.module";
import { ExportsWorkerModule } from "../../src/modules/exports/exports.module";
import { FilesModule } from "../../src/modules/files/files.module";
import { FulfillmentModule, FulfillmentWorkerModule } from "../../src/modules/fulfillment/fulfillment.module";
import { IdentityModule } from "../../src/modules/identity/identity.module";
import {
  InventoryModule,
  InventoryStockModule,
  InventoryWorkerModule,
} from "../../src/modules/inventory/inventory.module";
import { ListingCopyModule, ListingCopyWorkerModule } from "../../src/modules/listing-copy/listing-copy.module";
import { MigrationWorkerModule } from "../../src/modules/migration/migration.module";
import { EMAIL_SENDER, type MemoryEmailSender } from "../../src/modules/notification/email";
import { NotificationModule, NotificationWorkerModule } from "../../src/modules/notification/notification.module";
import { OrdersModule, OrdersWorkerModule } from "../../src/modules/orders/orders.module";
import { ReportingWorkerModule } from "../../src/modules/reporting/reporting.module";
import { RetentionWorkerModule } from "../../src/modules/retention/retention.module";
import { ReturnsModule, ReturnsWorkerModule } from "../../src/modules/returns/returns.module";
import { SyncModule } from "../../src/modules/sync/sync.module";
import { STOCK_PUSH_BATCH } from "../../src/scheduler/stock-flush";
import { configureWebhookApp } from "../../src/webhook/webhook-app";
import { testFilesDir } from "./files-dir";
import type { TestInfra } from "./global-setup";
import { type MockMarketplace, SHOPEE, TIKTOK } from "./mock-marketplace";
import { type MockXendit, XENDIT_TEST_KEY, XENDIT_TEST_TOKEN } from "./mock-xendit";

export const WEB_URL = "http://localhost:3100";
export const WEBHOOK_URL = "https://hooks.omniseller.test";
/** Development-only master key for the local token key provider (test/local only). */
export const TEST_TOKEN_KEY = Buffer.alloc(32, 42).toString("base64");
/** The api's key for TOTP secrets and backup codes (backend doc 8.30). */
export const TEST_TOTP_KEY = Buffer.alloc(32, 43).toString("base64");

/**
 * Listens on 127.0.0.1 before supertest sees the server. Left to supertest, the server binds `::` on a
 * random port, and on macOS another program may hold the same port on 127.0.0.1 (editor helpers do),
 * so supertest's request to 127.0.0.1 would reach that program instead.
 */
export async function listenOnLoopback(app: INestApplication): Promise<void> {
  await app.listen(0, "127.0.0.1");
}

/** Marketplace settings pointing every connector at the fake marketplace (none when it is absent). */
function marketplaceEnv(mock: MockMarketplace | undefined, role: "api" | "webhook" | "worker"): Record<string, string> {
  if (!mock) return {};
  const ids = { SHOPEE_PARTNER_ID: String(SHOPEE.partnerId) };
  const links = {
    ...ids,
    SHOPEE_AUTH_BASE_URL: mock.url,
    TIKTOKSHOP_SERVICE_ID: TIKTOK.serviceId,
    TIKTOKSHOP_APP_KEY: TIKTOK.appKey,
    TIKTOKSHOP_CREATOR_AUTHORIZE_URL: `${mock.url}/alliance/creator/auth`,
    TIKTOKSHOP_PARTNER_AUTHORIZE_URL: `${mock.url}/partner/open/authorize`,
    TIKTOKSHOP_AUTHORIZE_URL: `${mock.url}/open/authorize`,
  };
  const secrets = {
    SHOPEE_PARTNER_KEY: SHOPEE.partnerKey,
    TIKTOKSHOP_APP_KEY: TIKTOK.appKey,
    TIKTOKSHOP_APP_SECRET: TIKTOK.appSecret,
  };
  if (role === "api") return links;
  if (role === "webhook") return { ...ids, ...secrets };
  return {
    ...links,
    ...secrets,
    SHOPEE_API_BASE_URL: mock.url,
    TIKTOKSHOP_API_BASE_URL: mock.url,
    TIKTOKSHOP_AUTH_BASE_URL: mock.url,
    // product creation (FR-PRD-13): no 5-second wait, images from the fake marketplace's host
    SHOPEE_VARIANT_DELAY_MS: "0",
    PRODUCT_IMAGE_HOSTS: "127.0.0.1",
  };
}

/** The api process as a Nest app (backend doc 8.1 pipeline, guards, filters), for supertest. */
export async function startApi(
  infra: TestInfra,
  opts: { marketplace?: MockMarketplace; xendit?: MockXendit | boolean } = {},
): Promise<INestApplication> {
  const env = parseEnv({
    APP_ROLE: "api",
    NODE_ENV: "test",
    DATABASE_URL: infra.urls.api,
    REDIS_QUEUE_URL: infra.redisUrl,
    REDIS_CACHE_URL: infra.redisUrl,
    PUBLIC_WEB_URL: WEB_URL,
    FILE_STORAGE: "local",
    FILE_STORAGE_LOCAL_DIR: testFilesDir(infra.keyPrefix),
    TOTP_ENCRYPTION_KEY: TEST_TOTP_KEY,
    // paid plans can be chosen (the api itself never calls Xendit)
    ...(opts.xendit ? { BILLING_PAYMENTS: "xendit" } : {}),
    // who issues invoices, as their PDF prints it (backend doc 8.32)
    BILLING_ISSUER_NAME: "PT Uji Niaga Digital",
    BILLING_ISSUER_NPWP: "01.234.567.8-901.000",
    ...marketplaceEnv(opts.marketplace, "api"),
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forEnv(env, { queuePrefix: infra.keyPrefix })],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApiApp(app);
  await listenOnLoopback(app);
  return app;
}

/**
 * The services a worker has, without starting BullMQ consumers. `runOutbox` executes the jobs a
 * tenant's outbox rows point to, directly and in order (backend doc 13.3: no sleeps; relay and
 * handlers are called explicitly).
 */
export async function startWorker(
  infra: TestInfra,
  system: DbHandle,
  opts: { marketplace?: MockMarketplace; xendit?: MockXendit } = {},
) {
  const env = parseEnv({
    APP_ROLE: "worker",
    NODE_ENV: "test",
    DATABASE_URL_WORKER: infra.urls.worker,
    REDIS_QUEUE_URL: infra.redisUrl,
    REDIS_CACHE_URL: infra.redisUrl,
    PUBLIC_WEB_URL: WEB_URL,
    PUBLIC_WEBHOOK_URL: WEBHOOK_URL,
    EMAIL_TRANSPORT: "memory",
    TOKEN_KEY_PROVIDER: "local",
    TOKEN_LOCAL_MASTER_KEY: TEST_TOKEN_KEY,
    FILE_STORAGE: "local",
    FILE_STORAGE_LOCAL_DIR: testFilesDir(infra.keyPrefix),
    ...(opts.xendit ? { XENDIT_SECRET_KEY: XENDIT_TEST_KEY, XENDIT_API_BASE_URL: opts.xendit.url } : {}),
    // the issuer of the invoice PDF attached to "payment received" emails, as the api prints it
    BILLING_ISSUER_NAME: "PT Uji Niaga Digital",
    BILLING_ISSUER_NPWP: "01.234.567.8-901.000",
    ...marketplaceEnv(opts.marketplace, "worker"),
  });
  if (env.APP_ROLE !== "worker") throw new Error("unreachable");
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forEnv(env),
      InfraModule.forEnv(env, { queuePrefix: infra.keyPrefix }),
      ConnectorsModule.forEnv(env),
      NotificationModule.forWorker(env),
      NotificationWorkerModule,
      IdentityModule,
      AuthModule,
      InventoryModule,
      SyncModule,
      ChannelModule,
      ChannelWorkerModule.forEnv(env),
      CatalogModule,
      CatalogWorkerModule,
      AffiliateWorkerModule,
      AffiliateAccountsWorkerModule,
      ListingCopyModule,
      ListingCopyWorkerModule,
      InventoryWorkerModule,
      InventoryStockModule,
      OrdersModule,
      OrdersWorkerModule,
      FilesModule.forEnv(env),
      FulfillmentModule,
      FulfillmentWorkerModule,
      AutomationModule,
      ReturnsModule,
      ReturnsWorkerModule,
      ExportsWorkerModule,
      MigrationWorkerModule,
      ReportingWorkerModule,
      RetentionWorkerModule,
      ClosureModule,
      BillingModule,
      BillingWorkerModule,
    ],
  }).compile();
  const ctx = await moduleRef.init();
  const registry = new JobRegistry(JOB_DEFINITIONS);
  const deps = { resolve: <T>(token: abstract new (...args: never[]) => T) => ctx.get(token, { strict: false }) };
  const email = ctx.get<MemoryEmailSender>(EMAIL_SENDER);

  /**
   * `failures`: collect handler errors and go on, as BullMQ would retry those jobs later (tests run the
   * job again themselves); without it the first error is thrown.
   */
  async function runOutbox(
    tenantId: string,
    opts: { failures?: { job: string; error: unknown }[] } = {},
  ): Promise<string[]> {
    const rows = await system.db.execute<{
      id: string;
      queue: string;
      job_name: string;
      job_id: string;
      payload: Record<string, unknown>;
    }>(
      sql`SELECT id, queue, job_name, job_id, payload FROM outbox_event
           WHERE tenant_id = ${tenantId} AND published_at IS NULL ORDER BY id`,
    );
    const ran: string[] = [];
    for (const row of rows.rows) {
      const def = registry.get(row.queue, row.job_name);
      if (!def) continue;
      const payload = def.schema.parse(row.payload) as object;
      try {
        await def.handler({ ...payload, tenantId } as never, {
          ctx: jobContext(def, tenantId, newId(), row.payload),
          jobId: row.job_id,
          attemptsMade: 0,
          deps,
        });
      } catch (error) {
        if (!opts.failures) throw error;
        opts.failures.push({ job: row.job_name, error });
      }
      await system.db.execute(sql`UPDATE outbox_event SET published_at = now() WHERE id = ${row.id}`);
      ran.push(row.job_name);
    }
    return ran;
  }

  /** Runs one job handler directly, as the worker would for a job of this tenant. */
  async function runJob(def: JobDef, payload: object, tenantId: string, attemptsMade = 0): Promise<void> {
    const parsed = def.schema.parse({ ...payload, tenantId }) as object;
    await def.handler({ ...parsed, tenantId } as never, {
      ctx: jobContext(def, tenantId, newId(), payload),
      jobId: `test|${newId()}`,
      attemptsMade,
      deps,
    });
  }

  /**
   * The scheduler's stock.dirty_flush followed by the stock.push jobs it would enqueue, run in place and
   * without the quiet period. Only this tenant's keys are taken. Returns the jobs' errors (a temporary
   * marketplace failure makes stock.push throw so BullMQ retries).
   */
  async function flushStock(tenantId: string): Promise<{ jobs: number; errors: unknown[] }> {
    const dirty = ctx.get<StockDirtySet>(STOCK_DIRTY);
    const def = registry.get("stock.push", "stock.push")!;
    const ready = (await dirty.ready(Date.now() + 1, 0, 10_000)).filter((k) => k.tenantId === tenantId);
    const batches: { variantId: string; warehouseId: string; score: string }[][] = [];
    for (let i = 0; i < ready.length; i += STOCK_PUSH_BATCH) {
      batches.push(
        ready
          .slice(i, i + STOCK_PUSH_BATCH)
          .map((k) => ({ variantId: k.variantId, warehouseId: k.warehouseId, score: k.score })),
      );
    }
    // Same order as the scheduler: enqueue and acknowledge first, the jobs run afterwards.
    for (const k of ready) await dirty.ack(k);
    const errors: unknown[] = [];
    for (const marks of batches) {
      try {
        await runJob(def, { marks }, tenantId);
      } catch (err) {
        errors.push(err);
      }
    }
    return { jobs: batches.length, errors };
  }

  return { ctx, email, runOutbox, runJob, flushStock, close: () => ctx.close() };
}

/** The webhook process: raw bodies, signature checks, inbox, enqueue (technology doc 8.3). */
export async function startWebhook(infra: TestInfra, opts: { marketplace?: MockMarketplace; xendit?: boolean } = {}) {
  const env = parseEnv({
    APP_ROLE: "webhook",
    NODE_ENV: "test",
    DATABASE_URL: infra.urls.api,
    REDIS_QUEUE_URL: infra.redisUrl,
    REDIS_CACHE_URL: infra.redisUrl,
    PUBLIC_WEBHOOK_URL: WEBHOOK_URL,
    ...(opts.xendit ? { XENDIT_WEBHOOK_TOKEN: XENDIT_TEST_TOKEN } : {}),
    ...marketplaceEnv(opts.marketplace, "webhook"),
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forEnv(env, { queuePrefix: infra.keyPrefix })],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  configureWebhookApp(app);
  await listenOnLoopback(app);
  return app;
}

/** A fresh client IP per scenario keeps the per-IP rate limits of one scenario away from the others. */
export function fakeIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

/** supertest agent that keeps cookies, with a fixed client IP. */
export function client(app: INestApplication, ip = fakeIp()) {
  const agent = request.agent(app.getHttpServer());
  const withIp = <T extends { set(k: string, v: string): T }>(r: T) => r.set("CF-Connecting-IP", ip);
  return {
    ip,
    get: (url: string) => withIp(agent.get(url)),
    post: (url: string, body?: object) => withIp(agent.post(url)).send(body ?? {}),
    patch: (url: string, body?: object) => withIp(agent.patch(url)).send(body ?? {}),
    put: (url: string, body?: object) => withIp(agent.put(url)).send(body ?? {}),
    delete: (url: string) => withIp(agent.delete(url)),
  };
}
export type Client = ReturnType<typeof client>;

export function uniqueEmail(prefix = "user"): string {
  return `${prefix}.${newId().slice(-8).toLowerCase()}@contoh.id`;
}

export const PASSWORD = "kata-sandi-kuat-123";

/** Signs up a new business through the API and returns a signed-in client for its Owner. */
export async function signup(
  app: INestApplication,
  overrides: { email?: string; businessName?: string; password?: string } = {},
) {
  const c = client(app);
  const email = overrides.email ?? uniqueEmail("owner");
  const res = await c.post("/v1/auth/signup", {
    businessName: overrides.businessName ?? "Toko Uji Coba",
    name: "Rina",
    email,
    password: overrides.password ?? PASSWORD,
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { c, email, me: res.body as MeBody };
}

export interface MeBody {
  user: { id: string; name: string; email: string };
  tenant: { id: string; slug: string; name: string };
  plan: { code: string; name: string; features: string[] };
  permissions: string[];
  roles: { id: string; name: string }[];
  storeScope: string[] | null;
  warehouseScope: string[] | null;
}

export function tokenFrom(text: string): string {
  const m = /token=([A-Za-z0-9_-]{43})/.exec(text);
  if (!m) throw new Error(`no token in: ${text}`);
  return m[1]!;
}
