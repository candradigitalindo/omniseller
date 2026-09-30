import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, inject } from "vitest";
import { createDb, type DbHandle } from "../../src/db/client";

/**
 * Connections for one test file, closed automatically after the file.
 * api/worker/system are the application roles; `raw` opens a bare client for a given role, used to
 * probe privileges outside withTenantTx.
 */
export function testHandles() {
  const infra = inject("infra");
  const api = createDb("api", infra.urls.api, { max: 5 });
  const worker = createDb("worker", infra.urls.worker, { max: 5 });
  const system = createDb("system", infra.urls.system, { max: 2 });
  const redis = new Redis(infra.redisUrl, { maxRetriesPerRequest: null });
  const clients: pg.Client[] = [];

  async function raw(role: "api" | "worker" | "system" | "migrator"): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: infra.urls[role] });
    await client.connect();
    clients.push(client);
    return client;
  }

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
    await Promise.all([api, worker, system].map((h: DbHandle) => h.close()));
    redis.disconnect();
  });

  return { infra, api, worker, system, redis, raw };
}
