import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";

/**
 * Migration runner (ADR-027, backend doc 12).
 *
 * 1. Versioned files `drizzle/migrations/NNNN_name.sql` run once each, in order, one transaction per
 *    file, recorded with a checksum in schema_migration. Editing an applied file is refused.
 * 2. Repeatable files `drizzle/sql/*.sql` (functions, triggers, policies, grants, seeds) run on every
 *    migrate, in file-name order, together in one transaction. They must be idempotent.
 * 3. maintain_partitions() creates the monthly partitions ahead.
 *
 * Runs as omniseller_migrator (schema owner, BYPASSRLS). A session advisory lock prevents two
 * deploys from migrating at the same time.
 */

export const DRIZZLE_DIR = resolve(__dirname, "../../drizzle");
const LOCK_KEY = 727_431_001; // arbitrary, constant across releases

export interface MigrateResult {
  applied: string[];
  repeatables: string[];
  partitionsCreated: number;
}

export interface MigrateOptions {
  dir?: string;
  log?: (msg: string) => void;
}

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function sqlFiles(dir: string): Promise<{ name: string; content: string }[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  return Promise.all(names.map(async (name) => ({ name, content: await readFile(join(dir, name), "utf8") })));
}

export async function migrate(migratorUrl: string, options: MigrateOptions = {}): Promise<MigrateResult> {
  const dir = options.dir ?? DRIZZLE_DIR;
  const log = options.log ?? (() => {});
  const client = new pg.Client({ connectionString: migratorUrl, application_name: "omniseller-migrate" });
  await client.connect();
  const result: MigrateResult = { applied: [], repeatables: [], partitionsCreated: 0 };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const applied = new Map<string, string>();
    for (const row of (
      await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migration")
    ).rows) {
      applied.set(row.name, row.checksum);
    }

    for (const file of await sqlFiles(join(dir, "migrations"))) {
      if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(file.name)) {
        throw new Error(`migration file name must look like 0001_name.sql: ${file.name}`);
      }
      const sum = checksum(file.content);
      const previous = applied.get(file.name);
      if (previous) {
        if (previous !== sum) {
          throw new Error(`migration ${file.name} was changed after it was applied; write a new migration instead`);
        }
        continue;
      }
      log(`applying ${file.name}`);
      await client.query("BEGIN");
      try {
        await client.query(file.content);
        await client.query("INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)", [file.name, sum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file.name} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(file.name);
    }

    const repeatables = await sqlFiles(join(dir, "sql"));
    await client.query("BEGIN");
    try {
      for (const file of repeatables) {
        log(`running ${file.name}`);
        try {
          await client.query(file.content);
        } catch (err) {
          throw new Error(`repeatable ${file.name} failed: ${(err as Error).message}`, { cause: err });
        }
        result.repeatables.push(file.name);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    const partitions = await client.query<{ n: number }>("SELECT maintain_partitions(now()) AS n");
    result.partitionsCreated = Number(partitions.rows[0]?.n ?? 0);
    log(`partitions created: ${result.partitionsCreated}`);
    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}
