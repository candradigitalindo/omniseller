import { randomInt } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { newId } from "@omniseller/shared";
import { sql } from "drizzle-orm";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { systemContext } from "../../src/common/context/request-context";
import { ConfigModule } from "../../src/config/config.module";
import { parseEnv } from "../../src/config/env.schema";
import type { DbHandle } from "../../src/db/client";
import { InfraModule } from "../../src/infra/infra.module";
import { JOB_DEFINITIONS, JobRegistry } from "../../src/jobs/registry";
import { AuthModule } from "../../src/modules/auth/auth.module";
import { IdentityModule } from "../../src/modules/identity/identity.module";
import { EMAIL_SENDER, type MemoryEmailSender } from "../../src/modules/notification/email";
import { NotificationModule } from "../../src/modules/notification/notification.module";
import type { TestInfra } from "./global-setup";

export const WEB_URL = "http://localhost:3100";

/** The api process as a Nest app (backend doc 8.1 pipeline, guards, filters), for supertest. */
export async function startApi(infra: TestInfra): Promise<INestApplication> {
  const env = parseEnv({
    APP_ROLE: "api",
    NODE_ENV: "test",
    DATABASE_URL: infra.urls.api,
    REDIS_QUEUE_URL: infra.redisUrl,
    REDIS_CACHE_URL: infra.redisUrl,
    PUBLIC_WEB_URL: WEB_URL,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forEnv(env)] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

/**
 * The services a worker has, without starting BullMQ consumers. `runOutbox` executes the jobs a
 * tenant's outbox rows point to, directly and in order (backend doc 13.3: no sleeps; relay and
 * handlers are called explicitly).
 */
export async function startWorker(infra: TestInfra, system: DbHandle) {
  const env = parseEnv({
    APP_ROLE: "worker",
    NODE_ENV: "test",
    DATABASE_URL_WORKER: infra.urls.worker,
    REDIS_QUEUE_URL: infra.redisUrl,
    REDIS_CACHE_URL: infra.redisUrl,
    PUBLIC_WEB_URL: WEB_URL,
    EMAIL_TRANSPORT: "memory",
  });
  if (env.APP_ROLE !== "worker") throw new Error("unreachable");
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forEnv(env),
      InfraModule.forEnv(env),
      NotificationModule.forWorker(env),
      IdentityModule,
      AuthModule,
    ],
  }).compile();
  const ctx = await moduleRef.init();
  const registry = new JobRegistry(JOB_DEFINITIONS);
  const deps = { resolve: <T>(token: abstract new (...args: never[]) => T) => ctx.get(token, { strict: false }) };
  const email = ctx.get<MemoryEmailSender>(EMAIL_SENDER);

  async function runOutbox(tenantId: string): Promise<string[]> {
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
      await def.handler({ ...payload, tenantId } as never, {
        ctx: systemContext(tenantId, { requestId: newId() }),
        jobId: row.job_id,
        attemptsMade: 0,
        deps,
      });
      await system.db.execute(sql`UPDATE outbox_event SET published_at = now() WHERE id = ${row.id}`);
      ran.push(row.job_name);
    }
    return ran;
  }

  return { ctx, email, runOutbox, close: () => ctx.close() };
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
