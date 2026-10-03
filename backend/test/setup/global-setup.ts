import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import type { TestProject } from "vitest/node";
import { bootstrapDatabase, dropDatabase } from "../../src/db/bootstrap";
import { migrate } from "../../src/db/migrate";
import { testFilesDir } from "./files-dir";

/**
 * Integration test infrastructure (backend doc 13.2).
 *
 * PostgreSQL: TEST_PG_ADMIN_URL (a superuser URL to the `postgres` database) when set, otherwise a
 * Testcontainers postgres:17 container. Redis: TEST_REDIS_URL, otherwise a redis:7.2 container.
 * Each run gets a fresh database, migrated as omniseller_migrator; tests connect with the application
 * roles (never a superuser), so RLS and grants are exercised exactly as in production.
 */

export interface TestInfra {
  urls: { migrator: string; api: string; worker: string; system: string; admin: string };
  database: string;
  redisUrl: string;
  keyPrefix: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    infra: TestInfra;
  }
}

// Well-known local passwords; the same values as .env.example.
const PASSWORDS = {
  migrator: "omniseller_migrator",
  api: "omniseller_api",
  worker: "omniseller_worker",
  system: "omniseller_system",
};

function withCredentials(adminUrl: string, database: string, user: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const stops: (() => Promise<unknown>)[] = [];

  let adminUrl = process.env.TEST_PG_ADMIN_URL;
  if (!adminUrl) {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const pgc = await new PostgreSqlContainer("postgres:17").withUsername("postgres").withPassword("postgres").start();
    stops.push(() => pgc.stop());
    adminUrl = `postgres://postgres:postgres@${pgc.getHost()}:${pgc.getPort()}/postgres`;
  }

  let redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) {
    const { RedisContainer } = await import("@testcontainers/redis");
    const rc = await new RedisContainer("redis:7.2").start();
    stops.push(() => rc.stop());
    redisUrl = rc.getConnectionUrl();
  }

  const runId = `${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const database = `omniseller_test_${runId}`;
  await bootstrapDatabase({ adminUrl, database, passwords: PASSWORDS });

  const urls = {
    admin: adminUrl,
    migrator: withCredentials(adminUrl, database, "omniseller_migrator", PASSWORDS.migrator),
    api: withCredentials(adminUrl, database, "omniseller_api", PASSWORDS.api),
    worker: withCredentials(adminUrl, database, "omniseller_worker", PASSWORDS.worker),
    system: withCredentials(adminUrl, database, "omniseller_system", PASSWORDS.system),
  };
  await migrate(urls.migrator);

  project.provide("infra", { urls, database, redisUrl, keyPrefix: `test_${runId}` });

  return async () => {
    if (!process.env.KEEP_TEST_DB) {
      await dropDatabase(adminUrl, database);
      await rm(testFilesDir(`test_${runId}`), { recursive: true, force: true });
    }
    for (const stop of stops.reverse()) await stop();
  };
}
