import { Redis } from "ioredis";
import { createDb, type DbHandle } from "../db/client";
import { QueueRegistry } from "../jobs/queues";
import { executeOps, type OpsResources } from "./execute";
import { COMMANDS, guardOps, type OpsCommand, parseOpsCommand } from "./ops-plan";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.includes("--help")) {
    process.stdout.write(
      `Operational commands: ${COMMANDS.join(", ")}\nTenant commands require --tenant <ULID>.\nwebhook:replay: --id <ULID> or --source shopee|tiktokshop --since <ISO time>; --force replays processed notifications.\nstock:push: --variant <ULID> --warehouse <ULID>.\njobs:dlq: --queue <name>; jobs:retry: --queue <name> --id <jobId> or --all.\n--limit 1..1000 (default 100) bounds webhook batches and job lists/retries.\n--dry-run previews without changes; production mutations require OPS_CONFIRM=1.\n`,
    );
    return;
  }
  let command: OpsCommand;
  try {
    command = parseOpsCommand(args);
    guardOps(command, process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "invalid options"}\n`);
    process.exitCode = 1;
    return;
  }
  const resources: OpsResources = {};
  let db: DbHandle | undefined;
  let redis: Redis | undefined;
  let queues: QueueRegistry | undefined;
  try {
    if (command.name.startsWith("jobs:")) {
      if (!process.env.REDIS_QUEUE_URL) throw new Error("missing Redis configuration");
      redis = new Redis(process.env.REDIS_QUEUE_URL, {
        lazyConnect: true,
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      redis.on("error", () => {});
      await redis.connect();
      queues = new QueueRegistry(redis);
      resources.queues = queues;
    } else {
      const role = command.name === "partition:maintain" ? "system" : "worker";
      const url = role === "system" ? process.env.DATABASE_URL_SYSTEM : process.env.DATABASE_URL_WORKER;
      if (!url) throw new Error("missing database configuration");
      db = createDb(role, url, { max: 1, applicationName: "omniseller-ops" });
      const result = await db.pool.query<{ role: string }>("SELECT current_user AS role");
      if (result.rows[0]?.role !== `omniseller_${role}`) throw new Error("incorrect database role");
      if (role === "system") resources.system = db;
      else resources.worker = db;
    }
    const result = await executeOps(command, resources, process.env);
    process.stdout.write(`${JSON.stringify({ command: command.name, dryRun: command.dryRun, ...result })}\n`);
  } catch {
    // Database and Redis errors may contain credentials or stored payloads. Never print raw errors.
    process.stderr.write(
      "Operation failed: verify eligibility, database role, and database/Redis access. See src/ops/README.md.\n",
    );
    process.exitCode = 1;
  } finally {
    await queues?.close();
    redis?.disconnect();
    await db?.close();
  }
}

main().catch(() => {
  process.stderr.write("Operational command failed.\n");
  process.exitCode = 1;
});
