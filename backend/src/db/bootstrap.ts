import pg from "pg";

/**
 * Creates the four database roles and the database (backend doc 7.5). Needs an admin connection
 * (superuser locally, rds_superuser-equivalent in AWS where Terraform does the same thing).
 * Idempotent: existing roles and databases are left as they are, only their settings are refreshed.
 */

export interface RolePasswords {
  migrator: string;
  api: string;
  worker: string;
  system: string;
}

export interface BootstrapOptions {
  adminUrl: string;
  database: string;
  passwords: RolePasswords;
}

const ROLES = [
  { key: "migrator", name: "omniseller_migrator", attrs: "LOGIN BYPASSRLS" },
  { key: "api", name: "omniseller_api", attrs: "LOGIN NOBYPASSRLS" },
  { key: "worker", name: "omniseller_worker", attrs: "LOGIN NOBYPASSRLS" },
  { key: "system", name: "omniseller_system", attrs: "LOGIN BYPASSRLS" },
] as const;

export async function bootstrapDatabase(options: BootstrapOptions): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.database)) {
    throw new Error(`invalid database name: ${options.database}`);
  }
  const admin = new pg.Client({ connectionString: options.adminUrl, application_name: "omniseller-bootstrap" });
  await admin.connect();
  try {
    for (const role of ROLES) {
      const password = options.passwords[role.key];
      const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role.name]);
      const pw = admin.escapeLiteral(password);
      if (exists.rowCount === 0) {
        await admin.query(`CREATE ROLE ${role.name} ${role.attrs} PASSWORD ${pw}`);
      } else {
        await admin.query(`ALTER ROLE ${role.name} ${role.attrs} PASSWORD ${pw}`);
      }
    }
    // Backend doc 8.3: short statements and no idle transactions for the application roles.
    for (const name of ["omniseller_api", "omniseller_worker"]) {
      await admin.query(`ALTER ROLE ${name} SET statement_timeout = '5s'`);
      await admin.query(`ALTER ROLE ${name} SET idle_in_transaction_session_timeout = '10s'`);
    }
    await admin.query(`ALTER ROLE omniseller_system SET statement_timeout = '60s'`);

    const db = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [options.database]);
    if (db.rowCount === 0) {
      await admin.query(
        `CREATE DATABASE ${options.database} OWNER omniseller_migrator ENCODING 'UTF8' TEMPLATE template0`,
      );
    }
    await admin.query(`REVOKE ALL ON DATABASE ${options.database} FROM PUBLIC`);
    await admin.query(
      `GRANT CONNECT ON DATABASE ${options.database} TO omniseller_api, omniseller_worker, omniseller_system`,
    );
  } finally {
    await admin.end();
  }
}

export async function dropDatabase(adminUrl: string, database: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
