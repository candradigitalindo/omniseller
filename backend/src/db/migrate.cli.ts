import { migrate } from "./migrate";

/** `pnpm db:migrate`: needs DATABASE_MIGRATOR_URL (omniseller_migrator). */
async function main(): Promise<void> {
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) throw new Error("DATABASE_MIGRATOR_URL is required");
  const result = await migrate(url, { log: (m) => console.log(m) });
  console.log(
    `done: ${result.applied.length} migration(s) applied, ${result.repeatables.length} repeatable file(s), ${result.partitionsCreated} partition(s) created`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
