import { bootstrapDatabase } from "./bootstrap";

/**
 * `pnpm db:bootstrap`: local setup only. Creates roles and the database from DATABASE_ADMIN_URL.
 * Role passwords are taken from the role URLs in the environment, so .env.local stays the single place.
 */
function passwordOf(url: string | undefined, name: string): string {
  if (!url) throw new Error(`${name} is required`);
  const password = decodeURIComponent(new URL(url).password);
  if (!password) throw new Error(`${name} has no password`);
  return password;
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error("DATABASE_ADMIN_URL is required (a superuser connection to the postgres database)");
  const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
  const database = new URL(migratorUrl ?? "postgres://x@localhost/omniseller").pathname.slice(1);
  await bootstrapDatabase({
    adminUrl,
    database,
    passwords: {
      migrator: passwordOf(migratorUrl, "DATABASE_MIGRATOR_URL"),
      api: passwordOf(process.env.DATABASE_URL, "DATABASE_URL"),
      worker: passwordOf(process.env.DATABASE_URL_WORKER, "DATABASE_URL_WORKER"),
      system: passwordOf(process.env.DATABASE_URL_SYSTEM, "DATABASE_URL_SYSTEM"),
    },
  });
  console.log(`database ${database} and roles are ready`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
