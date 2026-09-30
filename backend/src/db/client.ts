import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Database role a connection pool logs in as (backend doc 7.5). */
export type DbRole = "api" | "worker" | "system";

export interface DbHandle {
  readonly role: DbRole;
  readonly db: Db;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

let parsersInstalled = false;

/**
 * int8 arrives as a string from pg. Money and quantities are int8, so parse to number and refuse
 * anything outside the safe integer range instead of silently losing precision.
 */
function installTypeParsers(): void {
  if (parsersInstalled) return;
  pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw new RangeError(`int8 out of safe range: ${value}`);
    return n;
  });
  parsersInstalled = true;
}

export interface CreateDbOptions {
  max?: number;
  applicationName?: string;
}

export function createDb(role: DbRole, url: string, options: CreateDbOptions = {}): DbHandle {
  installTypeParsers();
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    application_name: options.applicationName ?? `omniseller-${role}`,
  });
  const db = drizzle(pool, { schema });
  return {
    role,
    db,
    pool,
    close: () => pool.end(),
  };
}
